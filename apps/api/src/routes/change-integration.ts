/**
 * Change integration routes (Step 46).
 *
 * The order these endpoints imply is the safety property: a worker's proposal
 * is recorded, then analysed, then approved, then integrated. Nothing here
 * integrates a set that was never approved, and nothing here reports a pass
 * that no command produced.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  IntegrationError,
  integrationHttpStatus,
  type ChangeSetDraft,
} from '@veltravia/change-integration-core';
import type { SourceRepositoryManager } from '@veltravia/source-storage-core';
import type { ProjectEngine } from '@veltravia/project-core';

import type { ChangeIntegrationService } from '../change-integration-service.js';
import { resolveCallerOwnerRef } from '../project-access.js';
import { firstWorkspaceId, type WorkerStagingRegistry } from '../worker-staging.js';
import type { WorkerService } from '../worker-service.js';

export interface ChangeIntegrationRouteDeps {
  readonly changeIntegration: ChangeIntegrationService;
  readonly source: SourceRepositoryManager;
  readonly projects: ProjectEngine;
  readonly staging: WorkerStagingRegistry;
  readonly workers: WorkerService;
}

function owner(request: { headers: Record<string, unknown> }): string {
  return resolveCallerOwnerRef(request as never);
}

function failure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof IntegrationError) {
    return reply
      .status(integrationHttpStatus(error.code))
      .send({ error: { code: error.code, message: error.message, detail: error.detail } });
  }
  const message = error instanceof Error ? error.message : 'The request failed.';
  return reply.status(500).send({ error: { code: 'CHANGE_INTEGRATION_FAILED', message } });
}

export function registerChangeIntegrationRoutes(
  app: FastifyInstance,
  deps: ChangeIntegrationRouteDeps,
): void {
  const manager = deps.changeIntegration.manager;

  app.get('/api/change-integration/capabilities', async () => ({
    durability: deps.changeIntegration.durability,
    verification: deps.changeIntegration.canVerify ? 'available' : 'unavailable',
    limits: {
      maxFilesPerChangeSet: 200,
      maxChangeSetsPerIntegration: 16,
    },
    behaviour: {
      workerWritesIsolated: true,
      requiresPrimaryAgentApproval: true,
      requiresSnapshotBeforeWrite: true,
      automaticMerge: false,
    },
  }));

  // ---- change sets -------------------------------------------------------

  app.post('/api/change-sets', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Partial<ChangeSetDraft> & {
        projectId?: string;
        baseRevision?: number;
        files?: ChangeSetDraft['files'];
      };
      if (typeof body.projectId !== 'string' || body.projectId.length === 0) {
        return reply.status(400).send({
          error: { code: 'CHANGE_SET_PROJECT_REQUIRED', message: 'projectId is required.' },
        });
      }
      if (typeof body.baseRevision !== 'number' || !Number.isFinite(body.baseRevision)) {
        return reply.status(400).send({
          error: {
            code: 'CHANGE_SET_BASE_REVISION_REQUIRED',
            message: 'baseRevision is required: a proposal is always anchored to a revision.',
          },
        });
      }
      if (!Array.isArray(body.files)) {
        return reply
          .status(400)
          .send({ error: { code: 'CHANGE_SET_FILES_REQUIRED', message: 'files is required.' } });
      }
      const changeSet = await manager.createChangeSet(owner(request), {
        projectId: body.projectId,
        baseRevision: body.baseRevision,
        files: body.files,
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
        ...(body.workerId === undefined ? {} : { workerId: body.workerId }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.deliverables === undefined ? {} : { deliverables: body.deliverables }),
        ...(body.authorization === undefined ? {} : { authorization: body.authorization }),
        ...(body.verification === undefined ? {} : { verification: body.verification }),
      });
      return reply.status(201).send({ changeSet });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/change-sets', async (request, reply) => {
    try {
      const query = request.query as { projectId?: string; status?: string; limit?: string };
      const statuses = query.status
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) as ChangeSetDraft extends never ? never : never;
      const rows = await manager.listChangeSets(owner(request), {
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(statuses === undefined ? {} : { status: statuses as never }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return reply.send({ changeSets: rows });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/change-sets/:changeSetId', async (request, reply) => {
    try {
      const { changeSetId } = request.params as { changeSetId: string };
      const changeSet = await manager.getChangeSet(owner(request), changeSetId);
      const validation = await manager.validate(owner(request), changeSetId);
      return reply.send({
        changeSet,
        validation: validation.validation,
        currentRevision: validation.currentRevision,
      });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/change-sets/analyze', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { projectId?: string; changeSetIds?: string[] };
      if (typeof body.projectId !== 'string' || !Array.isArray(body.changeSetIds)) {
        return reply.status(400).send({
          error: {
            code: 'CHANGE_SET_ANALYSIS_INVALID',
            message: 'projectId and changeSetIds are required.',
          },
        });
      }
      const analysis = await manager.analyze({
        ownerRef: owner(request),
        projectId: body.projectId,
        changeSetIds: body.changeSetIds,
      });
      return reply.send(analysis);
    } catch (error) {
      return failure(reply, error);
    }
  });

  // ---- worker staging ----------------------------------------------------

  /**
   * Records what a worker staged as a reviewable change set.
   *
   * The worker's own workspace is the source; the project is not touched here
   * and the response says the set is open, not integrated.
   */
  app.post('/api/workers/:workerId/change-set', async (request, reply) => {
    try {
      const caller = owner(request);
      const { workerId } = request.params as { workerId: string };
      const worker = await deps.workers.manager.get(caller, workerId);
      if (worker.status !== 'awaiting_review' && worker.status !== 'completed') {
        return reply.status(409).send({
          error: {
            code: 'WORKER_NOT_REVIEWABLE',
            message: `A worker in ${worker.status} has no reviewable changes.`,
          },
        });
      }
      const area = deps.staging.get(workerId);
      if (area === null || area.files.size === 0) {
        return reply.status(409).send({
          error: {
            code: 'WORKER_NO_STAGED_CHANGES',
            message: 'That worker did not stage any file changes.',
          },
        });
      }
      const workspaceId =
        area.mainWorkspaceId ??
        (worker.taskId === null ? null : await firstWorkspaceId(deps.projects, area.projectId));
      if (workspaceId === null) {
        return reply.status(409).send({
          error: { code: 'WORKER_NO_WORKSPACE', message: 'That project has no workspace.' },
        });
      }
      const changeSet = await manager.createChangeSet(caller, {
        projectId: area.projectId,
        workspaceId,
        baseRevision: area.baseRevision,
        taskId: area.taskId,
        workerId: area.workerId,
        title: `Changes from ${worker.workerType} worker`,
        files: Array.from(area.files.values()).map((file) => ({
          path: file.path,
          op: file.op,
          baseHash: file.baseHash,
          content: file.content,
        })),
        authorization: {
          allowedPaths: [...area.allowedPaths],
          excludedPaths: [...area.excludedPaths],
          allowedTools: [...area.allowedTools],
        },
      });
      const validation = await manager.validate(caller, changeSet.id);
      return reply.status(201).send({
        changeSet,
        validation: validation.validation,
      });
    } catch (error) {
      return failure(reply, error);
    }
  });

  // ---- approvals ---------------------------------------------------------

  app.post('/api/integration/approvals', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        projectId?: string;
        changeSetIds?: string[];
        decision?: 'approve' | 'reject';
        rationale?: string;
        verificationRequired?: boolean;
      };
      if (
        typeof body.projectId !== 'string' ||
        !Array.isArray(body.changeSetIds) ||
        (body.decision !== 'approve' && body.decision !== 'reject')
      ) {
        return reply.status(400).send({
          error: {
            code: 'INTEGRATION_APPROVAL_INVALID',
            message: 'projectId, changeSetIds and decision (approve|reject) are required.',
          },
        });
      }
      const approval = await manager.recordApproval({
        ownerRef: owner(request),
        projectId: body.projectId,
        changeSetIds: body.changeSetIds,
        decision: body.decision,
        actor: 'primary-agent',
        rationale:
          body.rationale ??
          (body.decision === 'approve'
            ? 'Reviewed the change sets and their conflicts.'
            : 'Declined to integrate these change sets.'),
        ...(body.verificationRequired === undefined
          ? {}
          : { verificationRequired: body.verificationRequired }),
      });
      return reply.status(201).send({ approval });
    } catch (error) {
      return failure(reply, error);
    }
  });

  // ---- integration -------------------------------------------------------

  app.post('/api/integration/run', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        projectId?: string;
        changeSetIds?: string[];
        approvalId?: string;
        operations?: string[];
      };
      if (
        typeof body.projectId !== 'string' ||
        !Array.isArray(body.changeSetIds) ||
        typeof body.approvalId !== 'string'
      ) {
        return reply.status(400).send({
          error: {
            code: 'INTEGRATION_REQUEST_INVALID',
            message: 'projectId, changeSetIds and approvalId are required.',
          },
        });
      }
      const result = await manager.integrate({
        ownerRef: owner(request),
        projectId: body.projectId,
        changeSetIds: body.changeSetIds,
        approvalId: body.approvalId,
        ...(body.operations === undefined ? {} : { operations: body.operations }),
      });
      return reply.status(201).send(result);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/integration/records', async (request, reply) => {
    try {
      const query = request.query as { projectId?: string; limit?: string };
      const records = await manager.listIntegrations(owner(request), {
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return reply.send({ records });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/integration/records/:integrationId', async (request, reply) => {
    try {
      const { integrationId } = request.params as { integrationId: string };
      const record = await manager.getIntegration(owner(request), integrationId);
      return reply.send({ record });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/integration/records/:integrationId/rollback', async (request, reply) => {
    try {
      const { integrationId } = request.params as { integrationId: string };
      const body = (request.body ?? {}) as { reason?: string };
      const record = await manager.rollback({
        ownerRef: owner(request),
        integrationId,
        actor: 'primary-agent',
        reason: body.reason ?? 'Reverted by the Primary Agent.',
      });
      return reply.send({ record });
    } catch (error) {
      return failure(reply, error);
    }
  });

  /**
   * Recovery for integrations left mid-flight by a restart.
   *
   * Never guesses: an interrupted write is restored from its snapshot and the
   * record says so.
   */
  app.post('/api/integration/recover', async (request, reply) => {
    try {
      const recovered = await manager.recoverInterrupted(owner(request));
      return reply.send({ recovered });
    } catch (error) {
      return failure(reply, error);
    }
  });
}

export type { SourceRepositoryManager };
