/**
 * Message-credit vocabulary (Step 54).
 *
 * A message credit is charged once per billable interaction, and the
 * interaction is described before it is charged: which conversation, which run,
 * which project, which model, which provider. That is what makes a charge
 * explainable six weeks later.
 *
 * Two things are deliberately kept apart:
 *
 *  - `credits` is what this platform charged for the interaction.
 *  - the token counts are what the provider reported. They are *inputs* to the
 *    charge, never a price, and never invented: a missing measurement is
 *    recorded as a limitation instead of being estimated into existence.
 */

export const INTERACTION_KINDS = [
  'chat.message',
  'chat.assistant',
  'coding.run',
  'agent.execution',
  'agent.run',
  'reasoning.run',
  'tool.call',
  'background.task',
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const isInteractionKind = (value: string): value is InteractionKind =>
  (INTERACTION_KINDS as readonly string[]).includes(value);

/**
 * The lifecycle of one charge. Every transition is one-way except a refund,
 * which moves a committed charge to `refunded` without editing it.
 */
export const CHARGE_STATES = [
  /** Credit is held; the work has not reported usage yet. */
  'reserved',
  /** Measured (or policy-priced) and posted to the wallet ledger. */
  'committed',
  /** The hold went back to the wallet: the work failed, was cancelled or expired. */
  'released',
  /** Nothing was charged on purpose: BYOK provider calls and pilot plans. */
  'exempt',
  /** Committed, then given back through the wallet's refund path. */
  'refunded',
] as const;

export type ChargeState = (typeof CHARGE_STATES)[number];

/** States a charge can still move out of. A settled charge is history. */
export const OPEN_CHARGE_STATES: readonly ChargeState[] = ['reserved'];

export const isChargeState = (value: string): value is ChargeState =>
  (CHARGE_STATES as readonly string[]).includes(value);

/** How the number of credits was arrived at. Never a guess dressed as a fact. */
export const CHARGE_BASES = [
  /** One configured price per interaction. */
  'flat',
  /** Configured price per measured token (and/or per tool call). */
  'usage',
  /** A flat price plus the measured part. */
  'flat+usage',
  /** Nothing was measured and the policy has no flat price, so nothing is owed. */
  'unmeasured',
  /** BYOK: the provider bill is the caller's, so this platform charges nothing. */
  'exempt',
] as const;

export type ChargeBasis = (typeof CHARGE_BASES)[number];

/**
 * Why a measurement is missing or partial. Recorded on the charge so a zero or
 * a flat charge is explainable rather than suspicious.
 */
export const MEASUREMENT_LIMITATIONS = [
  'tokens-unavailable',
  'output-tokens-missing',
  'cached-tokens-unavailable',
  'duration-unavailable',
  'tool-calls-unavailable',
  'provider-not-reported',
  'byok-tokens-excluded',
] as const;

export type MeasurementLimitation = (typeof MEASUREMENT_LIMITATIONS)[number];

/** What the caller measured. Absent fields are unknown, not zero. */
export interface UsageMeasurement {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedTokens?: number | null;
  readonly durationMs?: number | null;
  readonly toolCalls?: number | null;
  /** Who reported the counts. Absent means the settlement decides from the data. */
  readonly source?: MeasurementSource;
  readonly modelId?: string | null;
  readonly providerId?: string | null;
  /**
   * True when the caller supplied their own provider credential. The provider's
   * token cost is theirs, so it is never billed here; the platform's flat charge
   * for running the interaction still applies on plans that charge BYOK.
   */
  readonly byok?: boolean;
}

/**
 * Where a charge's token counts came from. A provider number and a caller's own
 * count are different claims, and neither is the same as "nobody said".
 */
export type MeasurementSource = 'provider' | 'caller' | 'unavailable';

export interface MessageCharge {
  readonly id: string;
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  /** The agent task this charge served, when it served one. */
  readonly taskId: string | null;
  /**
   * The charge of the operation this one was delegated from. A sub-agent's work
   * points at its parent so one interaction can be read as a whole.
   */
  readonly parentChargeId: string | null;
  /** The Step 52 usage event this charge belongs to, when there is one. */
  readonly usageOperationKey: string | null;
  readonly kind: InteractionKind;
  readonly modelId: string | null;
  readonly providerId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly durationMs: number | null;
  readonly toolCalls: number | null;
  readonly credits: number;
  readonly estimatedCredits: number;
  readonly state: ChargeState;
  readonly basis: ChargeBasis;
  readonly policyId: string;
  readonly limitations: readonly MeasurementLimitation[];
  /** Where the token counts came from; null on rows written before Step 55. */
  readonly measurementSource: MeasurementSource | null;
  /** Credits the cached part saved under the policy in force at settlement. */
  readonly cachedSavings: number | null;
  readonly byok: boolean;
  readonly idempotencyKey: string;
  readonly reservationId: string | null;
  readonly walletEntryId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly refundedAt: string | null;
}

/** A charge that has not been written yet. */
export interface MessageChargeDraft {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly conversationId?: string | null;
  readonly runId?: string | null;
  readonly taskId?: string | null;
  readonly parentChargeId?: string | null;
  readonly usageOperationKey?: string | null;
  readonly kind: InteractionKind;
  readonly modelId?: string | null;
  readonly providerId?: string | null;
  readonly estimatedCredits: number;
  readonly policyId: string;
  readonly byok?: boolean;
  readonly idempotencyKey: string;
}

export interface ChargeFilter {
  readonly workspaceId?: string | null;
  readonly conversationId?: string | null;
  readonly projectId?: string | null;
  readonly runId?: string | null;
  readonly kind?: InteractionKind;
  readonly state?: ChargeState;
  /**
   * Step 58: the bounds a usage history asks for. `since` and `until` are
   * inclusive ISO instants compared against `createdAt`, so a date range is
   * answered by the store rather than by reading the table into memory.
   * `modelId`, `providerId` and `query` exist for the same reason: a filter that
   * only works on the page already fetched is a filter that lies about the rest.
   */
  readonly since?: string;
  readonly until?: string;
  /**
   * Keyset cursor: only rows strictly older than this (createdAt, id) pair.
   *
   * A timestamp alone is not a page boundary - two charges written in the same
   * millisecond would straddle it - so the pair is compared the way the store
   * orders its rows, and a page neither repeats nor skips a sibling.
   */
  readonly beforeAt?: string;
  readonly beforeId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  /** Case-insensitive match on the charge id, model, provider or project. */
  readonly query?: string;
  readonly limit: number;
  readonly offset?: number;
}

/** One row of the dashboard's "where did it go" answers. */
export interface UsageGroup {
  readonly key: string;
  readonly charges: number;
  readonly credits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}
