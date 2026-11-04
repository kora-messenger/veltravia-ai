import type { FastifyInstance, FastifyReply } from 'fastify';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import {
  buildHistory,
  decideAutomaticCheckpoint,
  isVersionError,
  type Branch,
  type BranchManager,
  type VersionControlManager,
} from '@veltravia/version-core';

/**
 * Branch, history and selective-restore routes (Step 38).
 *
 * Every route takes the project from the path and looks the branch up INSIDE
 * that project, so a branch id from another project is a plain 404: the caller
 * learns nothing about branches they do not own.
 */

const STATUS: Record<string, number> = {
  VERSION_INVALID_REQUEST: 400,
  VERSION_VALIDATION_FAILED: 400,
  VERSION_RESTORE_PATHS_INVALID: 400,
  VERSION_SECRET_REJECTED: 422,
  VERSION_PROJECT_NOT_FOUND: 404,
  VERSION_WORKSPACE_NOT_FOUND: 404,
  VERSION_REVISION_NOT_FOUND: 404,
  VERSION_CHECKPOINT_NOT_FOUND: 404,
  VERSION_BRANCH_NOT_FOUND: 404,
  VERSION_BRANCH_FOREIGN_PROJECT: 404,
  VERSION_REVISION_FOREIGN_PROJECT: 403,
  VERSION_REVISION_FOREIGN_WORKSPACE: 403,
  VERSION_BRANCH_NAME_TAKEN: 409,
  VERSION_BRANCH_ARCHIVED: 409,
  VERSION_BRANCH_NOT_DELETABLE: 409,
  VERSION_BRANCH_LIMIT: 422,
  VERSION_REVISION_CONFLICT: 409,
  VERSION_STALE_REVISION: 409,
  VERSION_INVALID_ROLLBACK_TARGET: 422,
  VERSION_CORRUPTED_SNAPSHOT: 500,
  VERSION_BRANCH_WORKSPACE_FAILED: 500,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isVersionError(error)) {
    return {
      status: STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  if (isProjectError(error)) {
    const status =
      error.code === 'PROJECT_NOT_FOUND' || error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

function toBranchView(branch: Branch, activeId: string | null): Record<string, unknown> {
  return {
    id: branch.id,
    name: branch.name,
    description: branch.description,
    state: branch.state,
    isDefault: branch.isDefault,
    isActive: branch.id === activeId,
    workspaceId: branch.workspaceId,
    baseRevisionId: branch.baseRevisionId,
    parentBranchId: branch.parentBranchId,
    createdAt: branch.createdAt,
    createdBy: branch.createdBy,
    updatedAt: branch.updatedAt,
    archivedAt: branch.archivedAt,
  };
}

export interface BranchRoutesOptions {
  readonly version: VersionControlManager;
  readonly branches: BranchManager;
  readonly projectEngine: ProjectEngine;
}

export function registerBranchRoutes(app: FastifyInstance, options: BranchRoutesOptions): void {
  const { version, branches, projectEngine } = options;

  async function requireProject(projectId: string, reply: FastifyReply): Promise<boolean> {
    try {
      await projectEngine.projects.getProject(projectId);
      return true;
    } catch (error) {
      const { status, body } = toHttpError(error);
      await reply.code(status).send(body);
      return false;
    }
  }

  /**
   * A project that predates branching has a workspace and a history but no
   * branch. The first read adopts its first workspace as the default branch, so
   * nothing is copied and nothing is lost.
   */
  async function ensureFirstBranch(projectId: string): Promise<void> {
    if ((await branches.listBranches(projectId, { includeArchived: true })).length > 0) return;
    const workspaces = await projectEngine.workspaces.listWorkspaces(projectId);
    const first = workspaces.find((w) => w.status === 'active') ?? workspaces[0];
    if (first === undefined) return;
    await branches.adoptWorkspace({ projectId, workspaceId: first.id });
  }

  const nameSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;
  const idSchema = { type: 'string', minLength: 1, maxLength: 128 } as const;

  app.get('/api/projects/:projectId/branches', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { includeArchived } = (request.query ?? {}) as { includeArchived?: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      await ensureFirstBranch(projectId);
      const list = await branches.listBranches(projectId, {
        includeArchived: includeArchived === 'true',
      });
      const active = await branches.getActiveBranch(projectId);
      return {
        branches: list.map((b) => toBranchView(b, active?.id ?? null)),
        activeBranchId: active?.id ?? null,
      };
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/projects/:projectId/branches',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: nameSchema,
            description: { type: 'string', maxLength: 500 },
            fromBranchId: idSchema,
            fromRevisionId: idSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await requireProject(projectId, reply))) return reply;
      const body = request.body as {
        name: string;
        description?: string;
        fromBranchId?: string;
        fromRevisionId?: string;
      };
      try {
        await ensureFirstBranch(projectId);
        const branch = await branches.createBranch({
          projectId,
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.fromBranchId !== undefined ? { fromBranchId: body.fromBranchId } : {}),
          ...(body.fromRevisionId !== undefined ? { fromRevisionId: body.fromRevisionId } : {}),
          createdBy: 'user',
        });
        const active = await branches.getActiveBranch(projectId);
        return reply.code(201).send({ branch: toBranchView(branch, active?.id ?? null) });
      } catch (error) {
        const { status, body: out } = toHttpError(error);
        return reply.code(status).send(out);
      }
    },
  );

  app.get('/api/projects/:projectId/branches/:branchId', async (request, reply) => {
    const { projectId, branchId } = request.params as { projectId: string; branchId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      const branch = await branches.getBranch(projectId, branchId);
      const active = await branches.getActiveBranch(projectId);
      const verdict = await branches.deletability(projectId, branchId);
      const latest = await version.getLatestRevision(projectId, branch.workspaceId);
      return {
        branch: toBranchView(branch, active?.id ?? null),
        deletable: verdict.deletable,
        deleteBlockedReason: verdict.reason,
        latestRevisionNumber: latest?.revisionNumber ?? null,
      };
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.patch(
    '/api/projects/:projectId/branches/:branchId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, description: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const { projectId, branchId } = request.params as { projectId: string; branchId: string };
      if (!(await requireProject(projectId, reply))) return reply;
      const body = request.body as { name?: string; description?: string };
      try {
        const current = await branches.getBranch(projectId, branchId);
        const branch = await branches.renameBranch(
          projectId,
          branchId,
          body.name ?? current.name,
          body.description,
        );
        const active = await branches.getActiveBranch(projectId);
        return { branch: toBranchView(branch, active?.id ?? null) };
      } catch (error) {
        const { status, body: out } = toHttpError(error);
        return reply.code(status).send(out);
      }
    },
  );

  app.post('/api/projects/:projectId/branches/:branchId/switch', async (request, reply) => {
    const { projectId, branchId } = request.params as { projectId: string; branchId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      await branches.switchBranch(projectId, branchId, 'user');
      const branch = await branches.getBranch(projectId, branchId);
      return { branch: toBranchView(branch, branch.id), activeBranchId: branch.id };
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/branches/:branchId/archive', async (request, reply) => {
    const { projectId, branchId } = request.params as { projectId: string; branchId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      const branch = await branches.archiveBranch(projectId, branchId);
      const active = await branches.getActiveBranch(projectId);
      return { branch: toBranchView(branch, active?.id ?? null) };
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/branches/:branchId/unarchive', async (request, reply) => {
    const { projectId, branchId } = request.params as { projectId: string; branchId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      const branch = await branches.unarchiveBranch(projectId, branchId);
      const active = await branches.getActiveBranch(projectId);
      return { branch: toBranchView(branch, active?.id ?? null) };
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.delete('/api/projects/:projectId/branches/:branchId', async (request, reply) => {
    const { projectId, branchId } = request.params as { projectId: string; branchId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      await branches.deleteBranch(projectId, branchId);
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  // ---- History: one branch's revisions, annotated ----------------------------
  app.get('/api/projects/:projectId/branches/:branchId/history', async (request, reply) => {
    const { projectId, branchId } = request.params as { projectId: string; branchId: string };
    const query = (request.query ?? {}) as { limit?: string; offset?: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      const branch = await branches.getBranch(projectId, branchId);
      const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
      const page = await version.listRevisions(projectId, branch.workspaceId, limit, offset);
      const checkpoints = await version.listCheckpoints(projectId, branch.workspaceId);
      const entries = buildHistory(branch, page.revisions, checkpoints);
      return {
        branch: { id: branch.id, name: branch.name },
        entries,
        total: page.total,
        hasMore: offset + page.revisions.length < page.total,
      };
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  // ---- Whether a change would earn an automatic checkpoint --------------------
  app.post(
    '/api/projects/:projectId/checkpoint-policy/evaluate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['filesAffected'],
          additionalProperties: false,
          properties: {
            filesAffected: { type: 'integer', minimum: 0, maximum: 100000 },
            filesDeleted: { type: 'integer', minimum: 0, maximum: 100000 },
            destructiveApproved: { type: 'boolean' },
            isRefactor: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await requireProject(projectId, reply))) return reply;
      const body = request.body as {
        filesAffected: number;
        filesDeleted?: number;
        destructiveApproved?: boolean;
        isRefactor?: boolean;
      };
      return {
        decision: decideAutomaticCheckpoint({
          filesAffected: body.filesAffected,
          filesDeleted: body.filesDeleted ?? 0,
          destructiveApproved: body.destructiveApproved ?? false,
          isRefactor: body.isRefactor ?? false,
        }),
      };
    },
  );
}
