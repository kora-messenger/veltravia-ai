import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProjectEngine } from '@veltravia/project-core';

/**
 * One central ownership guard for every route that names a project or a
 * workspace.
 *
 * WHY CENTRAL: before this guard each route family decided for itself whether to
 * look at the caller, and most did not. A second owner could list, read,
 * overwrite and archive someone else's project through the core project and
 * workspace routes, and read their revisions, checkpoints, codebase index,
 * memories, branches and runtimes. Per-route checks drift; a guard on the
 * parameter cannot be forgotten by a new route that uses `:projectId`.
 *
 * RULES
 *  - The caller is `x-veltravia-owner-ref`, else the development owner. This is
 *    the same identity project creation assigns, so a caller always reaches the
 *    projects it created. It is a development stand-in for real authentication,
 *    not authentication.
 *  - `:projectId` must name a project the caller owns. `:workspaceId` must name a
 *    workspace of such a project.
 *  - A project that belongs to someone else and one that does not exist answer
 *    identically (404, same body), so ids cannot be probed.
 *  - Fails closed: if the lookup itself errors, the request is refused.
 *  - It runs at `onRequest`, before body parsing and validation, so a malformed
 *    body cannot be used to learn whether an id exists.
 *  - A deleted project is treated as missing. Archived projects stay reachable
 *    to their owner (so they can be restored).
 */

const DENIED_BODY = {
  error: { code: 'NOT_FOUND', message: 'That project or workspace was not found.' },
} as const;

/** The owner a request speaks for. */
export function resolveCallerOwnerRef(request: FastifyRequest): string {
  // `x-veltravia-owner-ref` is the convention; `x-veltravia-owner` is the older
  // one the connections routes used. Both name the same caller, owner-ref first.
  const raw = request.headers['x-veltravia-owner-ref'] ?? request.headers['x-veltravia-owner'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.length > 0) return value.slice(0, 256);
  const fallback = process.env['VELTRAVIA_DEFAULT_OWNER_REF'];
  return fallback !== undefined && fallback.length > 0 ? fallback : 'veltravia-dev-user';
}

export interface ProjectAccess {
  /** True when the caller owns a project that exists and is not deleted. */
  ownsProject(ownerRef: string, projectId: string): Promise<boolean>;
  /** True when the caller owns the project the workspace belongs to. */
  ownsWorkspace(ownerRef: string, workspaceId: string): Promise<boolean>;
}

export function createProjectAccess(engine: ProjectEngine): ProjectAccess {
  const ownsProject = async (ownerRef: string, projectId: string): Promise<boolean> => {
    try {
      const project = await engine.projects.getProject(projectId);
      return project.ownerRef === ownerRef && project.status !== 'deleted';
    } catch {
      return false;
    }
  };
  return {
    ownsProject,
    async ownsWorkspace(ownerRef, workspaceId) {
      try {
        const workspace = await engine.workspaces.getWorkspace(workspaceId);
        return await ownsProject(ownerRef, workspace.projectId);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Registers the guard. Call before any route that takes `:projectId` or
 * `:workspaceId`. Routes without those parameters are untouched.
 */
export function registerProjectAccessGuard(app: FastifyInstance, access: ProjectAccess): void {
  app.addHook('onRequest', async (request, reply) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const projectId = params['projectId'];
    const workspaceId = params['workspaceId'];
    if (projectId === undefined && workspaceId === undefined) return;

    const ownerRef = resolveCallerOwnerRef(request);
    if (projectId !== undefined) {
      if (typeof projectId !== 'string' || !(await access.ownsProject(ownerRef, projectId))) {
        return reply.code(404).send(DENIED_BODY);
      }
    }
    if (workspaceId !== undefined) {
      if (typeof workspaceId !== 'string' || !(await access.ownsWorkspace(ownerRef, workspaceId))) {
        return reply.code(404).send(DENIED_BODY);
      }
    }
    return undefined;
  });
}
