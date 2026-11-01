import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  appBuilderHttpStatus,
  isAppBuilderError,
  type AppBuilderManager,
} from '@veltravia/app-builder-core';

/** Local env read: this route does not reach into another route module. */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * App Builder routes (Step 30).
 *
 * The builder itself never writes and never executes. These endpoints give it:
 * a review surface (registry, validation, detection), a plan surface, and one
 * write path (materialize) that goes through the existing project engine.
 *
 * Everything is owner scoped through the same header convention the rest of the
 * API uses, and a plan belonging to someone else answers 404 rather than 403 so
 * the existence of another owner's work stays private.
 */

export interface AppBuilderRouteDeps {
  readonly appBuilder: AppBuilderManager;
}

function ownerOf(request: FastifyRequest): string {
  const header = request.headers['x-veltravia-owner-ref'] ?? request.headers['x-veltravia-owner'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 256);
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
}

const VALIDATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['specification'],
  properties: {
    specification: { type: 'object', additionalProperties: true },
  },
} as const;

const DETECT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      maxItems: 5_000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 500 },
          text: { type: 'string', maxLength: 40_000 },
        },
      },
    },
  },
} as const;

const PLAN_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['specification'],
  properties: {
    specification: { type: 'object', additionalProperties: true },
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

const CODING_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'instruction'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    instruction: { type: 'string', minLength: 1, maxLength: 20_000 },
  },
} as const;

const DEPLOY_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: {
    target: { type: 'string', minLength: 1, maxLength: 64 },
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export function registerAppBuilderRoutes(app: FastifyInstance, deps: AppBuilderRouteDeps): void {
  const { appBuilder } = deps;

  /** Maps a typed builder error to its status; unexpected errors stay opaque. */
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isAppBuilderError(error)) {
      return reply.status(appBuilderHttpStatus(error.code)).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    const message = error instanceof Error ? error.message : 'Unexpected app builder failure.';
    return reply.status(500).send({ error: { code: 'APP_BUILDER_FAILED', message } });
  };

  // -- capabilities ---------------------------------------------------------
  app.get('/api/app-builder', async () => ({
    capabilities: appBuilder.capabilities(),
  }));

  app.get('/api/app-builder/registry', async () => ({
    registryVersion: appBuilder.capabilities().registryVersion,
    technologies: appBuilder.listTechnologies(),
  }));

  app.get<{ Params: { technologyId: string } }>(
    '/api/app-builder/registry/:technologyId',
    async (request, reply) => {
      try {
        return { technology: appBuilder.getTechnology(request.params.technologyId) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // -- specification -------------------------------------------------------
  app.post(
    '/api/app-builder/spec/validate',
    { schema: { body: VALIDATE_BODY } },
    async (request) => {
      const body = request.body as { specification: Record<string, unknown> };
      return { review: appBuilder.reviewSpecification(body.specification) };
    },
  );

  // -- detection -----------------------------------------------------------
  app.post('/api/app-builder/detect', { schema: { body: DETECT_BODY } }, async (request, reply) => {
    try {
      const body = request.body as { files: { path: string; text?: string }[] };
      return { detection: appBuilder.detectFromManifest(body.files) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string } }>(
    '/api/app-builder/projects/:projectId/workspaces/:workspaceId/detect',
    async (request, reply) => {
      try {
        const detection = await appBuilder.detectWorkspace({
          workspaceId: request.params.workspaceId,
          projectId: request.params.projectId,
        });
        return { detection };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // -- plans ---------------------------------------------------------------
  app.post('/api/app-builder/plans', { schema: { body: PLAN_BODY } }, async (request, reply) => {
    try {
      const body = request.body as { specification: Record<string, unknown>; projectId?: string };
      const plan = appBuilder.createPlan({
        ownerRef: ownerOf(request),
        specification: body.specification,
        projectId: body.projectId ?? null,
      });
      return reply.status(201).send({ plan });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/app-builder/plans', async (request) => ({
    plans: appBuilder.listPlans(ownerOf(request)),
  }));

  app.get<{ Params: { planId: string } }>(
    '/api/app-builder/plans/:planId',
    async (request, reply) => {
      try {
        return { plan: appBuilder.getPlan(ownerOf(request), request.params.planId) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { planId: string } }>(
    '/api/app-builder/plans/:planId/materialize',
    async (request, reply) => {
      try {
        const result = await appBuilder.materializePlan({
          ownerRef: ownerOf(request),
          planId: request.params.planId,
        });
        return reply.status(201).send({ result });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { planId: string } }>(
    '/api/app-builder/plans/:planId/build',
    async (request, reply) => {
      try {
        const outcome = await appBuilder.runBuild({
          ownerRef: ownerOf(request),
          planId: request.params.planId,
        });
        return { outcome };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // -- delegation ----------------------------------------------------------
  app.post<{ Params: { projectId: string } }>(
    '/api/app-builder/projects/:projectId/coding',
    { schema: { body: CODING_BODY } },
    async (request, reply) => {
      try {
        const body = request.body as { workspaceId: string; instruction: string };
        const session = await appBuilder.startCodingSession({
          ownerRef: ownerOf(request),
          projectId: request.params.projectId,
          workspaceId: body.workspaceId,
          instruction: body.instruction,
        });
        return { session };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/app-builder/projects/:projectId/preview',
    { schema: { body: CODING_BODY } },
    async (request, reply) => {
      try {
        const body = request.body as { workspaceId: string };
        const preview = await appBuilder.requestPreview({
          ownerRef: ownerOf(request),
          projectId: request.params.projectId,
          workspaceId: body.workspaceId,
        });
        return { preview };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/app-builder/projects/:projectId/deploy',
    { schema: { body: DEPLOY_BODY } },
    async (request, reply) => {
      try {
        const body = request.body as { target: string };
        const deployment = await appBuilder.deploy({
          ownerRef: ownerOf(request),
          projectId: request.params.projectId,
          target: body.target,
        });
        return { deployment };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // -- audit ---------------------------------------------------------------
  app.get('/api/app-builder/audit', async (request) => ({
    events: appBuilder.audit(ownerOf(request)),
  }));
}
