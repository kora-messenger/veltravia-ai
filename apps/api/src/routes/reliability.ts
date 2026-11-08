/**
 * Reliability routes (Step 51).
 *
 * Four reads and one deliberate action:
 *  - the health snapshot, which says what is stored and names its evidence;
 *  - the recovery decisions this process (or a database) recorded;
 *  - the capabilities, so the dashboard knows the limits it is looking at;
 *  - the outstanding side effects and keyed requests, for an operator;
 *  - a sweep, which is the one route that changes anything, and it only asks the
 *    existing engines what state their records are in.
 *
 * A sweep is safe to call often: it takes a lease per execution, skips what
 * another process is holding, and does nothing to a finished execution.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { ReliabilityError } from '@veltravia/reliability-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { RELIABILITY_CAPABILITIES, type ReliabilityService } from '../reliability-service.js';

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReliabilityError) {
    return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerReliabilityRoutes(
  app: FastifyInstance,
  deps: { readonly reliability: ReliabilityService },
): void {
  const reliability = deps.reliability;

  app.get('/api/reliability/capabilities', async () => ({
    capabilities: {
      ...RELIABILITY_CAPABILITIES,
      durable: reliability.durable,
      holder: reliability.holder,
    },
  }));

  app.get('/api/reliability/health', async (request, reply) => {
    const ownerRef = resolveCallerOwnerRef(request);
    try {
      return { health: await reliability.health(ownerRef) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/reliability/recoveries', async (request, reply) => {
    const ownerRef = resolveCallerOwnerRef(request);
    const query = request.query as { executionId?: string; limit?: string };
    try {
      return {
        recoveries: await reliability.decisions(ownerRef, query.executionId),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** What a sweep would and did decide. The dashboard reads this after a run. */
  app.post('/api/reliability/sweep', async (request, reply) => {
    const ownerRef = resolveCallerOwnerRef(request);
    try {
      const result = await reliability.sweep(ownerRef);
      return {
        sweep: {
          examined: result.examined,
          skipped: result.skipped,
          recoveredWorkers: result.recoveredWorkers,
          decisions: result.decisions.map((decision) => ({
            executionId: decision.executionId,
            action: decision.action,
            reason: decision.reason,
            evidence: decision.evidence,
            ownerAction: decision.ownerAction,
          })),
        },
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/reliability/keys', async (request, reply) => {
    const ownerRef = resolveCallerOwnerRef(request);
    const query = request.query as { scope?: string; status?: string };
    try {
      const statuses = (query.status ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry): entry is 'in_progress' | 'completed' | 'failed' =>
          ['in_progress', 'completed', 'failed'].includes(entry),
        );
      const records = await reliability.guard.list(ownerRef, {
        scope: query.scope,
        status: statuses.length === 0 ? undefined : statuses,
      });
      return {
        keys: records.map((record) => ({
          scope: record.scope,
          keyHint: `${record.key.slice(0, 4)}…`,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          expiresAt: record.expiresAt,
          fingerprint: record.fingerprint.slice(0, 12),
          failure: record.failure,
        })),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/reliability/events', async (request, reply) => {
    const ownerRef = resolveCallerOwnerRef(request);
    const query = request.query as { topic?: string; status?: string };
    try {
      const statuses = (query.status ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry): entry is 'pending' | 'processed' | 'failed' =>
          ['pending', 'processed', 'failed'].includes(entry),
        );
      const events = await reliability.inbox.list(ownerRef, {
        topic: query.topic,
        status: statuses.length === 0 ? undefined : statuses,
      });
      return {
        events: events.map((event) => ({
          eventKey: event.eventKey,
          topic: event.topic,
          status: event.status,
          attempts: event.attempts,
          lastError: event.lastError,
          receivedAt: event.receivedAt,
          processedAt: event.processedAt,
          availableAt: event.availableAt,
        })),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
