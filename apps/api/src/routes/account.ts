/**
 * Personal Account Agent routes (Step 62).
 *
 * The server, not the model, builds the `AccountPrincipal`:
 *
 *   ownerRef   from the caller context, exactly like every other route;
 *   sessionId  from the request (a stable id for the turn), so two surfaces of the
 *              same person are distinguishable in the trail;
 *   role       from a trusted header on this build's header-based auth, with
 *              `VERIFIED_ROLES` as the only accepted values;
 *   operator   only when the deployment's operator token is presented, which is
 *              the same token the wallet routes accept.
 *
 * Nothing in the request body can name an owner, a role or a permission: the
 * account agent refuses those argument names in the core, and this route never
 * copies one across.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AccountAgentError,
  type AccountActionStatus,
  type AccountCallRequest,
  type AccountPrincipal,
  type AccountRole,
} from '@veltravia/account-agent-core';

import type { AccountAgentService } from '../account-agent-service.js';
import { resolveCallerOwnerRef } from '../project-access.js';

export interface AccountRouteDeps {
  readonly accounts: AccountAgentService;
}

const VERIFIED_ROLES: readonly AccountRole[] = ['member', 'admin', 'owner'];

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

function holdsOperatorToken(request: FastifyRequest, env: NodeJS.ProcessEnv): boolean {
  const expected = env.VELTRAVIA_ACCOUNT_ADMIN_TOKEN ?? env.VELTRAVIA_WALLET_ADMIN_TOKEN;
  if (expected === undefined || expected.trim().length === 0) return false;
  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (provided.length === 0) return false;
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(provided).digest(),
  );
}

/**
 * The role this request may act with.
 *
 * A header role is honoured only when it is one of the three known values. The
 * default is `owner` because this build serves a single-owner account and its
 * other routes already treat the caller as the owner of their own resources; a
 * deployment that adds real membership passes the role in from its own session
 * middleware instead.
 */
function roleOf(request: FastifyRequest): AccountRole {
  const raw = str(request.headers['x-veltravia-role']);
  return raw !== null && (VERIFIED_ROLES as readonly string[]).includes(raw)
    ? (raw as AccountRole)
    : 'owner';
}

function principalOf(request: FastifyRequest, env: NodeJS.ProcessEnv): AccountPrincipal {
  const ownerRef = resolveCallerOwnerRef(request);
  const workspaceId = str(request.headers['x-veltravia-workspace']);
  const sessionId =
    str(request.headers['x-veltravia-session']) ??
    `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ownerRef,
    sessionId,
    role: roleOf(request),
    workspaceId,
    operator: holdsOperatorToken(request, env),
  };
}

function fail(reply: FastifyReply, error: unknown, principal: AccountPrincipal): FastifyReply {
  if (error instanceof AccountAgentError) {
    return reply.status(error.status).send({
      error: error.message,
      code: error.code,
      ...error.details,
      action: {
        ownerRef: principal.ownerRef,
        sessionId: principal.sessionId,
        status: 'refused',
      },
    });
  }
  throw error;
}

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: AccountRouteDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { accounts } = deps;

  app.get('/api/account/catalog', async (request, reply) => {
    const principal = principalOf(request, env);
    try {
      return reply.send(accounts.catalog(principal));
    } catch (error) {
      return fail(reply, error, principal);
    }
  });

  app.post('/api/account/actions', async (request, reply) => {
    const principal = principalOf(request, env);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tool = str(body.tool);
    if (tool === null) {
      return reply
        .status(400)
        .send({ error: 'Name the operation to perform.', code: 'INVALID_ARGUMENTS' });
    }
    const requestBody: AccountCallRequest = {
      tool,
      args: body.args ?? {},
      idempotencyKey: str(body.idempotencyKey),
      approvalToken: str(body.approvalToken),
      executionId: str(body.executionId),
    };
    try {
      const outcome = await accounts.call(principal, requestBody);
      // Every outcome is a 200 with an explicit status: a refusal is a normal
      // answer the interface renders, not a transport failure. The audit row id
      // is included so the person can look it up.
      return reply.send({
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        approval: outcome.approval,
        auditId: outcome.audit.id,
      });
    } catch (error) {
      return fail(reply, error, principal);
    }
  });

  app.get('/api/account/activity', async (request, reply) => {
    const principal = principalOf(request, env);
    const query = request.query as Record<string, unknown>;
    const status = str(query.status);
    const limit = typeof query.limit === 'number' ? query.limit : undefined;
    try {
      const entries = await accounts.activity(principal, {
        ...(str(query.tool) === null ? {} : { tool: str(query.tool) as string }),
        ...(status === null || !isStatus(status) ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
      });
      return reply.send({
        entries,
        note: 'This is what the assistant actually did: executed, refused, waiting for confirmation, or a replay of an earlier request.',
      });
    } catch (error) {
      return fail(reply, error, principal);
    }
  });

  app.get('/api/account/activity/:entryId', async (request, reply) => {
    const principal = principalOf(request, env);
    const { entryId } = request.params as { entryId: string };
    try {
      const entry = await accounts.entry(principal, entryId);
      if (entry === null) {
        return reply.status(404).send({ error: 'No such account action.', code: 'NOT_FOUND' });
      }
      return reply.send({ entry });
    } catch (error) {
      return fail(reply, error, principal);
    }
  });
}

const STATUSES: readonly AccountActionStatus[] = [
  'suggested',
  'awaiting_confirmation',
  'executed',
  'failed',
  'refused',
  'replayed',
];

function isStatus(value: string): value is AccountActionStatus {
  return (STATUSES as readonly string[]).includes(value);
}
