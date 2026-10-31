import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import { RouterError, isRouterError, isTaskCategory, routerHttpStatus } from '@veltravia/ai-router';
import type { ProjectEngine } from '@veltravia/project-core';

import type { AIProviderGateway } from '@veltravia/ai-gateway';
import type { ModelRouterService } from '../model-router-service.js';

/**
 * Model router routes (Step 28).
 *
 * The surface is deliberately small: read the catalog and what each task needs,
 * ask for a route, read the recent decisions, and set preferences. Nothing here
 * can execute a model call, and no response contains a credential, a credential
 * reference or a provider base URL.
 *
 * A real deployment reads the owner from an authenticated session. This build
 * derives it from `x-veltravia-owner-ref` (falling back to `x-veltravia-owner`,
 * then the configured default owner) - a documented development stand-in for
 * authentication, never proof of identity.
 */

const PERSISTENCE_NOTE =
  'Routing preferences and decision history are held in memory for this server process. They are lost on restart and are not presented as durable storage.';

function ownerOf(request: FastifyRequest): { ownerRef: string } {
  const prefer = request.headers['x-veltravia-owner-ref'];
  const fallback = request.headers['x-veltravia-owner'];
  const raw =
    (Array.isArray(prefer) ? prefer[0] : prefer) ??
    (Array.isArray(fallback) ? fallback[0] : fallback);
  if (typeof raw === 'string' && raw.length > 0) return { ownerRef: raw.slice(0, 256) };
  return { ownerRef: readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user' };
}

function toError(error: unknown): { status: number; body: unknown } {
  if (isRouterError(error)) {
    return {
      status: routerHttpStatus(error.code),
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    (error as { name?: string }).name === 'ProjectError'
  ) {
    return {
      status: 404,
      body: {
        error: { code: 'PROJECT_NOT_FOUND', message: 'That project does not exist.' },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'ROUTER_INTERNAL', message: 'Unexpected failure.' } },
  };
}

/** A project the caller may configure: owned by them, or the request is refused. */
async function assertOwnedProject(
  engine: ProjectEngine | undefined,
  ownerRef: string,
  projectId: string,
): Promise<void> {
  if (engine === undefined) return;
  const project = await engine.projects.getProject(projectId);
  if (project.ownerRef !== ownerRef) {
    throw new RouterError(
      'ROUTER_DECISION_NOT_FOUND',
      'That project does not exist for this account.',
    );
  }
}

export function registerModelRouterRoutes(
  app: FastifyInstance,
  options: {
    readonly service: ModelRouterService;
    readonly projects?: ProjectEngine;
    /**
     * The Step 26 gateway. Router preferences are mirrored into it, so the
     * services that execute through the gateway (agent layer, coding agent,
     * documents, cross-source intelligence) use the same default and the same
     * per-project choice instead of keeping a second set of settings.
     */
    readonly gateway?: AIProviderGateway | null;
    readonly blockedReason?: string | null;
  },
): void {
  const { service, projects, gateway } = options;

  /**
   * Copies the default and project choices into the gateway's own preference
   * store. Failure is not fatal - a disconnected provider should not block a
   * preference edit - but it is reported honestly instead of implied.
   */
  async function mirrorToGateway(
    ownerRef: string,
  ): Promise<{ applied: boolean; reason: string | null }> {
    if (!gateway) {
      return { applied: false, reason: 'No provider gateway is configured on this server.' };
    }
    const preferences = await service.router.preferences({ ownerRef });
    const projects: Record<string, { connectionId: string; modelId: string } | null> = {};
    for (const projectId of Object.keys(preferences.projectPreferences)) {
      const model = preferences.projectPreferences[projectId]?.model;
      projects[projectId] = model
        ? { connectionId: model.connectionId, modelId: model.modelId }
        : null;
    }
    try {
      await gateway.setPreferences(
        { ownerRef },
        {
          ...(preferences.defaultModel !== null
            ? {
                defaultConnectionId: preferences.defaultModel.connectionId,
                defaultModelId: preferences.defaultModel.modelId,
              }
            : {}),
          projects,
        },
      );
      return { applied: true, reason: null };
    } catch {
      return {
        applied: false,
        reason:
          'These preferences were saved for routing, but could not be applied to the provider gateway yet.',
      };
    }
  }

  // ----- overview: catalog, task support and current preferences ----------
  app.get('/api/ai/router', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      const scope = { ownerRef };
      const [categories, catalog, preferences] = await Promise.all([
        service.router.capabilities(scope),
        service.router.catalog(scope),
        service.router.preferences(scope),
      ]);
      return reply.send({
        categories,
        catalog: catalog.models,
        catalogNotes: catalog.notes,
        capabilityCounts: catalog.capabilityCounts,
        providerCount: catalog.providers,
        preferences,
        persistence: PERSISTENCE_NOTE,
        ...(options.blockedReason ? { blockedReason: options.blockedReason } : {}),
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  // ----- preferences ------------------------------------------------------
  app.get('/api/ai/router/preferences', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      return reply.send({
        preferences: await service.router.preferences({ ownerRef }),
        persistence: PERSISTENCE_NOTE,
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.put('/api/ai/router/preferences', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;

      const projectPreferences =
        body.projectPreferences !== null && typeof body.projectPreferences === 'object'
          ? (body.projectPreferences as Record<string, unknown>)
          : {};
      for (const [projectId, entry] of Object.entries(projectPreferences)) {
        if (entry === null || typeof entry !== 'object') continue;
        await assertOwnedProject(projects, ownerRef, projectId);
      }

      const updated = await service.router.updatePreferences(
        { ownerRef },
        {
          ...(typeof body.autoSelect === 'boolean' ? { autoSelect: body.autoSelect } : {}),
          ...(typeof body.allowFallback === 'boolean' ? { allowFallback: body.allowFallback } : {}),
          ...(typeof body.preference === 'string' ? { preference: body.preference as never } : {}),
          ...(body.defaultModel === null
            ? { defaultModel: null }
            : body.defaultModel !== undefined && typeof body.defaultModel === 'object'
              ? {
                  defaultModel: {
                    connectionId: String(
                      (body.defaultModel as { connectionId?: unknown }).connectionId ?? '',
                    ),
                    modelId: String((body.defaultModel as { modelId?: unknown }).modelId ?? ''),
                  },
                }
              : {}),
          ...(body.taskPreferences !== undefined && body.taskPreferences !== null
            ? {
                taskPreferences: Object.fromEntries(
                  Object.entries(body.taskPreferences as Record<string, unknown>).map(
                    ([category, choice]) =>
                      choice === null || typeof choice !== 'object'
                        ? [category, null]
                        : [
                            category,
                            {
                              connectionId: String(
                                (choice as { connectionId?: unknown }).connectionId ?? '',
                              ),
                              modelId: String((choice as { modelId?: unknown }).modelId ?? ''),
                            },
                          ],
                  ),
                ),
              }
            : {}),
          ...(body.projectPreferences !== undefined
            ? {
                projectPreferences: Object.fromEntries(
                  Object.entries(projectPreferences).map(([projectId, entry]) => {
                    if (entry === null || typeof entry !== 'object') return [projectId, null];
                    const value = entry as Record<string, unknown>;
                    return [
                      projectId,
                      {
                        ...(typeof value.connectionId === 'string'
                          ? { connectionId: value.connectionId }
                          : value.connectionId === null
                            ? { connectionId: null }
                            : {}),
                        ...(typeof value.modelId === 'string'
                          ? { modelId: value.modelId }
                          : value.modelId === null
                            ? { modelId: null }
                            : {}),
                        ...(typeof value.autoSelect === 'boolean'
                          ? { autoSelect: value.autoSelect }
                          : {}),
                        ...(typeof value.preference === 'string'
                          ? { preference: value.preference as never }
                          : {}),
                      },
                    ];
                  }),
                ),
              }
            : {}),
        },
      );

      const mirror = await mirrorToGateway(ownerRef);
      return reply.send({
        preferences: updated,
        persistence: PERSISTENCE_NOTE,
        appliedToExecution: mirror.applied,
        ...(mirror.reason ? { mirrorNote: mirror.reason } : {}),
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  // ----- routing ----------------------------------------------------------
  app.post('/api/ai/router/route', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isTaskCategory(body.category)) {
        throw new RouterError('ROUTER_UNKNOWN_CATEGORY', 'That task category is not supported.');
      }
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.slice(0, 128) : undefined;
      if (projectId !== undefined) await assertOwnedProject(projects, ownerRef, projectId);

      const decision = await service.routeFor(ownerRef, {
        category: body.category,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(typeof body.connectionId === 'string' ? { connectionId: body.connectionId } : {}),
        ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
        ...(typeof body.mode === 'string'
          ? { mode: body.mode as 'automatic' | 'manual' | 'project' }
          : {}),
        ...(typeof body.needsStreaming === 'boolean'
          ? { needsStreaming: body.needsStreaming }
          : {}),
        ...(typeof body.estimatedInputTokens === 'number'
          ? { estimatedInputTokens: body.estimatedInputTokens }
          : {}),
        ...(typeof body.purpose === 'string' ? { purpose: body.purpose.slice(0, 200) } : {}),
      });

      // Advisory endpoint: producing a decision is the success case, including
      // the honest "nothing can run this" answer. Callers read outcome, so a
      // refusal arrives as data instead of an opaque error.
      return reply.status(200).send({ decision });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/ai/router/decisions', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      const limit = Number((request.query as { limit?: unknown } | undefined)?.limit ?? 10);
      const decisions = await service.router.recentDecisions(
        { ownerRef },
        Number.isFinite(limit) ? Math.max(1, Math.min(40, Math.trunc(limit))) : 10,
      );
      return reply.send({ decisions, persistence: PERSISTENCE_NOTE });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/ai/router/decisions/:decisionId', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      const { decisionId } = request.params as { decisionId: string };
      return reply.send({ decision: await service.router.decision({ ownerRef }, decisionId) });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  // ----- execution evidence ----------------------------------------------
  app.post('/api/ai/router/outcomes', async (request, reply) => {
    try {
      const { ownerRef } = ownerOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (
        typeof body.providerId !== 'string' ||
        typeof body.modelId !== 'string' ||
        (body.status !== 'success' && body.status !== 'failure')
      ) {
        throw new RouterError(
          'ROUTER_INVALID_REQUEST',
          'An outcome needs a provider, a model and a status.',
        );
      }
      await service.recordOutcome(ownerRef, {
        providerId: body.providerId.slice(0, 128),
        modelId: body.modelId.slice(0, 200),
        status: body.status,
        ...(typeof body.latencyMs === 'number' ? { latencyMs: body.latencyMs } : {}),
      });
      return reply.status(204).send();
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });
}
