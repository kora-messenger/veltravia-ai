import type { FastifyInstance } from 'fastify';
import { captureRunEnd, captureRunStart, type RunCaptureHooks } from '../run-captures.js';
import type { AppTestingService } from '../app-testing.js';
import type { TestingManager } from '@veltravia/testing-core';
import type { TestingRunLedger } from '../testing-ownership.js';
import { TestingAccessError } from '../testing-ownership.js';
import { testingOwnerOf, toHttpError } from './testing.js';

/**
 * Application-testing endpoints (Step 39).
 *
 *   POST /api/app-testing/runs                       start a run
 *   GET  /api/app-testing/runs/:runId                status
 *   GET  /api/app-testing/runs/:runId/report         the structured report
 *   GET  /api/app-testing/runs/:runId/tests/:testId  one test result
 *   GET  /api/app-testing/runs/:runId/repair-plan    the proposed repair
 *   POST /api/app-testing/runs/:runId/cancel         cancel
 *
 * Every route resolves the caller from the request headers, and every run is
 * visible only to the owner who started it: someone else's run and a run that
 * does not exist answer identically. There is deliberately NO route that
 * applies a repair or approves a plan. Approval belongs to the existing
 * /api/testing/runs/:runId/approval route, which needs a person, so nothing
 * here can approve itself.
 *
 * Responses carry structure and redacted findings. They never carry file
 * contents, secrets, host paths or model reasoning.
 */

const START_BODY = {
  type: 'object',
  required: ['projectId', 'workspaceId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

const RUN_PARAMS = {
  type: 'object',
  required: ['runId'],
  additionalProperties: false,
  properties: { runId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

const TEST_PARAMS = {
  type: 'object',
  required: ['runId', 'testId'],
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1, maxLength: 128 },
    testId: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

export function registerAppTestingRoutes(
  app: FastifyInstance,
  service: AppTestingService,
  testing: TestingManager,
  ledger: TestingRunLedger,
  captures: RunCaptureHooks = {},
): void {
  app.post(
    '/api/app-testing/runs',
    {
      schema: { body: START_BODY },
      // Fastify coerces a number to a string before the schema is checked, so
      // `{"projectId": 1}` would quietly become "1". Ids are strings; say so.
      preValidation: async (request, reply) => {
        const raw = request.body as Record<string, unknown> | null;
        if (
          raw !== null &&
          typeof raw === 'object' &&
          (typeof raw['projectId'] !== 'string' || typeof raw['workspaceId'] !== 'string')
        ) {
          return reply.code(400).send({
            code: 'TESTING_INVALID_REQUEST',
            message: 'projectId and workspaceId must both be text.',
          });
        }
        return undefined;
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as { projectId: string; workspaceId: string };
        const ownerRef = testingOwnerOf(request);
        await ledger.assertCanStart(ownerRef, body.projectId, body.workspaceId);
        await captureRunStart(captures, 'testing_before_repair', body.projectId, body.workspaceId);
        const started = await service.start({ ownerRef, ...body });
        await captureRunEnd(
          captures,
          'testing_after',
          started.run.projectId,
          started.run.workspaceId,
          started.run.state,
        );
        reply.code(201);
        return {
          runId: started.run.runId,
          state: started.run.state,
          projectId: started.run.projectId,
          workspaceId: started.run.workspaceId,
          inspection: started.inspection,
          proposedTests: started.generatedTests,
          skippedKinds: started.skippedKinds,
          notes: started.notes,
        };
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );

  app.get(
    '/api/app-testing/runs/:runId',
    { schema: { params: RUN_PARAMS } },
    async (request, reply) => {
      try {
        const { runId } = request.params as { runId: string };
        const run = service.status(testingOwnerOf(request), runId);
        return {
          runId: run.runId,
          state: run.state,
          projectId: run.projectId,
          workspaceId: run.workspaceId,
          pendingApproval: run.pendingApproval,
          repairAttempts: run.repairAttempts,
          commandsExecuted: run.commandsExecuted,
          failure: run.failure,
          notes: run.notes,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        };
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );

  app.get(
    '/api/app-testing/runs/:runId/report',
    { schema: { params: RUN_PARAMS } },
    async (request, reply) => {
      try {
        const { runId } = request.params as { runId: string };
        return { report: service.report(testingOwnerOf(request), runId) };
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );

  app.get(
    '/api/app-testing/runs/:runId/tests/:testId',
    { schema: { params: TEST_PARAMS } },
    async (request, reply) => {
      try {
        const { runId, testId } = request.params as { runId: string; testId: string };
        const report = service.report(testingOwnerOf(request), runId);
        const test = report.tests.find((entry) => entry.id === testId);
        if (test === undefined) throw new TestingAccessError();
        const bugs = report.bugs.filter((bug) => bug.source === testId);
        return { test, bugs };
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );

  app.get(
    '/api/app-testing/runs/:runId/repair-plan',
    { schema: { params: RUN_PARAMS } },
    async (request, reply) => {
      try {
        const { runId } = request.params as { runId: string };
        service.status(testingOwnerOf(request), runId);
        const run = testing.getRun(runId);
        return {
          runId,
          state: run.state,
          awaitingApproval: run.state === 'awaiting_repair_approval',
          diagnosis: run.diagnosis,
          repairPlan: run.repairPlan,
          // Approving is a person's decision on the existing approval route.
          approvalRoute: `/api/testing/runs/${runId}/approval`,
        };
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );

  app.post(
    '/api/app-testing/runs/:runId/cancel',
    { schema: { params: RUN_PARAMS } },
    async (request, reply) => {
      try {
        const { runId } = request.params as { runId: string };
        ledger.require(testingOwnerOf(request), runId);
        const run = testing.cancelRun(runId);
        await captureRunEnd(captures, 'testing_after', run.projectId, run.workspaceId, run.state);
        return { runId, state: run.state };
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );
}
