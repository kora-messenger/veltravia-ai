/**
 * Wallet routes (Step 53).
 *
 * Split by who is asking, because the two halves have different rights:
 *
 *  - **The owner's own wallet.** Reading balances, history, holds and the
 *    reconciliation report, plus reserving and releasing credit for their own
 *    work. Every call takes the owner from the request context; a workspace id
 *    narrows the wallet, it never widens access, so another owner's workspace is
 *    a 404 rather than a lookup.
 *  - **Operator work.** Adding credits, adjustments, refunds, reversals and
 *    credit-line policy. None of that is something a caller may do to themselves,
 *    so it requires the deployment's admin token and fails closed with 503 when
 *    no token is configured. The actor name is recorded in the entry.
 *
 * Amounts are validated server-side by the wallet core: a negative, zero,
 * non-finite or over-ceiling number is refused with 400 before any balance is
 * read.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { WalletEntryKind } from '@veltravia/wallet-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { WalletError } from '@veltravia/wallet-core';
import type { WalletService } from '../wallet-service.js';

export interface WalletRouteDeps {
  readonly wallet: WalletService;
}

const KINDS: readonly WalletEntryKind[] = [
  'purchase',
  'grant',
  'promotion',
  'usage_deduction',
  'reservation',
  'reservation_commit',
  'reservation_release',
  'refund',
  'adjustment_credit',
  'adjustment_debit',
  'reversal',
];

const owner = (request: { headers: Record<string, unknown> }): string =>
  resolveCallerOwnerRef(request as never);

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WalletError) {
    return reply.status(error.status).send({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  throw error;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Admin auth, identical in shape to the usage surface: a bearer token compared
 * against the deployment's configured value, and no token configured means the
 * endpoints cannot be used at all rather than being open to anyone.
 */
function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  env: NodeJS.ProcessEnv,
): boolean {
  const expected = env.VELTRAVIA_WALLET_ADMIN_TOKEN ?? env.VELTRAVIA_USAGE_ADMIN_TOKEN;
  if (expected === undefined || expected.trim().length === 0) {
    reply.status(503).send({
      error: 'Operator access is not configured on this deployment.',
      code: 'WALLET_ADMIN_UNAVAILABLE',
    });
    return false;
  }
  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  if (provided.length === 0 || !timingSafeEqual(expectedHash, providedHash)) {
    reply
      .status(403)
      .send({ error: 'Operator access is required.', code: 'WALLET_ADMIN_REQUIRED' });
    return false;
  }
  return true;
}

function actorOf(request: FastifyRequest): string {
  return str(request.headers['x-veltravia-actor']) ?? 'operator';
}

export function registerWalletRoutes(
  app: FastifyInstance,
  deps: WalletRouteDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { wallet } = deps;

  app.get('/api/wallet', async (request, reply) => {
    try {
      const workspaceId = str((request.query as Record<string, unknown>).workspaceId);
      const overview = await wallet.overview({ ownerRef: owner(request), workspaceId });
      return reply.send(overview);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/wallet/transactions', async (request, reply) => {
    try {
      const query = request.query as Record<string, unknown>;
      const kinds = str(query.kind)
        ?.split(',')
        .map((value) => value.trim())
        .filter((value): value is WalletEntryKind => (KINDS as readonly string[]).includes(value));
      const entries = await wallet.history({
        ownerRef: owner(request),
        workspaceId: str(query.workspaceId),
        ...(num(query.limit) === undefined ? {} : { limit: num(query.limit) }),
        ...(kinds === undefined || kinds.length === 0 ? {} : { kinds }),
        ...(num(query.before) === undefined ? {} : { beforeSeq: num(query.before) }),
      });
      return reply.send({
        transactions: entries,
        nextBefore: entries.length === 0 ? null : entries[entries.length - 1]!.seq,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/wallet/reservations', async (request, reply) => {
    try {
      const workspaceId = str((request.query as Record<string, unknown>).workspaceId);
      return reply.send({
        reservations: await wallet.held({ ownerRef: owner(request), workspaceId }),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/wallet/reconcile', async (request, reply) => {
    try {
      const workspaceId = str((request.query as Record<string, unknown>).workspaceId);
      return reply.send(await wallet.reconcile({ ownerRef: owner(request), workspaceId }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/wallet/capabilities', async (_request, reply) => reply.send(wallet.capabilities()));

  app.post('/api/wallet/reservations', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await wallet.reserve({
        ownerRef: owner(request),
        workspaceId: str(body.workspaceId),
        amount: body.amount as number,
        operationKey: body.operationKey as string,
        reason: str(body.reason) ?? 'Credit held for work that is starting.',
        actor: 'owner',
        referenceType: str(body.referenceType),
        referenceId: str(body.referenceId),
        ...(num(body.ttlSeconds) === undefined ? {} : { ttlSeconds: num(body.ttlSeconds) }),
      });
      return reply.status(201).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/wallet/reservations/:id/release', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const params = request.params as { id: string };
      const result = await wallet.release({
        ownerRef: owner(request),
        workspaceId: str(body.workspaceId),
        reservationId: params.id,
        reason: str(body.reason) ?? 'Released without being spent.',
        actor: 'owner',
      });
      return reply.send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/wallet/reservations/:id/commit', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const params = request.params as { id: string };
      const result = await wallet.commit({
        ownerRef: owner(request),
        workspaceId: str(body.workspaceId),
        reservationId: params.id,
        reason: str(body.reason) ?? 'Settled against the work that ran.',
        actor: 'owner',
        ...(num(body.amount) === undefined ? {} : { amount: num(body.amount) }),
      });
      return reply.send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---- operator surface ---------------------------------------------------

  app.post('/api/wallet/credits', async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = str(body.ownerRef);
      if (target === null) {
        return reply
          .status(400)
          .send({ error: 'ownerRef is required for an operator credit.', code: 'OWNER_REQUIRED' });
      }
      const kind = str(body.kind) ?? 'grant';
      if (!['purchase', 'grant', 'promotion'].includes(kind)) {
        return reply
          .status(400)
          .send({ error: 'kind must be purchase, grant or promotion.', code: 'KIND_INVALID' });
      }
      const result = await wallet.credit({
        ownerRef: target,
        workspaceId: str(body.workspaceId),
        amount: body.amount as number,
        kind: kind as 'purchase' | 'grant' | 'promotion',
        reason: str(body.reason) ?? 'Credits added by an operator.',
        actor: actorOf(request),
        idempotencyKey: str(body.idempotencyKey) ?? `operator-credit:${target}:${Date.now()}`,
        referenceType: str(body.referenceType) ?? (kind === 'purchase' ? 'payment' : 'operator'),
        referenceId: str(body.referenceId),
      });
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/wallet/adjustments', async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = str(body.ownerRef);
      const direction = str(body.direction);
      if (target === null) {
        return reply.status(400).send({ error: 'ownerRef is required.', code: 'OWNER_REQUIRED' });
      }
      if (direction !== 'credit' && direction !== 'debit') {
        return reply
          .status(400)
          .send({ error: 'direction must be credit or debit.', code: 'DIRECTION_INVALID' });
      }
      const result = await wallet.adjust({
        ownerRef: target,
        workspaceId: str(body.workspaceId),
        amount: body.amount as number,
        direction,
        reason: str(body.reason) ?? 'Administrative adjustment.',
        actor: actorOf(request),
        idempotencyKey: str(body.idempotencyKey) ?? `operator-adjust:${target}:${Date.now()}`,
      });
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/wallet/refunds', async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = str(body.ownerRef);
      const entryId = str(body.entryId);
      if (target === null || entryId === null) {
        return reply
          .status(400)
          .send({ error: 'ownerRef and entryId are required.', code: 'REFUND_TARGET_REQUIRED' });
      }
      const result = await wallet.refund({
        ownerRef: target,
        workspaceId: str(body.workspaceId),
        entryId,
        reason: str(body.reason) ?? 'Refunded by an operator.',
        actor: actorOf(request),
        idempotencyKey: str(body.idempotencyKey) ?? `operator-refund:${entryId}`,
        ...(num(body.amount) === undefined ? {} : { amount: num(body.amount) }),
      });
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/wallet/reversals', async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = str(body.ownerRef);
      const entryId = str(body.entryId);
      if (target === null || entryId === null) {
        return reply
          .status(400)
          .send({ error: 'ownerRef and entryId are required.', code: 'REVERSAL_TARGET_REQUIRED' });
      }
      const result = await wallet.reverse({
        ownerRef: target,
        workspaceId: str(body.workspaceId),
        entryId,
        reason: str(body.reason) ?? 'Reversed by an operator.',
        actor: actorOf(request),
      });
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/wallet/policy', async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = str(body.ownerRef);
      if (target === null) {
        return reply.status(400).send({ error: 'ownerRef is required.', code: 'OWNER_REQUIRED' });
      }
      const updated = await wallet.setPolicy({
        ownerRef: target,
        workspaceId: str(body.workspaceId),
        allowNegative: body.allowNegative === true,
        negativeFloor: num(body.negativeFloor) ?? 0,
        actor: actorOf(request),
      });
      return reply.send({ wallet: updated });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/wallet/operator/:ownerRef', async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return reply;
    try {
      const params = request.params as { ownerRef: string };
      const query = request.query as Record<string, unknown>;
      return reply.send({
        transactions: await wallet.history({
          ownerRef: params.ownerRef,
          workspaceId: str(query.workspaceId),
          limit: num(query.limit) ?? 25,
        }),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
