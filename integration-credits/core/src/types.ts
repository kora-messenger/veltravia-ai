/**
 * Integration-credit vocabulary (Step 56).
 *
 * Third-party work is not one thing. A connector call made with the platform's
 * own credential is work Veltravia pays for and may price in credits. A call the
 * user makes with their own key is billed to their own account, so charging them
 * credits on top would charge twice. An integration that costs nothing to run is
 * free and must say so. And a service that bills the user directly is not a
 * Veltravia charge at all.
 *
 * Those three cases are the `BillingClass`, and they are recorded on every row:
 * a zero or an "exempt" charge is then explainable later instead of looking like
 * a charge that quietly failed.
 *
 * The charge itself is one row per billable operation, because an operation is
 * what a person did. A measurement that was never reported is recorded as a
 * limitation, never filled with a plausible number.
 */

export const INTEGRATION_OPERATION_KINDS = [
  /** An operation executed through the integration runtime. */
  'integration.operation',
  /** An operation executed through the connector framework. */
  'connector.operation',
  /** A plugin or extension operation. */
  'plugin.operation',
  /** A call to a service that bills the user's own external account. */
  'external.service',
] as const;

export type IntegrationOperationKind = (typeof INTEGRATION_OPERATION_KINDS)[number];

export const isIntegrationOperationKind = (value: string): value is IntegrationOperationKind =>
  (INTEGRATION_OPERATION_KINDS as readonly string[]).includes(value);

/**
 * Who pays for the external work.
 *
 *  - `free`: the integration costs nothing to run. Never charged, never held.
 *  - `paid`: Veltravia provides the credential (or the service), so it may price
 *    the operation in credits.
 *  - `externally-billed`: the external service charges the user's own account.
 *    Credits are only charged when a policy explicitly says so; the default is
 *    never, because billing somebody twice for one call is not a pricing choice.
 */
export const BILLING_CLASSES = ['free', 'paid', 'externally-billed'] as const;

export type BillingClass = (typeof BILLING_CLASSES)[number];

export const isBillingClass = (value: string): value is BillingClass =>
  (BILLING_CLASSES as readonly string[]).includes(value);

/**
 * The lifecycle of one integration charge. Every transition is one-way; a refund
 * moves a committed charge to `refunded` through the wallet's own refund path
 * rather than editing the amount.
 */
export const CHARGE_STATES = [
  /** Credit is held; the operation has not finished reporting. */
  'reserved',
  /** Measured (or policy-priced) and posted to the wallet ledger. */
  'committed',
  /** The hold went back: the operation failed, was refused, cancelled or expired. */
  'released',
  /** Nothing was charged on purpose: free, externally billed or BYOK work. */
  'exempt',
  /** Committed, then given back through the wallet's refund path. */
  'refunded',
] as const;

export type ChargeState = (typeof CHARGE_STATES)[number];

export const isChargeState = (value: string): value is ChargeState =>
  (CHARGE_STATES as readonly string[]).includes(value);

/** States a charge can still move out of. A settled charge is history. */
export const OPEN_CHARGE_STATES: readonly ChargeState[] = ['reserved'];

/** How the number of credits was arrived at. */
export const CHARGE_BASES = [
  /** A configured price per operation and/or per request. */
  'flat',
  /** A configured price per measured unit. */
  'usage',
  /** Both a flat part and a measured part. */
  'flat+usage',
  /** Nothing was measurable and the policy has no flat price, so nothing is owed. */
  'unmeasured',
  /** Free, externally billed or BYOK: this platform charges nothing. */
  'exempt',
] as const;

export type ChargeBasis = (typeof CHARGE_BASES)[number];

export const isChargeBasis = (value: string): value is ChargeBasis =>
  (CHARGE_BASES as readonly string[]).includes(value);

/**
 * What a policy can price and what a connector can report.
 *
 * These are units of *external work*, not units of platform compute: one outbound
 * request, one record transferred, one byte, one page, one token, one second of
 * billable service time, one underlying API call.
 */
export const MEASUREMENT_UNITS = [
  'request',
  'record',
  'byte',
  'page',
  'token',
  'second',
  'call',
] as const;

export type MeasurementUnit = (typeof MEASUREMENT_UNITS)[number];

export const isMeasurementUnit = (value: string): value is MeasurementUnit =>
  (MEASUREMENT_UNITS as readonly string[]).includes(value);

/**
 * Why a measurement is missing or partial. Recorded on the charge so a zero or a
 * flat charge is explainable rather than suspicious.
 */
export const MEASUREMENT_LIMITATIONS = [
  /** The operation ran but nobody reported how many requests it made. */
  'request-count-unavailable',
  /** A configured per-unit rate had no unit count to apply to. */
  'units-unavailable',
  /** The policy prices seconds and the duration was not reported. */
  'duration-unavailable',
  /** The service bills the user's own account; Veltravia did not charge. */
  'external-billing-excluded',
  /** The caller used their own credential; its provider bill is theirs. */
  'byok-excluded',
  /** No policy covers this operation, so there was no price to apply. */
  'no-policy',
] as const;

export type MeasurementLimitation = (typeof MEASUREMENT_LIMITATIONS)[number];

/** Where the counts came from: the platform, the connector, or nobody. */
export type MeasurementSource = 'platform' | 'connector' | 'unavailable';

/** What the caller measured. Absent fields are unknown, not zero. */
export interface IntegrationMeasurement {
  /** Outbound requests the operation made. Unknown stays unknown. */
  readonly requests?: number | null;
  /** Unit counts by kind. Absent keys are unknown, not zero. */
  readonly units?: Partial<Record<MeasurementUnit, number | null>> | null;
  /** Wall-clock duration of the external work, when it was measured. */
  readonly durationMs?: number | null;
  /** Who reported the numbers. Absent means the settlement decides from the data. */
  readonly source?: MeasurementSource;
  /**
   * Which credential paid for the external call. `user` means the caller's own
   * account and can never be charged for its usage unless a policy says so.
   */
  readonly credential?: 'platform' | 'user' | null;
  /** True when the caller supplied their own credential. */
  readonly byok?: boolean;
}

/**
 * One integration charge: who, where, which integration, which connector, which
 * operation, and which execution it belonged to.
 *
 * The association is the point. A charge that cannot name the execution it paid
 * for is a number the owner cannot check, so every identifier the platform knows
 * when it takes the hold is written down.
 */
export interface IntegrationCharge {
  readonly id: string;
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  /** e.g. `github`, `mock-storage`. Null when the path is not integration-specific. */
  readonly integrationId: string | null;
  /** The connector the operation ran through, when it is a connector. */
  readonly connectorId: string | null;
  readonly pluginId: string | null;
  /** The external operation, e.g. `contents.get`. */
  readonly operationId: string | null;
  /** The run, worker, task or execution the operation served. */
  readonly executionId: string | null;
  /** The single tool invocation this charge paid for, when there was one. */
  readonly requestId: string | null;
  readonly connectionId: string | null;
  readonly kind: IntegrationOperationKind;
  readonly billingClass: BillingClass;
  /** The plan in force when the charge was taken. */
  readonly planId: string;
  readonly policyId: string;
  readonly credits: number;
  readonly estimatedCredits: number;
  readonly state: ChargeState;
  readonly basis: ChargeBasis;
  /** Outbound requests measured for this operation. Null = nobody reported. */
  readonly requests: number | null;
  /** Unit counts measured for this operation. Empty = nothing was reported. */
  readonly units: Readonly<Partial<Record<MeasurementUnit, number>>>;
  readonly durationMs: number | null;
  readonly limitations: readonly MeasurementLimitation[];
  readonly measurementSource: MeasurementSource | null;
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
export interface IntegrationChargeDraft {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly integrationId?: string | null;
  readonly connectorId?: string | null;
  readonly pluginId?: string | null;
  readonly operationId?: string | null;
  readonly executionId?: string | null;
  readonly requestId?: string | null;
  readonly connectionId?: string | null;
  readonly kind: IntegrationOperationKind;
  readonly billingClass: BillingClass;
  readonly planId: string;
  readonly estimatedCredits: number;
  readonly policyId: string;
  readonly byok?: boolean;
  readonly idempotencyKey: string;
}

export interface ChargeFilter {
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly integrationId?: string | null;
  readonly connectorId?: string | null;
  readonly operationId?: string | null;
  readonly executionId?: string | null;
  readonly kind?: IntegrationOperationKind;
  readonly state?: ChargeState;
  readonly billingClass?: BillingClass;
  readonly limit: number;
  readonly offset?: number;
}

/** One row of the dashboard's "where did the integration credit go" answers. */
export interface UsageGroup {
  readonly key: string;
  readonly charges: number;
  readonly credits: number;
  readonly requests: number;
  /** Total measured units across kinds. A lower bound, never a guess. */
  readonly units: number;
}
