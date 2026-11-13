/**
 * Spending limit vocabulary (Step 59).
 *
 * A limit answers one question: how much credit may be consumed, over what
 * window, in which category, and what happens when the answer is nearly no.
 * Three things are deliberately kept apart:
 *
 *  - the **rule**, which is configuration a person or a platform operator sets;
 *  - the **usage**, which is what the existing charge rows and ledger already
 *    say was spent, never a second tally;
 *  - the **decision**, which is the answer this module gives before billable
 *    work is authorised, and which always names the rule that produced it.
 *
 * The category list is the Step 58 usage vocabulary, not a new one. A category
 * here means exactly what it means on the usage page, so a limit and the report
 * beside it can never disagree about what "coding" is.
 */

export const LIMIT_SCOPES = ['user', 'workspace', 'project'] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

export const SPEND_CATEGORIES = [
  'ai_messages',
  'coding',
  'agents',
  'reasoning',
  'tools',
  'background',
  'integrations',
  'infrastructure',
] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** `all` is a single ceiling over every credit-billed category. */
export const LIMIT_TARGETS = ['all', ...SPEND_CATEGORIES] as const;
export type LimitTarget = (typeof LIMIT_TARGETS)[number];

export const LIMIT_PERIODS = ['daily', 'weekly', 'monthly', 'custom'] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

/**
 * A soft limit warns and lets work continue. A hard limit refuses new work once
 * the projected spend would pass it. There is no third mode, and a hard limit is
 * never quietly downgraded to a soft one.
 */
export const LIMIT_MODES = ['soft', 'hard'] as const;
export type LimitMode = (typeof LIMIT_MODES)[number];

export interface SpendingLimitRule {
  /** Stable within a policy, so a warning is attached to one rule and not another. */
  readonly id: string;
  readonly target: LimitTarget;
  readonly period: LimitPeriod;
  /** Credits allowed in the window. `null` means explicitly unlimited here. */
  readonly limit: number | null;
  readonly mode: LimitMode;
  /** Length in days, required when `period` is `custom`. 1..366. */
  readonly periodDays: number | null;
  /** ISO instant the custom window is aligned to. Ignored for calendar periods. */
  readonly periodAnchor: string | null;
  /**
   * Fractions of the limit at which a warning fires, ascending, each in (0, 1).
   * Empty means "no warnings, refusals only".
   */
  readonly warnAt: readonly number[];
}

export interface SpendingLimitPolicy {
  readonly id: string;
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly rules: readonly SpendingLimitRule[];
  /** Largest single authorisation, in credits. Null = unrestricted. */
  readonly perOperationLimit: number | null;
  /** Ceiling on credit held by work in flight at one moment. Null = unrestricted. */
  readonly maxReservedCredits: number | null;
  /** Bumped on every write; a stale write is refused rather than merged. */
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly createdAt: string;
}

/**
 * Platform-level policy. It can only narrow what a scope may set, never widen
 * it: a ceiling below a user's own number binds, and a user cannot raise a limit
 * above the platform maximum. Nothing here invents a price.
 */
export interface PlatformLimitPolicy {
  /** Largest value any rule may carry. Null = no platform ceiling. */
  readonly maxLimitPerRule: number | null;
  readonly maxPerOperationLimit: number | null;
  readonly maxReservedCredits: number | null;
  /** Rules applied where a scope set none at all. */
  readonly defaultRules: readonly SpendingLimitRule[];
  readonly defaultPerOperationLimit: number | null;
  readonly defaultMaxReservedCredits: number | null;
  /** Turns enforcement off for every caller. Refusals stop; warnings still show. */
  readonly enforcementDisabled: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export const DEFAULT_PLATFORM_LIMITS: PlatformLimitPolicy = {
  maxLimitPerRule: null,
  maxPerOperationLimit: null,
  maxReservedCredits: null,
  defaultRules: [],
  defaultPerOperationLimit: null,
  defaultMaxReservedCredits: null,
  enforcementDisabled: false,
  updatedAt: '1970-01-01T00:00:00.000Z',
  updatedBy: 'default',
};

/** Hard ceilings that hold even when no policy is configured anywhere. */
export const SPENDING_LIMIT_CEILINGS = {
  /** Credits, per rule. A limit above this is a typo, not a plan. */
  maxRuleCredits: 10_000_000,
  maxRulesPerPolicy: 40,
  maxWarningThresholds: 8,
  maxCustomPeriodDays: 366,
} as const;

/** One category's usage inside a window, as the charge lanes report it. */
export interface SpendSample {
  readonly category: SpendCategory;
  /** Credits consumed for good (settled charges, net of refunds). */
  readonly committed: number;
  /** Credits held for work in flight. Counts against an allowance. */
  readonly reserved: number;
  /** Credits refunded inside the window; already deducted from `committed`. */
  readonly refunded: number;
  readonly charges: number;
}

export interface SpendWindow {
  /** Inclusive start instant, ISO. */
  readonly start: string;
  /** Exclusive end instant, ISO. */
  readonly end: string;
  /**
   * Stable identity of the window (its start instant). Two evaluations of the
   * same window share it, which is what keeps a warning from repeating.
   */
  readonly key: string;
  readonly label: string;
}

export type LimitState = 'ok' | 'warning' | 'reached';

export interface LimitStatus {
  readonly ruleId: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly target: LimitTarget;
  readonly period: LimitPeriod;
  readonly mode: LimitMode;
  readonly window: SpendWindow;
  readonly limit: number;
  readonly committed: number;
  readonly reserved: number;
  /** committed + reserved: what counts against the allowance. */
  readonly consumed: number;
  /** limit - consumed, floored at zero. What a new operation may still add. */
  readonly remaining: number;
  /** consumed / limit, capped at 1 for display but exact in `ratio`. */
  readonly ratio: number;
  readonly state: LimitState;
  /** Thresholds this window has crossed, as fractions. */
  readonly crossed: readonly number[];
  /** Where the number came from, so a refusal can say it. */
  readonly source: 'owner' | 'workspace' | 'project' | 'platform-default' | 'platform-ceiling';
}

export type LimitDecisionReason =
  'allowed' | 'hard-limit' | 'per-operation-limit' | 'reserved-cap' | 'no-policy';

export interface LimitViolation {
  readonly reason: Exclude<LimitDecisionReason, 'allowed' | 'no-policy'>;
  readonly message: string;
  readonly ruleId: string | null;
  readonly scope: LimitScope | null;
  readonly limit: number | null;
  readonly requested: number;
  readonly consumed: number | null;
  readonly remaining: number | null;
  readonly window: SpendWindow | null;
}

export interface SpendDecision {
  readonly allowed: boolean;
  readonly reason: LimitDecisionReason;
  readonly enforcement: 'enforced' | 'disabled' | 'unconfigured';
  readonly category: SpendCategory;
  readonly requested: number;
  /** The tightest applicable allowance, which is what a UI shows as remaining. */
  readonly allowance: number | null;
  readonly statuses: readonly LimitStatus[];
  readonly violation: LimitViolation | null;
  /** Thresholds crossed by this evaluation, ready to be notified once each. */
  readonly warnings: readonly LimitWarning[];
  readonly evaluatedAt: string;
}

export interface LimitWarning {
  readonly ruleId: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly windowKey: string;
  readonly threshold: number;
  readonly limit: number;
  readonly consumed: number;
  /** Identity of this warning occurrence; the same key never fires twice. */
  readonly dedupeKey: string;
}

export const LIMIT_EVENT_KINDS = [
  'warning',
  'limit-reached',
  'operation-refused',
  'policy-changed',
  'limit-raised',
  'limit-lowered',
  'policy-reset',
] as const;
export type LimitEventKind = (typeof LIMIT_EVENT_KINDS)[number];

export interface LimitEvent {
  readonly id: string;
  readonly ownerRef: string;
  readonly kind: LimitEventKind;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly ruleId: string | null;
  readonly windowKey: string | null;
  /** Threshold that fired, for a warning; null otherwise. */
  readonly threshold: number | null;
  readonly limit: number | null;
  readonly consumed: number | null;
  readonly requested: number | null;
  readonly message: string;
  /** Identity that makes a repeated warning a no-op. */
  readonly dedupeKey: string;
  readonly actor: string;
  readonly occurredAt: string;
}

/** One audited policy change: who, what, from what, to what, and why. */
export interface LimitAuditRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly action: 'created' | 'updated' | 'reset' | 'platform-updated';
  readonly actor: string;
  readonly reason: string;
  readonly previous: unknown;
  readonly next: unknown;
  readonly occurredAt: string;
}

export type SpendingLimitErrorCode =
  | 'INVALID_POLICY'
  | 'INVALID_RULE'
  | 'INVALID_TARGET'
  | 'INVALID_PERIOD'
  | 'INVALID_MODE'
  | 'INVALID_LIMIT'
  | 'INVALID_THRESHOLD'
  | 'LIMIT_ABOVE_CEILING'
  | 'TOO_MANY_RULES'
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'LIMIT_REFUSED'
  | 'FORBIDDEN';

export class SpendingLimitError extends Error {
  readonly code: SpendingLimitErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: SpendingLimitErrorCode,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SpendingLimitError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isSpendingLimitError(value: unknown): value is SpendingLimitError {
  return value instanceof SpendingLimitError;
}

export function isSpendCategory(value: string): value is SpendCategory {
  return (SPEND_CATEGORIES as readonly string[]).includes(value);
}

export function isLimitTarget(value: string): value is LimitTarget {
  return (LIMIT_TARGETS as readonly string[]).includes(value);
}

export function isLimitPeriod(value: string): value is LimitPeriod {
  return (LIMIT_PERIODS as readonly string[]).includes(value);
}

export function isLimitMode(value: string): value is LimitMode {
  return (LIMIT_MODES as readonly string[]).includes(value);
}

export function isLimitScope(value: string): value is LimitScope {
  return (LIMIT_SCOPES as readonly string[]).includes(value);
}

export function isLimitEventKind(value: string): value is LimitEventKind {
  return (LIMIT_EVENT_KINDS as readonly string[]).includes(value);
}

/** Credits are money-shaped: four decimals, never a float artefact in a total. */
export function creditRound(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
