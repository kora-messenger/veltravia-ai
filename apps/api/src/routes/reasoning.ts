import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  REASONING_PROFILES,
  isReasoningError,
  toRunView,
  reasoningHttpStatus,
  type ReasoningProfileId,
} from '@veltravia/reasoning-core';
import { isGatewayError } from '@veltravia/ai-gateway';
import type { ReasoningService } from '../reasoning-service.js';

/**
 * Reasoning routes (Step 27).
 *
 * Every run happens server-side: the model never sees a credential, the tools
 * it may name are filtered before the prompt is built, and a risky tool pauses
 * the run until a human decides. `GET /events` streams the same run the API
 * reports, so the browser renders what the engine actually did instead of
 * guessing.
 */

/**
 * Route-level overrides only. Any code without an entry falls back to the
 * engine's own mapping, so a new engine error can never silently become a 500.
 */
const STATUS: Record<string, number> = {
  REASONING_INVALID_REQUEST: 400,
  REASONING_UNKNOWN_PROFILE: 400,
  REASONING_INVALID_MODEL_OUTPUT: 502,
  REASONING_TOOL_NOT_ALLOWED: 403,
  REASONING_TOOL_UNAVAILABLE: 409,
  REASONING_TOOL_FAILED: 502,
  REASONING_PROVIDER_UNAVAILABLE: 503,
  REASONING_PROVIDER_AUTH_FAILED: 502,
  REASONING_PROVIDER_RATE_LIMITED: 429,
  REASONING_PROVIDER_ERROR: 502,
  REASONING_LIMIT_EXCEEDED: 429,
  REASONING_CANCELLED: 409,
  REASONING_RUN_NOT_FOUND: 404,
  REASONING_RUN_STATE: 409,
  REASONING_CONFIRMATION_INVALID: 409,
  REASONING_CONTEXT_REJECTED: 400,
  REASONING_SECRET_REJECTED: 400,
};

function toError(error: unknown): { status: number; body: unknown } {
  if (isReasoningError(error)) {
    return {
      status: STATUS[error.code] ?? reasoningHttpStatus(error.code),
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (isGatewayError(error)) {
    const status =
      error.code === 'GATEWAY_NO_PROVIDER_CONFIGURED' || error.code === 'GATEWAY_CREDENTIAL_MISSING'
        ? 409
        : error.code === 'GATEWAY_LIMIT_EXCEEDED'
          ? 429
          : 502;
    return {
      status,
      body: {
        error: {
          code: error.code,
          message:
            error.code === 'GATEWAY_NO_PROVIDER_CONFIGURED'
              ? 'Connect an AI provider in Settings before running reasoning.'
              : 'The AI provider could not complete the request.',
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'REASONING_INTERNAL', message: 'Unexpected failure.' } },
  };
}

/**
 * Ownership: the demo build derives the owner from a header instead of real
 * authentication. It is a stand-in for an identity, never a credential; a real
 * deployment reads the owner from the session and ignores the header.
 */
function ownerOf(request: FastifyRequest): string {
  const header = request.headers['x-veltravia-owner-ref'] ?? request.headers['x-veltravia-owner'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 256);
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
}

const RUN_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['task'],
  properties: {
    task: { type: 'string', minLength: 1, maxLength: 8000 },
    profile: { type: 'string', enum: Object.keys(REASONING_PROFILES) },
    mode: { type: 'string', enum: ['gateway', 'simulated'] },
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    connectionId: { type: 'string', minLength: 1, maxLength: 128 },
    modelId: { type: 'string', minLength: 1, maxLength: 128 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    conversation: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string', maxLength: 4000 },
        },
      },
    },
    context: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'label', 'text'],
        properties: {
          kind: { type: 'string', maxLength: 40 },
          label: { type: 'string', maxLength: 200 },
          text: { type: 'string', maxLength: 60000 },
          trust: { type: 'string', enum: ['trusted', 'untrusted_data'] },
          sourceId: { type: 'string', maxLength: 128 },
          ownerRef: { type: 'string', maxLength: 256 },
          projectId: { type: 'string', maxLength: 128 },
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxIterations: { type: 'integer', minimum: 1, maximum: 50 },
        maxToolCalls: { type: 'integer', minimum: 0, maximum: 50 },
        maxDurationMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        maxProviderRetries: { type: 'integer', minimum: 0, maximum: 10 },
        contextBudgetChars: { type: 'integer', minimum: 500, maximum: 200000 },
      },
    },
  },
} as const;

export function registerReasoningRoutes(app: FastifyInstance, service: ReasoningService): void {
  /** Capabilities: profiles, limits, provider state and the tools on offer. */
  app.get('/api/reasoning', async (request) => {
    const ownerRef = ownerOf(request);
    const capabilities = service.capabilities();
    return {
      ...capabilities,
      tools: service.toolSummaries(ownerRef),
      simulatedReasoningAllowed:
        (readEnv('VELTRAVIA_ALLOW_SIMULATED_REASONING') ?? 'true') !== 'false',
    };
  });

  /** Usage: provider, model, tokens the provider reported, and failure category. */
  app.get('/api/reasoning/usage', async (request) => {
    const query = request.query as { limit?: string } | undefined;
    const limit = Math.min(Math.max(Number(query?.limit ?? 20) || 20, 1), 100);
    return { records: service.history(limit) };
  });

  /** Starts a run and returns immediately with its id and status. */
  app.post('/api/reasoning/runs', { schema: { body: RUN_BODY } }, async (request, reply) => {
    const ownerRef = ownerOf(request);
    const body = request.body as {
      task: string;
      profile?: ReasoningProfileId;
      mode?: 'gateway' | 'simulated';
      projectId?: string;
      connectionId?: string;
      modelId?: string;
      idempotencyKey?: string;
      conversation?: { role: 'user' | 'assistant'; content: string }[];
      context?: never;
      limits?: never;
    };

    if (
      (readEnv('VELTRAVIA_ALLOW_SIMULATED_REASONING') ?? 'true') === 'false' &&
      body.mode === 'simulated'
    ) {
      return reply.status(400).send({
        error: {
          code: 'REASONING_INVALID_REQUEST',
          message: 'Simulated reasoning is disabled for this deployment.',
        },
      });
    }

    try {
      const run = await service.start({
        ownerRef,
        task: body.task,
        profile: (body.profile ?? 'workspace') as ReasoningProfileId,
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.connectionId !== undefined ? { connectionId: body.connectionId } : {}),
        ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
        ...(body.conversation !== undefined ? { conversation: body.conversation } : {}),
        ...(body.context !== undefined ? { context: body.context } : {}),
        ...(body.limits !== undefined ? { limits: body.limits } : {}),
      } as Parameters<ReasoningService['start']>[0]);
      return reply.status(202).send({ run: toRunView(run) });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  /** A single run, from the live engine or the finished cache. */
  app.get('/api/reasoning/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await service.getRun({ ownerRef: ownerOf(request), runId });
    if (run === undefined) {
      return reply.status(404).send({
        error: { code: 'REASONING_RUN_NOT_FOUND', message: 'That reasoning run does not exist.' },
      });
    }
    return { run: toRunView(run) };
  });

  /** Cancels a run. Cancellation is one-way; nothing resumes it. */
  app.post('/api/reasoning/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return {
        run: toRunView(await service.cancel({ runId, ownerRef: ownerOf(request) })),
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  /**
   * Carries a run that stopped at its step budget on with a fresh one.
   *
   * 409 when the run did not stop at a budget, or when it has already used every
   * continuation it is allowed: both are states a caller should not retry blindly.
   */
  app.post('/api/reasoning/runs/:runId/continue', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return {
        run: toRunView(await service.continue({ runId, ownerRef: ownerOf(request) })),
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  /** Records a human decision on a paused tool, then continues the run. */
  app.post(
    '/api/reasoning/runs/:runId/confirmation',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['confirmationId', 'decision'],
          properties: {
            confirmationId: { type: 'string', minLength: 1, maxLength: 128 },
            decision: { type: 'string', enum: ['approved', 'rejected'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const body = request.body as { confirmationId: string; decision: 'approved' | 'rejected' };
      try {
        const run = await service.decide({
          runId,
          ownerRef: ownerOf(request),
          confirmationId: body.confirmationId,
          decision: body.decision,
        });
        return { run: toRunView(run) };
      } catch (error) {
        const mapped = toError(error);
        return reply.status(mapped.status).send(mapped.body);
      }
    },
  );

  /**
   * The activity timeline for a run, from a sequence onward.
   *
   * This is what a reconnecting page calls: everything it missed, in order, plus
   * the run's current standing. Owner-scoped like every other run route, so an
   * unknown run and someone else's run are both a 404.
   */
  app.get('/api/reasoning/runs/:runId/activity', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const raw = (request.query as { after?: string }).after;
    const after = raw === undefined ? 0 : Number(raw);
    if (!Number.isInteger(after) || after < 0) {
      return reply.status(400).send({
        error: { code: 'REASONING_INVALID_REQUEST', message: '`after` must be a whole number.' },
      });
    }
    const snapshot = await service.activitySnapshot({ ownerRef: ownerOf(request), runId, after });
    if (snapshot === undefined) {
      return reply.status(404).send({
        error: { code: 'REASONING_RUN_NOT_FOUND', message: 'That reasoning run does not exist.' },
      });
    }
    return reply.send(snapshot);
  });

  /**
   * Server-sent events for the activity timeline.
   *
   * The stream carries only rows the client has not already been given: the
   * server derives the timeline from the run every beat, compares it with what
   * it has sent, and emits the difference. A reconnect therefore resumes from
   * `after` (or the browser's `Last-Event-ID`) without replaying, and without
   * asking the client to work out which status is newer. The run itself is never
   * restarted by a reconnect: this endpoint only reads.
   */
  app.get('/api/reasoning/runs/:runId/activity/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const ownerRef = ownerOf(request);
    if (!service.ownsRun(runId, ownerRef)) {
      return reply.status(404).send({
        error: { code: 'REASONING_RUN_NOT_FOUND', message: 'That reasoning run does not exist.' },
      });
    }
    const queryAfter = Number((request.query as { after?: string }).after ?? 0);
    const headerId = Number(request.headers['last-event-id'] ?? 0);
    let after = Math.max(
      Number.isFinite(queryAfter) && queryAfter > 0 ? queryAfter : 0,
      Number.isFinite(headerId) && headerId > 0 ? headerId : 0,
    );

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const sent = new Map<string, string>();
    let closed = false;

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      clearInterval(watch);
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    };

    const flush = async (): Promise<void> => {
      if (closed) return;
      const snapshot = await service.activitySnapshot({ ownerRef, runId, after: 0 });
      if (snapshot === undefined) {
        write('ended', { runId, reason: 'run_not_found' });
        close();
        return;
      }
      for (const activity of snapshot.activities) {
        if (activity.sequence <= after) continue;
        const seen = sent.get(activity.activityId);
        if (seen === activity.status) continue;
        sent.set(activity.activityId, activity.status);
        after = Math.max(after, activity.sequence);
        write('activity', activity, activity.sequence);
      }
      if (snapshot.terminal) {
        write('final', {
          runId,
          runStatus: snapshot.runStatus,
          terminal: true,
          report: snapshot.report,
        });
        close();
      }
    };

    function write(event: string, data: unknown, id?: number): void {
      try {
        if (id !== undefined) reply.raw.write(`id: ${id}\n`);
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        close();
      }
    }

    // The run is derived, not pushed, so a beat is cheap and cannot miss work
    // between two polls of the same run.
    void flush();
    const watch = setInterval(() => void flush(), 500);
    const beat = setInterval(() => {
      try {
        reply.raw.write(': keep-alive\n\n');
      } catch {
        close();
      }
    }, 15_000);
    if (typeof watch.unref === 'function') watch.unref();
    if (typeof beat.unref === 'function') beat.unref();
    request.raw.on('close', close);

    return reply;
  });

  /**
   * Server-sent events for one run: buffered events replay first, then live
   * ones follow. Clients reconnect with `Last-Event-ID` and receive only what
   * they have not seen, so no delta is duplicated.
   */
  app.get('/api/reasoning/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const lastEventId = Number(request.headers['last-event-id'] ?? 0) || 0;

    if (!service.ownsRun(runId, ownerOf(request))) {
      return reply.status(404).send({
        error: { code: 'REASONING_RUN_NOT_FOUND', message: 'That reasoning run does not exist.' },
      });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const write = (record: { id: number; event: unknown }): void => {
      reply.raw.write(`id: ${record.id}\n`);
      reply.raw.write(`data: ${JSON.stringify(record.event)}\n\n`);
    };

    const unsubscribe = service.subscribe(runId, write, lastEventId);

    const close = (): void => {
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    };

    const timer = setInterval(() => {
      try {
        reply.raw.write(': keep-alive\n\n');
      } catch {
        clearInterval(timer);
        close();
      }
    }, 15_000);
    if (typeof timer.unref === 'function') timer.unref();

    const finish = async (): Promise<void> => {
      const run = await service.getRun({ ownerRef: ownerOf(request), runId });
      if (
        run !== undefined &&
        ['completed', 'failed', 'cancelled', 'limit_reached'].includes(run.status)
      ) {
        clearInterval(timer);
        close();
      }
    };
    request.raw.on('close', () => {
      clearInterval(timer);
      unsubscribe();
    });
    const poll = setInterval(() => void finish(), 1000);
    if (typeof poll.unref === 'function') poll.unref();
    request.raw.on('close', () => clearInterval(poll));

    return reply;
  });
}
