/**
 * The spending decision, tested where it is honest: as a pure function.
 *
 * Every case names the thing that would otherwise go wrong in production -
 * one allowance spent twice by two in-flight operations, a soft limit that
 * silently refuses, a month boundary that forgets yesterday - and proves the
 * function's answer rather than a stored number.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLATFORM_LIMITS,
  InMemorySpendingLimitStore,
  SpendingLimitError,
  evaluateSpending,
  normalisePolicy,
  windowFor,
  type AppliedPolicy,
  type LimitEvent,
  type SpendSample,
  type SpendingLimitRule,
} from './index.js';

const now = new Date('2026-11-13T10:00:00.000Z');

const rule = (over: Partial<SpendingLimitRule> = {}): SpendingLimitRule => ({
  id: 'daily-all',
  target: 'all',
  period: 'daily',
  limit: 100,
  mode: 'hard',
  periodDays: null,
  periodAnchor: null,
  warnAt: [0.8],
  ...over,
});

const policy = (over: Partial<AppliedPolicy> = {}): AppliedPolicy => ({
  scope: 'user',
  workspaceId: null,
  projectId: null,
  rules: [rule()],
  perOperationLimit: null,
  maxReservedCredits: null,
  source: 'owner',
  ...over,
});

const sample = (over: Partial<SpendSample> = {}): SpendSample => ({
  category: 'ai_messages',
  committed: 0,
  reserved: 0,
  refunded: 0,
  charges: 0,
  ...over,
});

const windowKey = (period: 'daily' | 'weekly' | 'monthly' = 'daily'): string =>
  windowFor({ period, periodDays: null, periodAnchor: null }, now).key;

const usage = (
  entries: readonly { period?: 'daily' | 'weekly' | 'monthly'; samples: SpendSample[] }[],
): Map<string, readonly SpendSample[]> => {
  const map = new Map<string, readonly SpendSample[]>();
  for (const entry of entries) map.set(windowKey(entry.period ?? 'daily'), entry.samples);
  return map;
};

describe('evaluateSpending', () => {
  it('allows work that fits and refuses work that would cross a hard limit', () => {
    const fits = evaluateSpending({
      category: 'ai_messages',
      requested: 40,
      policies: [policy()],
      usage: usage([{ samples: [sample({ committed: 50 })] }]),
      heldCredits: 0,
      now,
    });
    expect(fits.allowed).toBe(true);
    expect(fits.allowance).toBe(50);

    const over = evaluateSpending({
      category: 'ai_messages',
      requested: 60,
      policies: [policy()],
      usage: usage([{ samples: [sample({ committed: 50 })] }]),
      heldCredits: 0,
      now,
    });
    expect(over.allowed).toBe(false);
    expect(over.violation?.reason).toBe('hard-limit');
    expect(over.violation?.ruleId).toBe('daily-all');
    expect(over.violation?.remaining).toBe(50);
  });

  it('counts credit held by work in flight, so one allowance cannot be spent twice', () => {
    // 60 consumed and 40 held is the whole 100: a second 10-credit operation
    // would be spending credit the first one has already been promised.
    const decision = evaluateSpending({
      category: 'ai_messages',
      requested: 10,
      policies: [policy()],
      usage: usage([{ samples: [sample({ committed: 60, reserved: 40 })] }]),
      heldCredits: 40,
      now,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation?.consumed).toBe(100);
    expect(decision.violation?.message).toContain('already used up');
  });

  it('warns at a threshold without blocking a soft limit', () => {
    const decision = evaluateSpending({
      category: 'ai_messages',
      requested: 5,
      policies: [policy({ rules: [rule({ mode: 'soft', limit: 100 })] })],
      usage: usage([{ samples: [sample({ committed: 90 })] }]),
      heldCredits: 0,
      now,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]?.threshold).toBe(0.8);
    expect(decision.statuses[0]?.state).toBe('warning');
    // The dedupe key is the window's identity, not the moment of the check, so
    // the same crossing recorded by fifty requests writes one event.
    expect(decision.warnings[0]?.dedupeKey).toBe('user|daily-all|' + windowKey() + '|0.8');
  });

  it('lets the tightest applicable scope decide, and names it in the refusal', () => {
    const decision = evaluateSpending({
      category: 'integrations',
      requested: 30,
      policies: [
        policy({ rules: [rule({ id: 'user-monthly', period: 'monthly', limit: 1000 })] }),
        policy({
          scope: 'workspace',
          workspaceId: 'ws_1',
          source: 'workspace',
          rules: [rule({ id: 'workspace-daily', limit: 120 })],
        }),
      ],
      usage: usage([
        { period: 'monthly', samples: [sample({ category: 'integrations', committed: 100 })] },
        { period: 'daily', samples: [sample({ category: 'integrations', committed: 100 })] },
      ]),
      heldCredits: 0,
      now,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation?.ruleId).toBe('workspace-daily');
    expect(decision.violation?.scope).toBe('workspace');
    expect(decision.allowance).toBe(20);
  });

  it('counts only the categories a targeted rule names', () => {
    const decision = evaluateSpending({
      category: 'coding',
      requested: 1,
      policies: [policy({ rules: [rule({ target: 'coding', limit: 10 })] })],
      usage: usage([
        {
          samples: [
            sample({ category: 'coding', committed: 9 }),
            sample({ category: 'ai_messages', committed: 900 }),
          ],
        },
      ]),
      heldCredits: 0,
      now,
    });
    // The coding rule sees 9 of 10; the 900 chat credits are a different rule's business.
    expect(decision.statuses[0]?.consumed).toBe(9);
    expect(decision.allowed).toBe(true);
  });

  it('refuses an operation above its own per-operation ceiling before any window', () => {
    const decision = evaluateSpending({
      category: 'ai_messages',
      requested: 500,
      policies: [policy({ perOperationLimit: 250 })],
      usage: usage([{ samples: [sample({ committed: 0 })] }]),
      heldCredits: 0,
      now,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation?.reason).toBe('per-operation-limit');
    expect(decision.violation?.limit).toBe(250);
  });

  it('refuses new work once held credit reaches the reserved cap', () => {
    const decision = evaluateSpending({
      category: 'agents',
      requested: 100,
      policies: [policy({ rules: [], maxReservedCredits: 300 })],
      usage: new Map(),
      heldCredits: 250,
      now,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation?.reason).toBe('reserved-cap');
    expect(decision.violation?.remaining).toBe(50);
  });

  it('forgets yesterday when the window turns over', () => {
    const yesterday = new Date('2026-11-12T10:00:00.000Z');
    const staleKey = windowFor(
      { period: 'daily', periodDays: null, periodAnchor: null },
      yesterday,
    ).key;
    const map = new Map<string, readonly SpendSample[]>([[staleKey, [sample({ committed: 100 })]]]);
    const decision = evaluateSpending({
      category: 'ai_messages',
      requested: 10,
      policies: [policy()],
      usage: map,
      heldCredits: 0,
      now,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.statuses[0]?.consumed).toBe(0);
  });

  it('reports unconfigured rather than pretending it enforced anything', () => {
    const decision = evaluateSpending({
      category: 'ai_messages',
      requested: 10,
      policies: [],
      usage: new Map(),
      heldCredits: 0,
      now,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.enforcement).toBe('unconfigured');
    expect(decision.reason).toBe('no-policy');
    expect(decision.allowance).toBeNull();
  });

  it('does not refuse when an operator has disabled enforcement, but still warns', () => {
    const decision = evaluateSpending({
      category: 'ai_messages',
      requested: 500,
      policies: [policy()],
      usage: usage([{ samples: [sample({ committed: 100 })] }]),
      heldCredits: 0,
      platform: { ...DEFAULT_PLATFORM_LIMITS, enforcementDisabled: true },
      now,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.enforcement).toBe('disabled');
    expect(decision.warnings).toHaveLength(1);
  });
});

describe('normalisePolicy', () => {
  it('refuses a rule naming a target or period it does not have', () => {
    expect(() =>
      normalisePolicy({
        ownerRef: 'owner',
        scope: 'user',
        rules: [
          { id: 'r', target: 'gambling', period: 'daily', limit: 5, mode: 'hard', warnAt: [] },
        ],
      }),
    ).toThrow(SpendingLimitError);
    expect(() =>
      normalisePolicy({
        ownerRef: 'owner',
        scope: 'user',
        rules: [{ id: 'r', target: 'all', period: 'hourly', limit: 5, mode: 'hard', warnAt: [] }],
      }),
    ).toThrow(/must be daily, weekly, monthly or custom/);
  });

  it('refuses a rule above the platform maximum rather than quietly lowering it', () => {
    // Silently storing 1,000 when somebody meant 9,000,000 is the worse failure:
    // their spending would stop and the number would look like their own.
    expect(() =>
      normalisePolicy(
        {
          ownerRef: 'owner',
          scope: 'user',
          rules: [
            {
              id: 'r',
              target: 'all',
              period: 'monthly',
              limit: 9_000_000,
              mode: 'hard',
              warnAt: [0.5],
            },
          ],
        },
        { ...DEFAULT_PLATFORM_LIMITS, maxLimitPerRule: 1_000 },
      ),
    ).toThrow(/above the 1000 credit maximum/);
  });

  it('refuses duplicate rule ids, so a stored policy is unambiguous', () => {
    expect(() =>
      normalisePolicy({
        ownerRef: 'owner',
        scope: 'user',
        rules: [
          { id: 'same', target: 'all', period: 'daily', limit: 5, mode: 'hard', warnAt: [] },
          { id: 'same', target: 'all', period: 'monthly', limit: 9, mode: 'hard', warnAt: [] },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it('needs a custom period to say how long it is', () => {
    expect(() =>
      normalisePolicy({
        ownerRef: 'owner',
        scope: 'user',
        rules: [{ id: 'r', target: 'all', period: 'custom', limit: 5, mode: 'hard', warnAt: [] }],
      }),
    ).toThrow(/day/i);
  });

  it('refuses a negative limit and a warning threshold outside 0..1', () => {
    expect(() =>
      normalisePolicy({
        ownerRef: 'owner',
        scope: 'user',
        rules: [{ id: 'r', target: 'all', period: 'daily', limit: -1, mode: 'hard', warnAt: [] }],
      }),
    ).toThrow(SpendingLimitError);
    expect(() =>
      normalisePolicy({
        ownerRef: 'owner',
        scope: 'user',
        rules: [{ id: 'r', target: 'all', period: 'daily', limit: 5, mode: 'hard', warnAt: [1.5] }],
      }),
    ).toThrow(SpendingLimitError);
  });
});

describe('InMemorySpendingLimitStore', () => {
  it('records a threshold once per dedupe key and keeps the first one', () => {
    const store = new InMemorySpendingLimitStore();
    const event: LimitEvent = {
      id: 'e1',
      ownerRef: 'owner',
      kind: 'warning',
      scope: 'user',
      workspaceId: null,
      projectId: null,
      ruleId: 'daily-all',
      windowKey: windowKey(),
      threshold: 0.8,
      limit: 100,
      consumed: 85,
      requested: null,
      message: 'You have used 85% of a 100 credit limit.',
      dedupeKey: 'user|daily-all|' + windowKey() + '|0.8',
      actor: 'system',
      occurredAt: now.toISOString(),
    };
    const first = store.appendEvent(event);
    const second = store.appendEvent({ ...event, id: 'e2', consumed: 95 });
    return Promise.all([first, second]).then(([one, two]) => {
      expect(one.created).toBe(true);
      expect(two.created).toBe(false);
      // The stored row is the first crossing: the moment it happened, not the
      // latest reading of it.
      expect(two.event.consumed).toBe(85);
      expect(store.events).toHaveLength(1);
    });
  });

  it('refuses a stale version instead of overwriting another edit', async () => {
    const store = new InMemorySpendingLimitStore();
    const base = {
      id: 'owner:user:-:-',
      ownerRef: 'owner',
      scope: 'user' as const,
      workspaceId: null,
      projectId: null,
      perOperationLimit: null,
      maxReservedCredits: null,
      updatedBy: 'owner',
      updatedAt: now.toISOString(),
      createdAt: now.toISOString(),
    };
    const created = await store.savePolicy(
      { ...base, rules: [rule({ limit: 100 })], version: 1 },
      null,
    );
    expect(created?.version).toBe(1);
    const updated = await store.savePolicy(
      { ...base, rules: [rule({ limit: 200 })], version: 2 },
      1,
    );
    expect(updated?.version).toBe(2);
    const stale = await store.savePolicy({ ...base, rules: [rule({ limit: 300 })], version: 2 }, 1);
    expect(stale).toBeNull();
    expect(
      (
        await store.readPolicy({
          ownerRef: 'owner',
          scope: 'user',
          workspaceId: null,
          projectId: null,
        })
      )?.rules[0]?.limit,
    ).toBe(200);
  });
});
