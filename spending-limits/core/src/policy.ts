/**
 * What a policy is allowed to say (Step 59).
 *
 * Every number a person sets passes through here before it is stored. Two
 * different bounds apply and both are enforced:
 *
 *  - the **vocabulary** ceilings (`SPENDING_LIMIT_CEILINGS`), which are about
 *    catching typos and runaway rows, and never move;
 *  - the **platform** policy, which an operator may set and which a user can
 *    never exceed. A user's number above the platform maximum is refused, not
 *    silently clamped, because a limit the user did not set is a lie.
 *
 * Validation is exhaustive on purpose: a policy is what stands between an
 * account and an unexpected bill, so an unknown target or a negative warning
 * threshold is a refusal with the field named, not something to guess at.
 */

import {
  DEFAULT_PLATFORM_LIMITS,
  SPENDING_LIMIT_CEILINGS,
  SpendingLimitError,
  creditRound,
  isLimitMode,
  isLimitPeriod,
  isLimitScope,
  isLimitTarget,
  type LimitScope,
  type PlatformLimitPolicy,
  type SpendingLimitRule,
} from './types.js';

export interface PolicyDraft {
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly rules: readonly unknown[];
  readonly perOperationLimit?: number | null;
  readonly maxReservedCredits?: number | null;
}

function plainText(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpendingLimitError('INVALID_POLICY', `${field} is required.`, 400, { field });
  }
  return value.trim().slice(0, max);
}

function creditAmount(
  value: unknown,
  field: string,
  ceiling: number | null,
  platformValue: number | null,
  options: { readonly allowNull: boolean },
): number | null {
  if (value === null || value === undefined) {
    if (options.allowNull) return null;
    throw new SpendingLimitError('INVALID_LIMIT', `${field} is required.`, 400, { field });
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SpendingLimitError('INVALID_LIMIT', `${field} must be a finite number.`, 400, {
      field,
    });
  }
  if (value < 0) {
    throw new SpendingLimitError(
      'INVALID_LIMIT',
      `${field} cannot be negative. Use null for "no limit".`,
      400,
      { field, value },
    );
  }
  if (creditRound(value) !== value) {
    throw new SpendingLimitError('INVALID_LIMIT', `${field} may have at most four decimals.`, 400, {
      field,
      value,
    });
  }
  if (ceiling !== null && value > ceiling) {
    throw new SpendingLimitError(
      'LIMIT_ABOVE_CEILING',
      `${field} is above the ${ceiling} credit ceiling this platform allows.`,
      400,
      { field, value, ceiling },
    );
  }
  if (platformValue !== null && value > platformValue) {
    throw new SpendingLimitError(
      'LIMIT_ABOVE_CEILING',
      `${field} is above the ${platformValue} credit maximum an operator has set.`,
      400,
      { field, value, ceiling: platformValue },
    );
  }
  return value;
}

function thresholds(value: unknown, field: string): readonly number[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SpendingLimitError(
      'INVALID_THRESHOLD',
      `${field} must be a list of fractions between 0 and 1.`,
      400,
      { field },
    );
  }
  if (value.length > SPENDING_LIMIT_CEILINGS.maxWarningThresholds) {
    throw new SpendingLimitError(
      'INVALID_THRESHOLD',
      `${field} may hold at most ${SPENDING_LIMIT_CEILINGS.maxWarningThresholds} thresholds.`,
      400,
      { field, count: value.length },
    );
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new SpendingLimitError('INVALID_THRESHOLD', `${field} must hold numbers only.`, 400, {
        field,
        entry,
      });
    }
    if (entry <= 0 || entry >= 1) {
      throw new SpendingLimitError(
        'INVALID_THRESHOLD',
        `${field} entries must be greater than 0 and less than 1: a warning at 100% would be the limit itself.`,
        400,
        { field, entry },
      );
    }
    const rounded = Math.round(entry * 10_000) / 10_000;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    out.push(rounded);
  }
  return out.sort((left, right) => left - right);
}

function rule(value: unknown, index: number, platform: PlatformLimitPolicy): SpendingLimitRule {
  const field = `rules[${index}]`;
  if (value === null || typeof value !== 'object') {
    throw new SpendingLimitError('INVALID_RULE', `${field} must be an object.`, 400, { field });
  }
  const raw = value as Record<string, unknown>;
  const target = plainText(raw.target ?? 'all', `${field}.target`, 40);
  if (!isLimitTarget(target)) {
    throw new SpendingLimitError(
      'INVALID_TARGET',
      `${field}.target must be one of all, chat, coding, agents, reasoning, tools, background, integrations, infrastructure.`,
      400,
      { field, target },
    );
  }
  const period = plainText(raw.period, `${field}.period`, 20);
  if (!isLimitPeriod(period)) {
    throw new SpendingLimitError(
      'INVALID_PERIOD',
      `${field}.period must be daily, weekly, monthly or custom.`,
      400,
      { field, period },
    );
  }
  const mode = plainText(raw.mode ?? 'hard', `${field}.mode`, 10);
  if (!isLimitMode(mode)) {
    throw new SpendingLimitError('INVALID_MODE', `${field}.mode must be soft or hard.`, 400, {
      field,
      mode,
    });
  }

  const limit = creditAmount(
    raw.limit,
    `${field}.limit`,
    SPENDING_LIMIT_CEILINGS.maxRuleCredits,
    platform.maxLimitPerRule,
    { allowNull: true },
  );

  let periodDays: number | null = null;
  let periodAnchor: string | null = null;
  if (period === 'custom') {
    const days = raw.periodDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 366) {
      throw new SpendingLimitError(
        'INVALID_PERIOD',
        `${field}.periodDays must be a whole number of days between 1 and 366 for a custom period.`,
        400,
        { field, periodDays: days ?? null },
      );
    }
    periodDays = days;
    if (raw.periodAnchor !== null && raw.periodAnchor !== undefined) {
      const anchor = typeof raw.periodAnchor === 'string' ? Date.parse(raw.periodAnchor) : NaN;
      if (!Number.isFinite(anchor)) {
        throw new SpendingLimitError(
          'INVALID_PERIOD',
          `${field}.periodAnchor must be an ISO instant.`,
          400,
          { field },
        );
      }
      periodAnchor = new Date(anchor).toISOString();
    }
  }

  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim().slice(0, 80)
      : `${String(target)}-${String(period)}`;

  return {
    id,
    target: target as SpendingLimitRule['target'],
    period,
    limit,
    mode,
    periodDays,
    periodAnchor,
    warnAt: thresholds(raw.warnAt, `${field}.warnAt`),
  };
}

export interface NormalisedPolicy {
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly rules: readonly SpendingLimitRule[];
  readonly perOperationLimit: number | null;
  readonly maxReservedCredits: number | null;
}

/**
 * Turns a request body into a policy that may be stored. Never a partial
 * accept: one bad rule refuses the whole write, so the stored policy is exactly
 * what the person saw.
 */
export function normalisePolicy(
  draft: PolicyDraft,
  platform: PlatformLimitPolicy = DEFAULT_PLATFORM_LIMITS,
): NormalisedPolicy {
  const ownerRef = plainText(draft.ownerRef, 'ownerRef', 200);
  if (!isLimitScope(draft.scope)) {
    throw new SpendingLimitError(
      'INVALID_POLICY',
      'scope must be user, workspace or project.',
      400,
      { scope: draft.scope },
    );
  }
  const workspaceId =
    draft.workspaceId === null || draft.workspaceId === undefined || draft.workspaceId === ''
      ? null
      : plainText(draft.workspaceId, 'workspaceId', 200);
  const projectId =
    draft.projectId === null || draft.projectId === undefined || draft.projectId === ''
      ? null
      : plainText(draft.projectId, 'projectId', 200);

  if (draft.scope === 'workspace' && workspaceId === null) {
    throw new SpendingLimitError(
      'INVALID_POLICY',
      'A workspace limit needs the workspace it belongs to.',
      400,
      { scope: draft.scope },
    );
  }
  if (draft.scope === 'project' && projectId === null) {
    throw new SpendingLimitError(
      'INVALID_POLICY',
      'A project limit needs the project it belongs to.',
      400,
      { scope: draft.scope },
    );
  }

  if (!Array.isArray(draft.rules)) {
    throw new SpendingLimitError('INVALID_POLICY', 'rules must be a list.', 400);
  }
  if (draft.rules.length > SPENDING_LIMIT_CEILINGS.maxRulesPerPolicy) {
    throw new SpendingLimitError(
      'TOO_MANY_RULES',
      `A policy may hold at most ${SPENDING_LIMIT_CEILINGS.maxRulesPerPolicy} rules.`,
      400,
      { count: draft.rules.length },
    );
  }
  const rules = draft.rules.map((entry, index) => rule(entry, index, platform));
  const ids = new Set<string>();
  for (const entry of rules) {
    if (ids.has(entry.id)) {
      throw new SpendingLimitError(
        'INVALID_RULE',
        `Two rules share the id "${entry.id}". Ids identify a warning, so they must be unique.`,
        400,
        { ruleId: entry.id },
      );
    }
    ids.add(entry.id);
  }

  const perOperationLimit = creditAmount(
    draft.perOperationLimit ?? null,
    'perOperationLimit',
    SPENDING_LIMIT_CEILINGS.maxRuleCredits,
    platform.maxPerOperationLimit,
    { allowNull: true },
  );
  const maxReservedCredits = creditAmount(
    draft.maxReservedCredits ?? null,
    'maxReservedCredits',
    SPENDING_LIMIT_CEILINGS.maxRuleCredits,
    platform.maxReservedCredits,
    { allowNull: true },
  );

  return {
    ownerRef,
    scope: draft.scope,
    workspaceId,
    projectId,
    rules,
    perOperationLimit,
    maxReservedCredits,
  };
}

/** The rules a scope inherits when it configured none of its own. */
export function platformDefaults(
  platform: PlatformLimitPolicy,
): Pick<NormalisedPolicy, 'rules' | 'perOperationLimit' | 'maxReservedCredits'> {
  return {
    rules: platform.defaultRules,
    perOperationLimit: platform.defaultPerOperationLimit,
    maxReservedCredits: platform.defaultMaxReservedCredits,
  };
}
