import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { GatewayError, isGatewayError } from '@veltravia/ai-gateway';
import { isTaskCategory } from '@veltravia/ai-router';
import type { AiExecutionService, ExecutionEvent } from '../ai-execution-service.js';
import type { MessageCreditService } from '../message-credit-service.js';
import type { InfrastructureMetering } from '../infrastructure-metering.js';
import { messageCreditErrorBody } from './message-credits.js';
/** Local env read: this route does not reach into another route module. */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Real-model execution routes (Step 29).
 *
 * `POST /api/ai/execute` runs one task through router -> gateway. With an
 * `Accept: text/event-stream` (or `?stream=1`) it answers with server-sent
 * events; otherwise it waits and returns the finished run as JSON. Both modes
 * describe the same run and the same events, so a client can fall back without
 * changing what it means.
 *
 * A closed connection cancels the run: continuing to bill a provider for an
 * answer nobody is listening to would be indefensible.
 */

export interface AiExecutionDeps {
  readonly service: AiExecutionService;
  /**
   * Step 54: when present, a chat turn holds message credit before the provider
   * is called and settles it when the run reports usage. Absent means this
   * deployment charges nothing for messages, which is the development default.
   */
  readonly messageCredits?: MessageCreditService | undefined;
  /** Step 57: realtime connection metering for a streaming chat answer. */
  readonly metering?: InfrastructureMetering | undefined;
}

function ownerOf(request: FastifyRequest): string {
  const header = request.headers['x-veltravia-owner-ref'] ?? request.headers['x-veltravia-owner'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 256);
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
}

const EXECUTE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['task'],
  properties: {
    task: { type: 'string', minLength: 1, maxLength: 20_000 },
    category: { type: 'string', maxLength: 64 },
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    connectionId: { type: 'string', minLength: 1, maxLength: 128 },
    modelId: { type: 'string', minLength: 1, maxLength: 128 },
    system: { type: 'string', maxLength: 20_000 },
    maxOutputTokens: { type: 'integer', minimum: 1, maximum: 8_192 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    stream: { type: 'boolean' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    conversationId: { type: 'string', minLength: 1, maxLength: 128 },
    history: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string', minLength: 1, maxLength: 20_000 },
        },
      },
    },
  },
} as const;

function errorBody(error: unknown): { status: number; body: unknown } {
  if (isGatewayError(error)) {
    const status =
      error.code === 'GATEWAY_INVALID_REQUEST'
        ? 400
        : error.code === 'GATEWAY_NO_PROVIDER_CONFIGURED'
          ? 503
          : error.code === 'GATEWAY_ROUTE_UNAVAILABLE'
            ? 409
            : error.code === 'GATEWAY_CONTEXT_TOO_LARGE'
              ? 413
              : error.code === 'GATEWAY_ABORTED' || error.code === 'GATEWAY_RUN_NOT_CANCELLABLE'
                ? 409
                : error.code === 'GATEWAY_LIMIT_EXCEEDED'
                  ? 429
                  : error.code === 'GATEWAY_CONNECTION_NOT_FOUND' ||
                      error.code === 'GATEWAY_RUN_NOT_FOUND'
                    ? 404
                    : 502;
    return {
      status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'AI_EXECUTION_INTERNAL', message: 'Unexpected failure.' } },
  };
}

export function registerAiExecutionRoutes(app: FastifyInstance, deps: AiExecutionDeps): void {
  const service = deps.service;

  /** What this deployment can actually do, before a request is made. */
  app.get('/api/ai/execution', async () => ({
    ready: service.ready,
    blockedReason: service.blockedReason,
    categories: [
      'general-conversation',
      'complex-reasoning',
      'coding',
      'document-analysis',
      'cross-source-intelligence',
      'web-research',
      'structured-data-extraction',
    ],
    limits: { maxOutputTokens: 8_192, maxHistoryMessages: 20 },
    transport: 'server-sent events',
    note: 'Models are chosen by the platform router. A refusal is returned as-is; this surface never substitutes another provider.',
  }));

  /** Usage history: provider, model, tokens and cost provenance, owner-scoped. */
  app.get('/api/ai/execution/usage', async (request) => {
    const query = request.query as { limit?: string } | undefined;
    const limit = Math.min(Math.max(Number(query?.limit ?? 20) || 20, 1), 100);
    return { records: await service.usageHistory(ownerOf(request), limit) };
  });

  app.get('/api/ai/execution/runs', async (request) => {
    const query = request.query as { limit?: string } | undefined;
    const limit = Math.min(Math.max(Number(query?.limit ?? 20) || 20, 1), 100);
    return { runs: service.list(ownerOf(request), limit) };
  });

  app.get('/api/ai/execution/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { since?: string } | undefined;
    const since = Math.max(Number(query?.since ?? 0) || 0, 0);
    try {
      return {
        run: service.snapshot(ownerOf(request), runId),
        events: service.eventsFor(ownerOf(request), runId, since),
      };
    } catch (error) {
      const mapped = errorBody(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/ai/execution/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      const run = service.cancel(ownerOf(request), runId);
      return { run };
    } catch (error) {
      const mapped = errorBody(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/ai/execute', { schema: { body: EXECUTE_BODY } }, async (request, reply) => {
    const owner = ownerOf(request);
    const body = request.body as {
      task: string;
      category?: string;
      projectId?: string;
      connectionId?: string;
      modelId?: string;
      system?: string;
      maxOutputTokens?: number;
      temperature?: number;
      stream?: boolean;
      idempotencyKey?: string;
      conversationId?: string;
      history?: readonly { role: 'user' | 'assistant'; content: string }[];
    };
    const query = request.query as { stream?: string } | undefined;
    const wantsStream =
      query?.stream === '1' ||
      query?.stream === 'true' ||
      (request.headers.accept ?? '').includes('text/event-stream');

    if (body.category !== undefined && !isTaskCategory(body.category)) {
      return reply.status(400).send({
        error: {
          code: 'GATEWAY_INVALID_REQUEST',
          message: `Unknown task category: ${body.category}`,
        },
      });
    }

    /*
     * Step 54: hold the message credit first. A refusal here is the only place a
     * request is stopped for money, and it stops before any provider call, so a
     * request nobody can pay for costs nobody anything. The prompt is not
     * discarded by the server: the caller still has it and the refusal says what
     * is missing.
     */
    let hold: { charge: { id: string } } | null = null;
    if (deps.messageCredits !== undefined) {
      try {
        hold = await deps.messageCredits.reserve({
          ownerRef: owner,
          kind: 'chat.message',
          // The gateway calls the caller's own provider key, so the provider's
          // tokens are theirs: only the platform's charge is owed here.
          byok: true,
          idempotencyKey: `chat:${body.idempotencyKey ?? randomUUID()}`,
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
        });
      } catch (error) {
        const mapped = messageCreditErrorBody(error);
        return reply.status(mapped.status).send(mapped.body);
      }
    }

    let started: ReturnType<AiExecutionService['start']>;
    try {
      started = service.start({
        ownerRef: owner,
        task: body.task,
        category: (body.category ?? 'general-conversation') as never,
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.connectionId !== undefined ? { connectionId: body.connectionId } : {}),
        ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
        ...(body.system !== undefined ? { system: body.system } : {}),
        ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.stream !== undefined ? { stream: body.stream } : {}),
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
        ...(body.history !== undefined ? { history: body.history } : {}),
      });
    } catch (error) {
      if (hold !== null && deps.messageCredits !== undefined) {
        await deps.messageCredits
          .release({
            ownerRef: owner,
            chargeId: hold.charge.id,
            reason: 'The provider refused to start the run.',
          })
          .catch(() => undefined);
      }
      const mapped = errorBody(error);
      return reply.status(mapped.status).send(mapped.body);
    }

    if (hold !== null && deps.messageCredits !== undefined) {
      // From here the charge is findable by run id, which is how the usage hook
      // settles exactly the right hold.
      await deps.messageCredits
        .attachRun({ ownerRef: owner, chargeId: hold.charge.id, runId: started.run.id })
        .catch(() => undefined);
    }

    if (!wantsStream) {
      const collected: ExecutionEvent[] = [];
      for await (const event of started.events) collected.push(event);
      const run = service.snapshot(owner, started.run.id);
      const status = run.status === 'completed' ? 200 : run.status === 'cancelled' ? 409 : 502;
      if (run.status !== 'completed' && deps.messageCredits !== undefined) {
        await deps.messageCredits
          .releaseForRun({
            ownerRef: owner,
            runId: run.id,
            reason:
              run.status === 'cancelled'
                ? 'The run was cancelled before it was charged.'
                : 'The run failed before it could be charged.',
          })
          .catch(() => undefined);
      }
      return reply.status(status).send({
        run,
        events: collected,
        ...(run.status === 'completed'
          ? {}
          : {
              error: {
                code: run.errorCode ?? 'AI_EXECUTION_FAILED',
                message: run.errorMessage ?? 'The run failed.',
              },
            }),
      });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const runId = started.run.id;
    /*
     * Step 57: a stream this process holds open IS a realtime connection, so it is
     * counted while it lives (the published limit reads this) and recorded when it
     * closes with its duration and how many events it carried.
     */
    const stream = deps.metering?.openStream({ ownerRef: owner, kind: 'chat.stream' }) ?? null;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    };

    // A dropped client cancels the run: no orphaned provider billing.
    request.raw.on('close', () => {
      if (closed) return;
      try {
        service.cancel(owner, runId);
      } catch {
        /* run already finished */
      }
    });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': keep-alive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      for await (const event of started.events) {
        if (closed) break;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        stream?.event();
      }
      // A stream that ends without a completed run holds nobody's credit: the
      // usage hook only settles a run that reported tokens.
      const finalRun = service.snapshot(owner, runId);
      if (finalRun.status !== 'completed' && deps.messageCredits !== undefined) {
        await deps.messageCredits
          .releaseForRun({
            ownerRef: owner,
            runId,
            reason:
              finalRun.status === 'cancelled'
                ? 'The stream was cancelled before the run was charged.'
                : 'The stream ended before the run was charged.',
          })
          .catch(() => undefined);
      }
    } catch (error) {
      const mapped = errorBody(error);
      if (!closed) {
        reply.raw.write(
          `event: run.failed\ndata: ${JSON.stringify({ runId, ...(mapped.body as object) })}\n\n`,
        );
      }
    } finally {
      clearInterval(heartbeat);
      close();
      await stream?.close('stream-ended');
    }
    return reply;
  });
}

export function isAiExecutionError(error: unknown): error is GatewayError {
  return isGatewayError(error);
}
