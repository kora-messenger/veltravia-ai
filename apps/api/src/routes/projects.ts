import { readEnv } from '@veltravia/config';
import type { FastifyInstance } from 'fastify';
import {
  InvalidPathError,
  isProjectError,
  type FileNode,
  type Project,
  type ProjectEngine,
} from '@veltravia/project-core';

/** Maps normalized project-engine error codes to HTTP status codes. */
const PROJECT_ERROR_STATUS: Record<string, number> = {
  PROJECT_INVALID_REQUEST: 400,
  SECRET_REJECTED: 400,
  PATH_INVALID: 400,
  PATH_PARENT_MISSING: 400,
  CONTEXT_INVALID: 400,
  CONFIG_INVALID: 400,
  INTEGRATION_INVALID: 400,
  NODE_INVALID: 400,
  PROJECT_NOT_FOUND: 404,
  WORKSPACE_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  PROJECT_INVALID_TRANSITION: 409,
  PROJECT_ARCHIVED: 409,
  PROJECT_DELETED: 409,
  WORKSPACE_NOT_ACTIVE: 409,
  PATH_CONFLICT: 409,
  REVISION_CONFLICT: 409,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isProjectError(error)) {
    const status = PROJECT_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

/** Strips internal fields from a file node for API responses (content excluded). */
function nodeResponse(node: FileNode): Record<string, unknown> {
  return {
    id: node.id,
    path: node.path,
    name: node.name,
    type: node.type,
    parentId: node.parentId,
    size: node.size,
    revision: node.revision,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function projectResponse(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    projectType: project.projectType,
    ownerRef: project.ownerRef,
    workspaceId: project.workspaceId,
    version: project.version,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    metadata: project.metadata,
  };
}

/** Decodes a raw wildcard path segment; malformed encodings are a 400. */
function decodeWildcard(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new InvalidPathError(raw, 'malformed-encoding');
  }
}

const projectTypeSchema = {
  type: 'string',
  enum: ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'],
};

const metadataSchema = { type: 'object', additionalProperties: true };

/**
 * Development owner identity for project creation.
 *
 * Until authentication exists (a later roadmap step), ownership defaults
 * server-side to an opaque reference so the frontend never hardcodes a user
 * identity. A real deployment derives `ownerRef` from the authenticated
 * session instead; the field is identity metadata, never a credential.
 */
function developmentOwnerRef(): string {
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
}

export function registerProjectRoutes(app: FastifyInstance, engine: ProjectEngine): void {
  // -----------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------

  const createProjectSchema = {
    type: 'object',
    required: ['name', 'description', 'projectType'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      description: { type: 'string', maxLength: 2000 },
      projectType: projectTypeSchema,
      ownerRef: { type: 'string', minLength: 1, maxLength: 256 },
      version: { type: 'string', maxLength: 64 },
      metadata: metadataSchema,
    },
  };
  app.post('/api/projects', { schema: { body: createProjectSchema } }, async (request, reply) => {
    try {
      const body = request.body as {
        name: string;
        description: string;
        projectType: Project['projectType'];
        ownerRef?: string;
        version?: string;
        metadata?: Record<string, unknown>;
      };
      const project = await engine.projects.createProject({
        name: body.name,
        description: body.description,
        projectType: body.projectType,
        ownerRef: body.ownerRef ?? developmentOwnerRef(),
        ...(body.version !== undefined ? { version: body.version } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      return reply.code(201).send(projectResponse(project));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/projects', async (_request, reply) => {
    try {
      const projects = await engine.projects.listProjects();
      return reply.send({ projects: projects.map(projectResponse) });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      return reply.send(projectResponse(await engine.projects.getProject(projectId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  const patchProjectSchema = {
    type: 'object',
    required: ['expectedRevision'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      description: { type: 'string', maxLength: 2000 },
      metadata: metadataSchema,
      expectedRevision: { type: 'integer', minimum: 1 },
    },
  };
  app.patch(
    '/api/projects/:projectId',
    { schema: { body: patchProjectSchema } },
    async (request, reply) => {
      try {
        const { projectId } = request.params as { projectId: string };
        const body = request.body as {
          name?: string;
          description?: string;
          metadata?: Record<string, unknown>;
          expectedRevision: number;
        };
        const project = await engine.projects.updateProject(
          projectId,
          {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          },
          body.expectedRevision,
        );
        return reply.send(projectResponse(project));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.post('/api/projects/:projectId/archive', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      return reply.send(projectResponse(await engine.projects.archiveProject(projectId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/restore', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      return reply.send(projectResponse(await engine.projects.restoreProject(projectId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  // -----------------------------------------------------------------
  // Workspaces
  // -----------------------------------------------------------------

  const createWorkspaceSchema = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      metadata: metadataSchema,
    },
  };
  app.post(
    '/api/projects/:projectId/workspaces',
    { schema: { body: createWorkspaceSchema } },
    async (request, reply) => {
      try {
        const { projectId } = request.params as { projectId: string };
        const body = request.body as { name: string; metadata?: Record<string, unknown> };
        const workspace = await engine.workspaces.createWorkspace(projectId, {
          name: body.name,
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        });
        return reply.code(201).send(workspace);
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.get('/api/projects/:projectId/workspaces', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const workspaces = await engine.workspaces.listWorkspaces(projectId);
      return reply.send({ workspaces });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/workspaces/:workspaceId', async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      return reply.send(await engine.workspaces.getWorkspace(workspaceId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  // -----------------------------------------------------------------
  // Virtual file tree
  // -----------------------------------------------------------------

  app.get('/api/workspaces/:workspaceId/tree', async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const workspace = await engine.workspaces.getWorkspace(workspaceId);
      const nodes = await engine.files.listAll(workspaceId);
      return reply.send({ workspace, nodes: nodes.map(nodeResponse) });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  // Reads: file content only. Contents are PROJECT DATA - the API never
  // exposes host filesystem access, shell execution, or code execution.
  app.get('/api/workspaces/:workspaceId/files/*', async (request, reply) => {
    try {
      const { workspaceId, '*': wildcard } = request.params as { workspaceId: string; '*': string };
      const path = decodeWildcard(wildcard);
      const { node, content } = await engine.files.readFile(workspaceId, path);
      return reply.send({ node: nodeResponse(node), content });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  // File mutations: every validation and security rule is enforced by the
  // FileTreeManager (active status, normalization, traversal rejection,
  // parent checks, duplicate prevention, revision protection).
  const createFileSchema = {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 512 },
      content: { type: 'string' },
    },
  };
  app.post(
    '/api/workspaces/:workspaceId/files',
    { schema: { body: createFileSchema } },
    async (request, reply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string };
        const body = request.body as { path: string; content?: string };
        const node = await engine.files.createFile(workspaceId, {
          path: body.path,
          ...(body.content !== undefined ? { content: body.content } : {}),
        });
        return reply.code(201).send(nodeResponse(node));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  const updateFileSchema = {
    type: 'object',
    required: ['content', 'expectedRevision'],
    additionalProperties: false,
    properties: {
      content: { type: 'string' },
      expectedRevision: { type: 'integer', minimum: 1 },
    },
  };
  app.patch(
    '/api/workspaces/:workspaceId/files/*',
    { schema: { body: updateFileSchema } },
    async (request, reply) => {
      try {
        const { workspaceId, '*': wildcard } = request.params as {
          workspaceId: string;
          '*': string;
        };
        const path = decodeWildcard(wildcard);
        const body = request.body as { content: string; expectedRevision: number };
        const node = await engine.files.updateFile(workspaceId, path, {
          content: body.content,
          expectedRevision: body.expectedRevision,
        });
        return reply.send(nodeResponse(node));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.delete('/api/workspaces/:workspaceId/files/*', async (request, reply) => {
    try {
      const { workspaceId, '*': wildcard } = request.params as { workspaceId: string; '*': string };
      const path = decodeWildcard(wildcard);
      await engine.files.deleteFile(workspaceId, path);
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  const createDirectorySchema = {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 512 },
    },
  };
  app.post(
    '/api/workspaces/:workspaceId/directories',
    { schema: { body: createDirectorySchema } },
    async (request, reply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string };
        const body = request.body as { path: string };
        const node = await engine.files.createDirectory(workspaceId, body.path);
        return reply.code(201).send(nodeResponse(node));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.delete('/api/workspaces/:workspaceId/directories/*', async (request, reply) => {
    try {
      const { workspaceId, '*': wildcard } = request.params as { workspaceId: string; '*': string };
      const path = decodeWildcard(wildcard);
      await engine.files.deleteDirectory(workspaceId, path);
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  const moveNodeSchema = {
    type: 'object',
    required: ['fromPath', 'toDirectory'],
    additionalProperties: false,
    properties: {
      fromPath: { type: 'string', minLength: 1, maxLength: 512 },
      toDirectory: { type: 'string', maxLength: 512 },
    },
  };
  app.post(
    '/api/workspaces/:workspaceId/nodes/move',
    { schema: { body: moveNodeSchema } },
    async (request, reply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string };
        const body = request.body as { fromPath: string; toDirectory: string };
        const node = await engine.files.moveNode(workspaceId, {
          fromPath: body.fromPath,
          toDirectory: body.toDirectory,
        });
        return reply.send(nodeResponse(node));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  const renameNodeSchema = {
    type: 'object',
    required: ['path', 'newName'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 512 },
      newName: { type: 'string', minLength: 1, maxLength: 255 },
    },
  };
  app.post(
    '/api/workspaces/:workspaceId/nodes/rename',
    { schema: { body: renameNodeSchema } },
    async (request, reply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string };
        const body = request.body as { path: string; newName: string };
        const node = await engine.files.renameNode(workspaceId, {
          path: body.path,
          newName: body.newName,
        });
        return reply.send(nodeResponse(node));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );
}
