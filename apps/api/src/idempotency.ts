/**
 * The `Idempotency-Key` request hook.
 *
 * A client that retries a POST after a dropped connection must not create a
 * second execution, a second plan revision or a second integration. The client
 * sends `Idempotency-Key`; the first request runs, its answer is stored, and a
 * retry with the same key and the same body is answered from the store.
 *
 * Only mutating methods are guarded, and only when a key is present: a GET is
 * already safe to repeat, and demanding a key from every existing caller would
 * break the app for no benefit.
 *
 * The refusals are deliberately different:
 *  - same key, different body  -> 422, because the caller reused a key by mistake;
 *  - same key, still running   -> 409, because the answer does not exist yet;
 *  - same key, stored answer   -> replay, marked `Idempotent-Replay: true`, so a
 *    replay is visible rather than silently indistinguishable from fresh work;
 *  - a server failure          -> the key is released, so the retry is real work
 *    rather than a replay of an error.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { IdempotencyGuard, IdempotencyRecord } from '@veltravia/reliability-core';
import { fingerprintRequest } from '@veltravia/reliability-core';

import { resolveCallerOwnerRef } from './project-access.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

const GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Which routes accept a key. Everything else behaves exactly as before. */
export const GUARDED_PREFIXES = [
  '/api/executions',
  '/api/integration',
  '/api/change-sets',
  '/api/recovery',
  '/api/tasks',
  '/api/workers',
  '/api/verification',
] as const;

type ClaimedRequest = FastifyRequest & { idempotencyClaim?: IdempotencyRecord };

function headerKey(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, 200);
}

function guardedPath(url: string): string | null {
  const path = url.split('?')[0] ?? url;
  return GUARDED_PREFIXES.some((prefix) => path.startsWith(prefix)) ? path : null;
}

/**
 * Register the hook. `guardFor` returns the guard for one owner, so the key is
 * namespaced per owner by construction: one owner's key can never address
 * another owner's stored answer.
 */
export function registerIdempotency(
  app: FastifyInstance,
  guardFor: (ownerRef: string) => IdempotencyGuard,
): void {
  app.addHook('preHandler', async (request, reply) => {
    if (!GUARDED_METHODS.has(request.method)) return;
    const key = headerKey(request);
    if (key === null) return;
    const path = guardedPath(request.url);
    if (path === null) return;

    let fingerprint: string;
    try {
      fingerprint = fingerprintRequest(request.body ?? null);
    } catch {
      // A body that cannot be fingerprinted is left unguarded rather than guessed
      // at; being unable to hash it is not a reason to refuse the request.
      return;
    }

    const ownerRef = resolveCallerOwnerRef(request);
    const guard = guardFor(ownerRef);
    const outcome = await guard.begin({
      ownerRef,
      scope: `${request.method} ${path}`,
      key,
      fingerprint,
    });

    if (outcome.outcome === 'claimed') {
      (request as ClaimedRequest).idempotencyClaim = outcome.record;
      return;
    }

    if (outcome.outcome === 'replay') {
      const stored = outcome.record.response;
      // A replay says so, and never pretends to be fresh work.
      return reply
        .code(stored?.status ?? 200)
        .header('Idempotent-Replay', 'true')
        .header('Idempotency-Origin', outcome.record.createdAt)
        .send(stored?.body ?? {});
    }

    if (outcome.outcome === 'conflict') {
      return reply.code(422).send({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'This Idempotency-Key was already used for a different request body. Use a new key for a new request.',
        },
      });
    }

    return reply.code(409).send({
      error: {
        code: 'IDEMPOTENCY_IN_FLIGHT',
        message:
          'A request with this Idempotency-Key is still running. Wait for it to finish, then read the result.',
      },
    });
  });

  /**
   * Store the answer once it is known. A 5xx releases the key: nothing was
   * applied, and a retry should do the work rather than replay an error.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    const claim = (request as ClaimedRequest).idempotencyClaim;
    if (claim === undefined) return payload;
    const guard = guardFor(claim.ownerRef);
    const status = reply.statusCode;

    if (status >= 500) {
      await guard
        .fail(claim, {
          code: 'SERVER_ERROR',
          message: 'The request failed before it completed.',
        })
        .catch(() => undefined);
      return payload;
    }

    await guard.complete(claim, { status, body: parsePayload(payload) }).catch(() => undefined);
    return payload;
  });
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload ?? null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}
