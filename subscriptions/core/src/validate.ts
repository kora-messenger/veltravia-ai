/**
 * Validating a plan before it is written.
 *
 * Plan rows are configuration, and configuration is where a typo becomes a
 * security problem: `"limits.projects": "5"` that nobody coerces is a plan with
 * no ceiling, and `"features.coding_agent": "true"` is a string that a truthiness
 * check would happily accept. So every field is checked here, refused with the
 * field named, and nothing is written when any of it is wrong.
 *
 * The one rule that is not about shape: **the development allowance must stay
 * active**. It is what a lapsed subscription falls back to, so deactivating it
 * would leave accounts with no plan at all rather than a smaller one.
 */

import { DEVELOPMENT_PLAN_ID } from './plans.js';
import {
  SubscriptionError,
  entitlementDefinition,
  isQuotaKey,
  type EntitlementValue,
  type PlanEntitlements,
  type PlanQuotaLimits,
} from './types.js';
import type { QuotaLimitKey } from '@veltravia/usage-core';

export interface PlanDraft {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  readonly visible: boolean;
  readonly active: boolean;
  readonly selfService: boolean;
  readonly monthlyMessageCredits: number;
  readonly monthlyIntegrationCredits: number;
  readonly entitlements: PlanEntitlements;
  readonly quotas: PlanQuotaLimits;
}

export interface NormalizedPlan {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  readonly visible: boolean;
  readonly active: boolean;
  readonly selfService: boolean;
  readonly monthlyMessageCredits: number;
  readonly monthlyIntegrationCredits: number;
  readonly entitlements: PlanEntitlements;
  readonly quotas: PlanQuotaLimits;
}

const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_CREDITS = 1_000_000_000;
const MAX_QUOTA = 1e15;

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || Math.floor(parsed) !== parsed) {
    throw new SubscriptionError('INVALID_PLAN', `${field} must be a whole number.`, 400, { field });
  }
  if (parsed < min || parsed > max) {
    throw new SubscriptionError(
      'INVALID_PLAN',
      `${field} must be between ${min} and ${max}.`,
      400,
      { field },
    );
  }
  return parsed;
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) {
      throw new SubscriptionError('INVALID_PLAN', `${field} is required.`, 400, { field });
    }
    return '';
  }
  if (typeof value !== 'string') {
    throw new SubscriptionError('INVALID_PLAN', `${field} must be text.`, 400, { field });
  }
  const trimmed = value.trim();
  if (required && trimmed === '') {
    throw new SubscriptionError('INVALID_PLAN', `${field} is required.`, 400, { field });
  }
  if (trimmed.length > max) {
    throw new SubscriptionError(
      'INVALID_PLAN',
      `${field} must be ${max} characters or fewer.`,
      400,
      { field },
    );
  }
  return trimmed;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SubscriptionError('INVALID_PLAN', `${field} must be true or false.`, 400, { field });
  }
  return value;
}

/**
 * An entitlement value: `true`/`false` for a flag, a whole number or `null` for
 * a quantity. `null` on a quantity is "unlimited", which is a statement, not an
 * absence, so it is accepted - and it is the only way to say unlimited.
 */
function entitlementValueFor(key: string, value: unknown): EntitlementValue {
  const definition = entitlementDefinition(key);
  if (definition === null) {
    throw new SubscriptionError(
      'INVALID_PLAN',
      `"${key}" is not an entitlement this build knows about.`,
      400,
      { field: `entitlements.${key}` },
    );
  }
  if (value === null) {
    if (definition.kind === 'flag') {
      throw new SubscriptionError(
        'INVALID_PLAN',
        `${definition.label} is either included or it is not; null is not a value for it.`,
        400,
        { field: `entitlements.${key}` },
      );
    }
    return null;
  }
  if (definition.kind === 'flag') return flag(value, `entitlements.${key}`);
  return integer(value, `entitlements.${key}`, 0, MAX_CREDITS);
}

export function normalizePlanDraft(
  draft: unknown,
  options: { requireId: boolean },
): NormalizedPlan {
  if (draft === null || typeof draft !== 'object') {
    throw new SubscriptionError('INVALID_PLAN', 'A plan must be an object.', 400);
  }
  const raw = draft as Record<string, unknown>;

  let id: string | null = null;
  if (raw['id'] !== undefined && raw['id'] !== null) {
    const candidate = text(raw['id'], 'id', 32, true).toLowerCase();
    if (!PLAN_ID_PATTERN.test(candidate)) {
      throw new SubscriptionError(
        'INVALID_PLAN',
        'A plan id is 2-32 characters: lower-case letters, digits and dashes, starting with a letter.',
        400,
        { field: 'id' },
      );
    }
    id = candidate;
  } else if (options.requireId) {
    throw new SubscriptionError('INVALID_PLAN', 'id is required.', 400, { field: 'id' });
  }

  const name = text(raw['name'], 'name', 60, true);
  const description = text(raw['description'], 'description', 400, false);
  const rank = integer(raw['rank'] ?? 0, 'rank', 0, 1_000);
  const visible = raw['visible'] === undefined ? true : flag(raw['visible'], 'visible');
  const active = raw['active'] === undefined ? true : flag(raw['active'], 'active');
  const selfService =
    raw['selfService'] === undefined ? false : flag(raw['selfService'], 'selfService');
  const monthlyMessageCredits = integer(
    raw['monthlyMessageCredits'] ?? 0,
    'monthlyMessageCredits',
    0,
    MAX_CREDITS,
  );
  const monthlyIntegrationCredits = integer(
    raw['monthlyIntegrationCredits'] ?? 0,
    'monthlyIntegrationCredits',
    0,
    MAX_CREDITS,
  );

  const rawEntitlements = raw['entitlements'] ?? {};
  if (rawEntitlements === null || typeof rawEntitlements !== 'object') {
    throw new SubscriptionError('INVALID_PLAN', 'entitlements must be an object.', 400, {
      field: 'entitlements',
    });
  }
  const entitlements: Record<string, EntitlementValue> = {};
  for (const [key, value] of Object.entries(rawEntitlements as Record<string, unknown>)) {
    entitlements[key] = entitlementValueFor(key, value);
  }

  const rawQuotas = raw['quotas'] ?? {};
  if (rawQuotas === null || typeof rawQuotas !== 'object') {
    throw new SubscriptionError('INVALID_PLAN', 'quotas must be an object.', 400, {
      field: 'quotas',
    });
  }
  const quotas: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(rawQuotas as Record<string, unknown>)) {
    if (!isQuotaKey(key)) {
      throw new SubscriptionError(
        'INVALID_PLAN',
        `"${key}" is not a quota this build measures.`,
        400,
        { field: `quotas.${key}` },
      );
    }
    if (value === null) {
      quotas[key] = null;
      continue;
    }
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_QUOTA) {
      throw new SubscriptionError(
        'INVALID_PLAN',
        `quotas.${key} must be zero or more, or null for unlimited.`,
        400,
        { field: `quotas.${key}` },
      );
    }
    quotas[key] = Math.floor(parsed);
  }

  if (id === DEVELOPMENT_PLAN_ID && !active) {
    throw new SubscriptionError(
      'INVALID_PLAN',
      'The development allowance is what a lapsed subscription falls back to, so it cannot be deactivated.',
      400,
      { field: 'active' },
    );
  }
  if (!active && selfService) {
    throw new SubscriptionError(
      'INVALID_PLAN',
      'A plan that is not assignable cannot be self-selectable either.',
      400,
      { field: 'selfService' },
    );
  }

  return {
    id,
    name,
    description,
    rank,
    visible,
    active,
    selfService,
    monthlyMessageCredits,
    monthlyIntegrationCredits,
    entitlements,
    quotas: quotas as Record<QuotaLimitKey, number | null>,
  };
}
