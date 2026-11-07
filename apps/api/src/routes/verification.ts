/**
 * Verification routes (Step 45).
 *
 * What these endpoints answer: what this project can really verify, and what
 * actually ran the last time it was asked. They never accept a command - only
 * operation names - and they never report a pass that no process produced. When
 * no execution runtime is configured the capability endpoint says so, and a run
 * is recorded as blocked with zero operations executed.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { VERIFICATION_OPERATIONS } from '@veltravia/verification-core';

import { createProjectAccess, resolveCallerOwnerRef } from '../project-access.js';
import type { ProjectEngine } from '@veltravia/project-core';
import type { VerificationService } from '../verification.js';

export interface VerificationRouteDeps {
  readonly verification: VerificationService;
  readonly projects: ProjectEngine;
}

const runParam = {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const projectParam = {
  type: 'object',
  required: ['projectId'],
  properties: { projectId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const owner = (request: { headers: Record<string, unknown> }): string =>
  resolveCallerOwnerRef(request as never);

function badRequest(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.status(400).send({ error: { code, message } });
}

export function registerVerificationRoutes(
  app: FastifyInstance,
  deps: VerificationRouteDeps,
): void {
  const { verification, projects } = deps;
  const access = createProjectAccess(projects);

  const notFound = (reply: FastifyReply): FastifyReply =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'That run was not found.' } });

  app.get('/api/verification/capabilities', async () => ({
    capabilities: {
      operations: VERIFICATION_OPERATIONS,
      execution: verification.execution,
      durable: verification.durable,
      limits: {
        maxOperationsPerRun: 6,
        hardCeiling: 8,
        maxRepairAttempts: 2,
      },
      notes: [
        'A verification run records only what a command produced. Nothing is simulated.',
        verification.execution.providesOsIsolation
          ? 'The configured runtime reports operating-system isolation.'
          : 'The configured runtime provides process containment only, not operating-system isolation.',
      ],
    },
  }));

  app.get(
    '/api/verification/projects/:projectId/profile',
    { schema: { params: projectParam } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      try {
        const result = await verification.profile({ projectId });
        return reply.send({ profile: result.profile, revision: result.revision });
      } catch (error) {
        return badRequest(
          reply,
          'VERIFICATION_PROFILE_UNAVAILABLE',
          error instanceof Error ? error.message : 'The project could not be read.',
        );
      }
    },
  );

  app.post('/api/verification/runs', async (request, reply) => {
    const caller = owner(request);
    const body = (request.body ?? {}) as {
      projectId?: unknown;
      operations?: unknown;
      path?: unknown;
      taskId?: unknown;
      workerId?: unknown;
      attempt?: unknown;
      repairsRunId?: unknown;
    };
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    if (projectId === '') {
      return badRequest(reply, 'PROJECT_REQUIRED', 'A projectId is required.');
    }
    if (!(await access.ownsProject(caller, projectId))) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'That project was not found.' } });
    }
    if (!Array.isArray(body.operations) || body.operations.length === 0) {
      return badRequest(
        reply,
        'OPERATIONS_REQUIRED',
        `Name at least one operation: ${VERIFICATION_OPERATIONS.join(', ')}.`,
      );
    }
    const operations = body.operations.map((entry) => String(entry));
    const unknown = operations.filter(
      (operation) => !(VERIFICATION_OPERATIONS as readonly string[]).includes(operation),
    );
    if (unknown.length > 0) {
      return badRequest(
        reply,
        'OPERATION_UNKNOWN',
        `These operations do not exist: ${unknown.join(', ')}.`,
      );
    }

    try {
      const run = await verification.runner.run({
        ownerRef: caller,
        projectId,
        operations,
        path: typeof body.path === 'string' ? body.path : null,
        taskId: typeof body.taskId === 'string' ? body.taskId : null,
        workerId: typeof body.workerId === 'string' ? body.workerId : null,
        repairsRunId: typeof body.repairsRunId === 'string' ? body.repairsRunId : null,
        attempt: typeof body.attempt === 'number' ? body.attempt : 0,
      });
      return reply.status(201).send({ run });
    } catch (error) {
      return badRequest(
        reply,
        'VERIFICATION_RUN_FAILED',
        error instanceof Error ? error.message : 'The run could not be started.',
      );
    }
  });

  app.get('/api/verification/runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const runs = await verification.store.list(owner(request), {
      ...(typeof query.projectId === 'string' ? { projectId: query.projectId } : {}),
      ...(typeof query.taskId === 'string' ? { taskId: query.taskId } : {}),
      ...(typeof query.workerId === 'string' ? { workerId: query.workerId } : {}),
      ...(typeof query.status === 'string' ? { status: query.status as never } : {}),
      ...(typeof query.limit === 'string' ? { limit: Number.parseInt(query.limit, 10) || 50 } : {}),
    });
    return { runs };
  });

  app.get(
    '/api/verification/runs/:runId',
    { schema: { params: runParam } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = await verification.store.get(owner(request), runId);
      return run === null ? notFound(reply) : reply.send({ run });
    },
  );

  app.post(
    '/api/verification/runs/:runId/cancel',
    { schema: { params: runParam } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = await verification.runner.cancel(owner(request), runId);
      return run === null ? notFound(reply) : reply.send({ run });
    },
  );

  app.get(
    '/api/verification/runs/:runId/diagnosis',
    { schema: { params: runParam } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = await verification.store.get(owner(request), runId);
      if (run === null) return notFound(reply);
      const { buildDiagnosis } = await import('@veltravia/verification-core');
      return reply.send({ diagnosis: buildDiagnosis(run) });
    },
  );

  app.get(
    '/api/verification/runs/:runId/compare',
    { schema: { params: runParam } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const query = (request.query ?? {}) as { against?: unknown };
      if (typeof query.against !== 'string') {
        return badRequest(reply, 'COMPARISON_TARGET_REQUIRED', 'Pass ?against=<runId>.');
      }
      const [current, previous] = await Promise.all([
        verification.store.get(owner(request), runId),
        verification.store.get(owner(request), query.against),
      ]);
      if (current === null || previous === null) return notFound(reply);
      const { compareRuns } = await import('@veltravia/verification-core');
      return reply.send({ comparison: compareRuns(previous, current) });
    },
  );
}
