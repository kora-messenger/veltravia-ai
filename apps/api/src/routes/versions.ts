import type { FastifyInstance, FastifyReply } from 'fastify';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import {
  isVersionError,
  type Checkpoint,
  type ProjectRevision,
  type RevisionComparison,
  type RollbackOperation,
  type VersionControlManager,
} from '@veltravia/version-core';
import { isToolError, type ToolManager } from '@veltravia/tool-core';

/**
 * Version Control routes (Step 18).
 *
 * Surface: revision capture + timeline, revision + compare diffs, named
 * checkpoints, and rollback.
 *
 * Boundaries:
 * - every route is scoped to :projectId; ownership is resolved server-side
 *   through the Project Engine gateway
 * - revision list/detail responses are METADATA ONLY - file contents live
 *   in the store and surface only through the bounded diff views
 * - rollback executes ONLY through the Tool System (`version.rollback`,
 *   critical risk): the first request pauses for a HUMAN confirmation bound
 *   to the exact input; the decision endpoint replays the STORED server-
 *   side request, never client input
 * - rollback ALWAYS creates a new revision; history is never rewritten
 */

const VERSION_ERROR_STATUS: Record<string, number> = {
  VERSION_INVALID_REQUEST: 400,
  VERSION_VALIDATION_FAILED: 400,
  VERSION_SECRET_REJECTED: 422,
  VERSION_PROJECT_NOT_FOUND: 404,
  VERSION_WORKSPACE_NOT_FOUND: 404,
  VERSION_REVISION_NOT_FOUND: 404,
  VERSION_CHECKPOINT_NOT_FOUND: 404,
  VERSION_SNAPSHOT_NOT_FOUND: 404,
  VERSION_OPERATION_NOT_FOUND: 404,
  VERSION_REVISION_FOREIGN_PROJECT: 403,
  VERSION_REVISION_FOREIGN_WORKSPACE: 403,
  VERSION_INVALID_ROLLBACK_TARGET: 422,
  VERSION_CORRUPTED_SNAPSHOT: 500,
  VERSION_REVISION_CONFLICT: 409,
  VERSION_STALE_REVISION: 409,
  VERSION_INVALID_TRANSITION: 409,
  VERSION_OPERATION_ALREADY_RESOLVED: 409,
  VERSION_RETENTION_VIOLATION: 422,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isVersionError(error)) {
    const status = VERSION_ERROR_STATUS[error.code] ?? 500;
    return {
      status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  if (isProjectError(error)) {
    const status =
      error.code === 'PROJECT_NOT_FOUND' || error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
    return { status, body: { error: error.toJSON() } };
  }
  if (isToolError(error)) {
    return { status: 409, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

/** Safe revision view: metadata only - no snapshot content ever. */
function toRevisionView(
  revision: ProjectRevision,
  checkpoints: readonly Checkpoint[],
): Record<string, unknown> {
  const checkpointRefs = checkpoints
    .filter((checkpoint) => checkpoint.revisionId === revision.id)
    .map((checkpoint) => ({ id: checkpoint.id, name: checkpoint.name }));
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    parentRevisionId: revision.parentRevisionId,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
    source: revision.source,
    status: revision.status,
    change: revision.change,
    fileCount: revision.fileCount,
    totalBytes: revision.totalBytes,
    manifestHash: revision.manifestHash,
    message: revision.message,
    restoredFromRevisionId: revision.restoredFromRevisionId,
    checkpointRefs,
  };
}

function toCheckpointView(
  checkpoint: Checkpoint,
  revision: ProjectRevision | null,
): Record<string, unknown> {
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    description: checkpoint.description,
    createdAt: checkpoint.createdAt,
    createdBy: checkpoint.createdBy,
    revision: revision === null ? null : toRevisionView(revision, []),
  };
}

function toOperationView(operation: RollbackOperation): Record<string, unknown> {
  return {
    id: operation.id,
    state: operation.state,
    createdAt: operation.createdAt,
    decidedAt: operation.decidedAt,
    completedAt: operation.completedAt,
    failureCode: operation.failureCode,
    failureMessage: operation.failureMessage,
    result: operation.result,
    request: {
      workspaceId: operation.request.workspaceId,
      targetRevisionId: operation.request.targetRevisionId,
      expectedCurrentRevision: operation.request.expectedCurrentRevision,
      reason: operation.request.reason,
    },
  };
}

function toDiffView(comparison: RevisionComparison): Record<string, unknown> {
  return { ...comparison };
}

export interface VersionRoutesOptions {
  readonly version: VersionControlManager;
  readonly projectEngine: ProjectEngine;
  readonly tools: ToolManager;
}

const ROLLBACK_TOOL_ID = 'version.rollback';

export function registerVersionRoutes(app: FastifyInstance, options: VersionRoutesOptions): void {
  const { version, projectEngine, tools } = options;

  /** Resolves the project or sends the typed 404 - every route begins with it. */
  async function requireProject(projectId: string, reply: FastifyReply): Promise<boolean> {
    try {
      await projectEngine.projects.getProject(projectId);
      return true;
    } catch (error) {
      if (isProjectError(error)) {
        await reply.code(error.code === 'PROJECT_NOT_FOUND' ? 404 : 400).send({
          error: error.toJSON(),
        });
        return false;
      }
      throw error;
    }
  }

  const captureBodySchema = {
    type: 'object',
    required: ['workspaceId'],
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
      message: { type: 'string', maxLength: 500 },
      source: {
        type: 'string',
        enum: [
          'manual',
          'generation_before',
          'generation_after',
          'testing_before_repair',
          'testing_after',
          'coding_before',
          'coding_after',
          'rollback',
        ],
      },
    },
  };

  const checkpointBodySchema = {
    type: 'object',
    required: ['workspaceId', 'name'],
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 1000 },
      revisionId: { type: 'string', minLength: 1, maxLength: 128 },
    },
  };

  const rollbackBodySchema = {
    type: 'object',
    required: ['workspaceId', 'targetRevisionId', 'expectedCurrentRevision'],
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
      targetRevisionId: { type: 'string', minLength: 1, maxLength: 128 },
      expectedCurrentRevision: { type: 'integer', minimum: 0 },
      reason: { type: 'string', maxLength: 500 },
    },
  };

  const confirmationBodySchema = {
    type: 'object',
    required: ['decision'],
    additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: ['approve', 'reject'] },
    },
  };

  app.get('/api/projects/:projectId/revisions', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    const query = (request.query ?? {}) as { workspaceId?: string; limit?: string; skip?: string };
    const workspaceId = query.workspaceId ?? '';
    if (workspaceId === '') {
      return reply
        .code(400)
        .send({ error: { code: 'VERSION_INVALID_REQUEST', message: 'workspaceId is required.' } });
    }
    try {
      const page = await version.listRevisions(
        projectId,
        workspaceId,
        query.limit !== undefined ? Number(query.limit) : undefined,
        query.skip !== undefined ? Number(query.skip) : undefined,
      );
      const checkpoints = await version.listCheckpoints(projectId, workspaceId);
      return reply.send({
        revisions: page.revisions.map((revision) => toRevisionView(revision, checkpoints)),
        total: page.total,
        hasMore: page.hasMore,
      });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/projects/:projectId/revisions',
    { schema: { body: captureBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await requireProject(projectId, reply))) return reply;
      const body = (request.body ?? {}) as {
        workspaceId: string;
        message?: string;
        source?: string;
      };
      try {
        const revision = await version.captureRevision({
          projectId,
          workspaceId: body.workspaceId,
          source: (body.source ?? 'manual') as 'manual',
          message: body.message ?? null,
        });
        const checkpoints = await version.listCheckpoints(projectId, body.workspaceId);
        return reply.code(201).send(toRevisionView(revision, checkpoints));
      } catch (error) {
        const { status, body: errorBody } = toHttpError(error);
        return reply.code(status).send(errorBody);
      }
    },
  );

  app.get('/api/projects/:projectId/revisions/compare', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    const query = (request.query ?? {}) as { workspaceId?: string; from?: string; to?: string };
    if ((query.workspaceId ?? '') === '' || (query.from ?? '') === '' || (query.to ?? '') === '') {
      return reply.code(400).send({
        error: {
          code: 'VERSION_INVALID_REQUEST',
          message: 'workspaceId, from, and to are required.',
        },
      });
    }
    try {
      const comparison = await version.compareRevisions(
        projectId,
        query.workspaceId as string,
        query.from as string,
        query.to as string,
      );
      return reply.send(toDiffView(comparison));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId/revisions/:revisionId', async (request, reply) => {
    const { projectId, revisionId } = request.params as { projectId: string; revisionId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    const query = (request.query ?? {}) as { workspaceId?: string };
    const workspaceId = query.workspaceId ?? '';
    if (workspaceId === '') {
      return reply
        .code(400)
        .send({ error: { code: 'VERSION_INVALID_REQUEST', message: 'workspaceId is required.' } });
    }
    try {
      const revision = await version.getRevision(projectId, workspaceId, revisionId);
      const checkpoints = await version.listCheckpoints(projectId, workspaceId);
      return reply.send(toRevisionView(revision, checkpoints));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId/revisions/:revisionId/diff', async (request, reply) => {
    const { projectId, revisionId } = request.params as { projectId: string; revisionId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    const query = (request.query ?? {}) as { workspaceId?: string };
    const workspaceId = query.workspaceId ?? '';
    if (workspaceId === '') {
      return reply
        .code(400)
        .send({ error: { code: 'VERSION_INVALID_REQUEST', message: 'workspaceId is required.' } });
    }
    try {
      const comparison = await version.getRevisionDiff(projectId, workspaceId, revisionId);
      return reply.send(toDiffView(comparison));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/projects/:projectId/checkpoints',
    { schema: { body: checkpointBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await requireProject(projectId, reply))) return reply;
      const body = (request.body ?? {}) as {
        workspaceId: string;
        name: string;
        description?: string;
        revisionId?: string;
      };
      try {
        const checkpoint = await version.createCheckpoint({
          projectId,
          workspaceId: body.workspaceId,
          name: body.name,
          description: body.description ?? null,
          revisionId: body.revisionId,
        });
        const revision = await version.getRevision(
          projectId,
          body.workspaceId,
          checkpoint.revisionId,
        );
        return reply.code(201).send(toCheckpointView(checkpoint, revision));
      } catch (error) {
        const { status, body: errorBody } = toHttpError(error);
        return reply.code(status).send(errorBody);
      }
    },
  );

  app.get('/api/projects/:projectId/checkpoints', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    const query = (request.query ?? {}) as { workspaceId?: string };
    const workspaceId = query.workspaceId ?? '';
    if (workspaceId === '') {
      return reply
        .code(400)
        .send({ error: { code: 'VERSION_INVALID_REQUEST', message: 'workspaceId is required.' } });
    }
    try {
      const checkpoints = await version.listCheckpoints(projectId, workspaceId);
      const views = [];
      for (const checkpoint of checkpoints) {
        const revision = await version
          .getRevision(projectId, workspaceId, checkpoint.revisionId)
          .catch(() => null);
        views.push(toCheckpointView(checkpoint, revision));
      }
      return reply.send({ checkpoints: views });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.delete('/api/projects/:projectId/checkpoints/:checkpointId', async (request, reply) => {
    const { projectId, checkpointId } = request.params as {
      projectId: string;
      checkpointId: string;
    };
    if (!(await requireProject(projectId, reply))) return reply;
    const query = (request.query ?? {}) as { workspaceId?: string };
    const workspaceId = query.workspaceId ?? '';
    if (workspaceId === '') {
      return reply
        .code(400)
        .send({ error: { code: 'VERSION_INVALID_REQUEST', message: 'workspaceId is required.' } });
    }
    try {
      await version.deleteCheckpoint(projectId, workspaceId, checkpointId);
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  /**
   * Opens a rollback: validates the target server-side, then invokes the
   * CRITICAL-risk Tool System tool, which pauses for a HUMAN confirmation
   * bound to the exact input. Nothing has been restored yet.
   */
  app.post(
    '/api/projects/:projectId/rollback',
    { schema: { body: rollbackBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await requireProject(projectId, reply))) return reply;
      const body = (request.body ?? {}) as {
        workspaceId: string;
        targetRevisionId: string;
        expectedCurrentRevision: number;
        reason?: string;
      };
      // The Tool System schema requires strings, not null: omit `reason`
      // entirely when the caller did not supply one.
      const requestInput = {
        projectId,
        workspaceId: body.workspaceId,
        targetRevisionId: body.targetRevisionId,
        expectedCurrentRevision: body.expectedCurrentRevision,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      };
      try {
        // Pre-validation gives honest typed errors BEFORE any confirmation.
        const validation = await version.validateRollbackTarget({
          ...requestInput,
          reason: body.reason ?? null,
        });
        const result = await tools.invoke(
          ROLLBACK_TOOL_ID,
          { ...requestInput },
          {
            requester: 'api',
            correlationId: `rollback-${Date.now()}`,
          },
        );
        if (result.status === 'awaiting_confirmation' && result.confirmationId !== undefined) {
          const operation = await version.registerOperation(
            { ...requestInput, reason: body.reason ?? null },
            result.confirmationId,
          );
          let confirmationView: Record<string, unknown> | null = null;
          try {
            confirmationView = {
              ...tools.getConfirmation(result.confirmationId),
            } as unknown as Record<string, unknown>;
          } catch {
            confirmationView = null;
          }
          return reply.code(202).send({
            operation: toOperationView(operation),
            confirmationId: result.confirmationId,
            confirmation: confirmationView,
            validation: {
              targetRevisionId: validation.target.id,
              targetRevisionNumber: validation.target.revisionNumber,
              currentRevision: validation.currentRevision,
              filesChanged: validation.filesChanged,
            },
          });
        }
        // Not awaiting confirmation: the invocation failed or was denied.
        // No operation is registered - nothing is pending or restorable.
        const status = result.status === 'denied' ? 409 : 500;
        return reply.code(status).send({
          error: {
            code: 'ROLLBACK_INVOCATION_FAILED',
            message: `Rollback could not be started (tool status: ${result.status}).`,
          },
          toolResult: { status: result.status, error: result.error ?? null },
        });
      } catch (error) {
        const { status, body: errorBody } = toHttpError(error);
        return reply.code(status).send(errorBody);
      }
    },
  );

  app.get('/api/projects/:projectId/rollback/:operationId', async (request, reply) => {
    const { projectId, operationId } = request.params as { projectId: string; operationId: string };
    if (!(await requireProject(projectId, reply))) return reply;
    try {
      const operation = await version.getOperation(operationId);
      if (operation.request.projectId !== projectId) {
        return reply.code(404).send({
          error: { code: 'VERSION_OPERATION_NOT_FOUND', message: 'Rollback operation not found.' },
        });
      }
      return reply.send(toOperationView(operation));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  /**
   * The human decision. Approve replays the STORED server-side request
   * through the confirmed Tool System invocation; reject closes the
   * operation without restoring anything. The client can never supply
   * replacement input here.
   */
  app.post(
    '/api/projects/:projectId/rollback/:operationId/confirmation',
    { schema: { body: confirmationBodySchema } },
    async (request, reply) => {
      const { projectId, operationId } = request.params as {
        projectId: string;
        operationId: string;
      };
      if (!(await requireProject(projectId, reply))) return reply;
      const { decision } = (request.body ?? {}) as { decision: 'approve' | 'reject' };
      try {
        const operation = await version.getOperation(operationId);
        if (operation.request.projectId !== projectId) {
          return reply.code(404).send({
            error: {
              code: 'VERSION_OPERATION_NOT_FOUND',
              message: 'Rollback operation not found.',
            },
          });
        }
        if (operation.state !== 'pending_confirmation' || operation.confirmationId === null) {
          return reply.code(409).send({
            error: {
              code: 'VERSION_OPERATION_ALREADY_RESOLVED',
              message: 'This rollback operation is already resolved.',
            },
          });
        }
        const confirmationId = operation.confirmationId;

        if (decision === 'reject') {
          try {
            tools.confirm(confirmationId, 'rejected');
          } catch {
            // Already decided/expired server-side: the operation still ends.
          }
          const rejected = await version.rejectOperation(operationId);
          return reply.send(toOperationView(rejected));
        }

        try {
          tools.confirm(confirmationId, 'approved');
        } catch (error) {
          // Confirmation expired or already decided: fail the operation
          // honestly - nothing was restored.
          await version.failOperation(
            operationId,
            'CONFIRMATION_EXPIRED',
            error instanceof Error ? error.message : 'confirmation unavailable',
          );
          return reply.code(410).send({
            error: {
              code: 'CONFIRMATION_EXPIRED',
              message:
                'The rollback confirmation expired before it was approved. Nothing was restored.',
            },
          });
        }
        await version.approveOperation(operationId);

        // Replay the STORED request through the confirmed invocation.
        const stored = operation.request;
        const result = await tools.invoke(
          ROLLBACK_TOOL_ID,
          {
            projectId: stored.projectId,
            workspaceId: stored.workspaceId,
            targetRevisionId: stored.targetRevisionId,
            expectedCurrentRevision: stored.expectedCurrentRevision,
            ...(stored.reason !== null ? { reason: stored.reason } : {}),
          },
          { requester: 'api', confirmationId },
        );
        if (result.status === 'success' && result.output !== undefined) {
          const output = result.output as {
            newRevisionId: string;
            newRevisionNumber: number;
            restoredFromRevisionId: string;
            restoredFromRevisionNumber: number;
            filesChanged: number;
          };
          const completed = await version.completeOperation(operationId, output);
          return reply.send(toOperationView(completed));
        }
        const failureCode =
          result.error?.code ??
          (result.status === 'denied' ? 'TOOL_DENIED' : 'TOOL_EXECUTION_FAILED');
        const failureMessage = result.error?.message ?? `Tool invocation status: ${result.status}`;
        const failed = await version.failOperation(
          operationId,
          String(failureCode),
          failureMessage,
        );
        return reply.code(409).send({ operation: toOperationView(failed) });
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );
}
