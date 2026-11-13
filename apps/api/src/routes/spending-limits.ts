/**
 * Spending limit routes (Step 59).
 *
 * Six owner routes and three operator routes, and the split is the point:
 *
 *  - **Owner** routes read and change the caller's own limits. There is no owner
 *    parameter in the body; the caller comes from the request context, so one
 *    account cannot read or edit another's ceiling. A workspace or project scope
 *    is a scope *of that caller's*, never a lookup by id.
 *  - **Operator** routes touch the platform policy (the maximum anybody may set,
 *    and the defaults for an account that has set nothing). They need the
 *    deployment's operator token, and refuse with 503 when none is configured
 *    rather than falling open.
 *
 * Enforcement is not here. The two charge lanes and the worker loop consult the
 * service directly, which is why a browser that never opens this page is still
 * held to its limits.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolveCallerOwnerRef } from '../project-access.js';
import {
  SpendingLimitError,
  isLimitMode,
  isLimitPeriod,
  isLimitTarget,
  isSpendCategory,
  type LimitEventKind,
  type LimitScope,
  type PlatformLimitPolicy,
  type SpendCategory,
  type SpendingLimitRule,
} from '@veltravia/spending-limits-core';

import type { SpendRef, SpendingLimitService } from '../spending-limit-service.js';

export interface SpendingLimitRouteDeps {
  readonly spendingLimits: SpendingLimitService;
}

const SCOPES: readonly LimitScope[] = ['user', 'workspace', 'project'];
const EVENT_KINDS: readonly LimitEventKind[] = [
  'warning',
  'limit-reached',
  'operation-refused',
  'policy-changed',
  'limit-raised',
  'limit-lowered',
  'policy-reset',
];

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SpendingLimitError) {
    return reply
      .status(error.status)
      .send({ error: { code: error.code, message: error.message, ...error.details } });
  }
  return reply.status(503).send({
    error: {
      code: 'SPENDING_LIMITS_UNAVAILABLE',
      message: 'Your spending limits could not be read just now. Nothing was charged or changed.',
    },
  });
}

const workspaceOf = (request: FastifyRequest): string | null => {
  const query = request.query as { workspaceId?: string } | undefined;
  const header = request.headers['x-veltravia-workspace'];
  const raw = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  const value = query?.workspaceId ?? raw;
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
};

const projectOf = (request: FastifyRequest): string | null => {
  const query = request.query as { projectId?: string } | undefined;
  const value = typeof query?.projectId === 'string' ? query.projectId.trim() : '';
  return value.length > 0 ? value.slice(0, 128) : null;
};

/**
 * The three scope locators a caller may act on. A `user` scope ignores the
 * workspace and project ids on purpose: a personal limit is personal.
 */
function scopeOf(body: Record<string, unknown>): {
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
} {
  const raw = str(body['scope']) ?? 'user';
  const scope = (SCOPES as readonly string[]).includes(raw) ? (raw as LimitScope) : null;
  if (scope === null) {
    throw new SpendingLimitError('INVALID_LIMIT', `"${raw}" is not a limit scope.`, 400);
  }
  const workspaceId = str(body['workspaceId']) ?? null;
  const projectId = str(body['projectId']) ?? null;
  if (scope === 'workspace' && workspaceId === null) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      'A workspace limit needs the workspace it belongs to.',
      400,
    );
  }
  if (scope === 'project' && projectId === null) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      'A project limit needs the project it belongs to.',
      400,
    );
  }
  return {
    scope,
    workspaceId: scope === 'workspace' ? workspaceId : null,
    projectId: scope === 'project' ? projectId : null,
  };
}

/** One rule, refused with the field named rather than silently ignored. */
function ruleOf(value: unknown, index: number): SpendingLimitRule {
  if (value === null || typeof value !== 'object') {
    throw new SpendingLimitError('INVALID_LIMIT', `Rule ${index + 1} is not an object.`, 400);
  }
  const raw = value as Record<string, unknown>;
  const target = str(raw['target']) ?? 'all';
  if (!isLimitTarget(target)) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      `Rule ${index + 1}: "${target}" is not something that can be limited.`,
      400,
    );
  }
  const period = str(raw['period']) ?? 'monthly';
  if (!isLimitPeriod(period)) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      `Rule ${index + 1}: "${period}" is not a period. Choose daily, weekly, monthly or custom.`,
      400,
    );
  }
  const mode = str(raw['mode']) ?? 'hard';
  if (!isLimitMode(mode)) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      `Rule ${index + 1}: "${mode}" is not a mode. Choose soft or hard.`,
      400,
    );
  }
  const limit = num(raw['limit']);
  if (limit === undefined || limit < 0) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      `Rule ${index + 1} needs a credit limit of zero or more.`,
      400,
    );
  }
  const warnAtRaw = Array.isArray(raw['warnAt']) ? raw['warnAt'] : [];
  const warnAt = warnAtRaw
    .map((entry) => num(entry))
    .filter((entry): entry is number => entry !== undefined);
  const periodDays = num(raw['periodDays']);
  return {
    id: str(raw['id']) ?? `rule-${index + 1}`,
    target: target as SpendingLimitRule['target'],
    period: period as SpendingLimitRule['period'],
    limit,
    mode: mode as SpendingLimitRule['mode'],
    periodDays: periodDays ?? null,
    periodAnchor: str(raw['periodAnchor']) ?? null,
    warnAt,
    ...(str(raw['label']) === undefined ? {} : { label: str(raw['label']) }),
  };
}

export function registerSpendingLimitRoutes(
  app: FastifyInstance,
  deps: SpendingLimitRouteDeps,
  env: NodeJS.ProcessEnv,
): void {
  const { spendingLimits } = deps;

  /**
   * Operator gate. No token configured means the platform routes are closed,
   * because a limit that anybody can raise is not a limit.
   */
  const operator = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const expected = (
      env.VELTRAVIA_BILLING_ADMIN_TOKEN ??
      env.VELTRAVIA_USAGE_ADMIN_TOKEN ??
      ''
    ).trim();
    if (expected === '') {
      reply.status(503).send({
        error: {
          code: 'SPENDING_LIMIT_ADMIN_DISABLED',
          message: 'This deployment has no operator token, so platform limits are closed.',
        },
      });
      return false;
    }
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const header = request.headers['x-veltravia-admin'];
    const token =
      bearer.length > 0
        ? bearer
        : typeof header === 'string'
          ? header
          : Array.isArray(header)
            ? header[0]
            : undefined;
    if (token !== expected) {
      reply.status(403).send({
        error: {
          code: 'SPENDING_LIMIT_ADMIN_DENIED',
          message: 'That operator token is not valid.',
        },
      });
      return false;
    }
    return true;
  };

  const ownerRef = (request: FastifyRequest): string => resolveCallerOwnerRef(request);

  /**
   * What a screen needs in one call: the policies in force, the live limits with
   * their consumption, today/week/month per category, holds, and the recent
   * limit events. Read-only.
   */
  app.get('/api/spending-limits', async (request, reply) => {
    try {
      const ref: SpendRef = {
        ownerRef: ownerRef(request),
        workspaceId: workspaceOf(request),
        projectId: projectOf(request),
      };
      return reply.send(await spendingLimits.overview(ref));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The raw policy rows this account has, one per scope. */
  app.get('/api/spending-limits/policies', async (request, reply) => {
    try {
      const policies = await spendingLimits.policies(ownerRef(request));
      return reply.send({ policies });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/spending-limits/events', async (request, reply) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const kind = str(query['kind']);
      if (kind !== undefined && !(EVENT_KINDS as readonly string[]).includes(kind)) {
        throw new SpendingLimitError('INVALID_LIMIT', `"${kind}" is not a limit event type.`, 400);
      }
      const limit = Math.min(Math.max(num(query['limit']) ?? 25, 1), 100);
      const since = str(query['since']);
      const events = await spendingLimits.events(ownerRef(request), {
        ...(kind === undefined ? {} : { kind: kind as LimitEventKind }),
        ...(since === undefined ? {} : { since }),
        limit,
      });
      return reply.send({ events });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Who changed which limit, when, and why. */
  app.get('/api/spending-limits/audit', async (request, reply) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const limit = Math.min(Math.max(num(query['limit']) ?? 25, 1), 100);
      return reply.send({ audit: await spendingLimits.audit(ownerRef(request), limit) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Create or replace the caller's policy for one scope.
   *
   * `expectedVersion` is required in the body: `null` creates, a number updates,
   * and a stale number is refused with 409 so two open tabs cannot silently
   * overwrite each other. `expiresAt` is not accepted; limits do not lapse on
   * their own.
   */
  app.put('/api/spending-limits/policy', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const scope = scopeOf(body);
      const rawRules = Array.isArray(body['rules']) ? body['rules'] : [];
      const rules = rawRules.map(ruleOf);
      const expected = body['expectedVersion'];
      const expectedVersion =
        expected === null || expected === undefined ? null : (num(expected) ?? null);
      if (expected !== null && expected !== undefined && expectedVersion === null) {
        throw new SpendingLimitError(
          'INVALID_LIMIT',
          'expectedVersion must be a number, or null to create the policy.',
          400,
        );
      }
      const perOperationLimit = num(body['perOperationLimit']);
      const maxReservedCredits = num(body['maxReservedCredits']);
      const saved = await spendingLimits.savePolicy({
        ownerRef: ownerRef(request),
        ...scope,
        rules,
        perOperationLimit: perOperationLimit ?? null,
        maxReservedCredits: maxReservedCredits ?? null,
        expectedVersion,
        actor: ownerRef(request),
        reason: str(body['reason']) ?? 'Changed from the spending limits screen.',
      });
      return reply.status(expectedVersion === null ? 201 : 200).send({ policy: saved });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Remove a policy, returning the scope to what its parent allows. */
  app.delete('/api/spending-limits/policy', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const scope = scopeOf(body);
      const expectedVersion = num(body['expectedVersion']);
      if (expectedVersion === undefined) {
        throw new SpendingLimitError(
          'INVALID_LIMIT',
          'expectedVersion is required to remove a policy.',
          400,
        );
      }
      await spendingLimits.resetPolicy({
        ownerRef: ownerRef(request),
        ...scope,
        expectedVersion,
        actor: ownerRef(request),
        reason: str(body['reason']) ?? 'Reset from the spending limits screen.',
      });
      return reply.status(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Would this operation start, right now? A dry run: nothing is charged and no
   * event is written, so a screen can explain a refusal before somebody hits send.
   */
  app.get('/api/spending-limits/check', async (request, reply) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const category = str(query['category']) ?? 'ai_messages';
      if (!isSpendCategory(category)) {
        throw new SpendingLimitError(
          'INVALID_LIMIT',
          `"${category}" is not a spending category.`,
          400,
        );
      }
      const requested = Math.max(num(query['requested']) ?? 0, 0);
      const decision = await spendingLimits.preview({
        ownerRef: ownerRef(request),
        workspaceId: workspaceOf(request),
        projectId: projectOf(request),
        category: category as SpendCategory,
        requested,
        actor: ownerRef(request),
      });
      return reply.send(decision);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The platform maximum and defaults. Owner can read theirs, never set it. */
  app.get('/api/spending-limits/platform', async (_request, reply) => {
    try {
      return reply.send({ platform: await spendingLimits.platform() });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put('/api/spending-limits/platform', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const defaults = Array.isArray(body['defaultRules']) ? body['defaultRules'] : [];
      const policy: PlatformLimitPolicy & { actor: string; reason: string } = {
        maxLimitPerRule: num(body['maxLimitPerRule']) ?? null,
        maxPerOperationLimit: num(body['maxPerOperationLimit']) ?? null,
        maxReservedCredits: num(body['maxReservedCredits']) ?? null,
        defaultRules: defaults.map(ruleOf),
        defaultPerOperationLimit: num(body['defaultPerOperationLimit']) ?? null,
        defaultMaxReservedCredits: num(body['defaultMaxReservedCredits']) ?? null,
        enforcementDisabled: body['enforcementDisabled'] === true,
        updatedAt: new Date().toISOString(),
        updatedBy: str(body['updatedBy']) ?? 'operator',
        actor: str(body['updatedBy']) ?? 'operator',
        reason: str(body['reason']) ?? 'Platform policy updated.',
      };
      return reply.send({ platform: await spendingLimits.savePlatform(policy) });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
