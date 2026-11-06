/**
 * Stored execution records.
 *
 * A run is a live state machine - an in-flight model call, a sandbox, an
 * approval that has to be answered by a person - so its control surface stays
 * in the process that started it. The RECORD of a run is different: what it
 * was asked to do, its status, its approvals, its report and its findings all
 * survive a restart, and this is where they are read back from.
 *
 * Two rules carry over unchanged:
 *  - records are owner-scoped by the database, so one owner cannot read
 *    another's runs, and a foreign id answers exactly like a missing one;
 *  - no record here holds provider credentials or chain-of-thought. The stored
 *    body is the same scrubbed view the API already returns.
 */

import type { FastifyInstance } from 'fastify';

import { type DurableState, type RunViewLike } from '../durable-state.js';
import { resolveCallerOwnerRef } from '../project-access.js';

/** Kinds a record can have. Closed on purpose: an unknown kind is a 404. */
const KINDS = ['agent', 'coding', 'testing', 'app-testing'] as const;
type RunKind = (typeof KINDS)[number];

function isKind(value: unknown): value is RunKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

export interface RunRecordRouteOptions {
  readonly durable: DurableState;
}

export function registerRunRecordRoutes(
  app: FastifyInstance,
  options: RunRecordRouteOptions,
): void {
  const { durable } = options;

  /**
   * Truthful about what this is: a record of a run, not a live run. `live`
   * says whether the process that owns the run can still be asked about it.
   */
  app.get('/api/run-records', async (request, reply) => {
    const owner = resolveCallerOwnerRef(request);
    const query = request.query as { kind?: unknown; projectId?: unknown; status?: unknown };
    const kind = query.kind === undefined ? 'coding' : query.kind;
    if (!isKind(kind)) {
      return reply.status(400).send({
        error: { code: 'RUN_RECORD_KIND_INVALID', message: 'Unknown run kind.' },
      });
    }
    const records = await durable.storedRuns(kind, {
      ...(typeof query.projectId === 'string' ? { projectId: query.projectId } : {}),
      ...(typeof query.status === 'string' ? { status: query.status } : {}),
      limit: 50,
    });
    return {
      owner,
      kind,
      recordCount: records.length,
      records: records.map((record) => ({
        kind: record.kind,
        runId: record.id,
        projectId: record.projectId,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        view: record.body.view ?? null,
      })),
      persistence: 'postgres',
    };
  });

  app.get('/api/run-records/:kind/:runId', async (request, reply) => {
    const owner = resolveCallerOwnerRef(request);
    const { kind, runId } = request.params as { kind: string; runId: string };
    if (!isKind(kind)) {
      return reply.status(404).send({
        error: { code: 'RUN_RECORD_NOT_FOUND', message: 'That run was not found.' },
      });
    }
    const record = await durable.storedRun(kind, runId);
    if (record === null) {
      // Same answer for "never existed" and "belongs to someone else".
      return reply.status(404).send({
        error: { code: 'RUN_RECORD_NOT_FOUND', message: 'That run was not found.' },
      });
    }
    return {
      owner,
      kind: record.kind,
      runId: record.id,
      projectId: record.projectId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      view: (record.body.view ?? null) as RunViewLike | null,
      // The live control surface (cancel, approve) belongs to the process that
      // started the run; a stored record is history.
      live: false,
      persistence: 'postgres',
    };
  });
}
