/**
 * Turning an external operation into credits (Step 56).
 *
 * The rule that costs the most to get wrong: **a missing number is not a zero**.
 * If a connector never reports how many requests it made, the charge says so and
 * prices only what it has. A charge that cannot be priced at all is `unmeasured`
 * at zero credits with the reason on the record.
 *
 * Three exemptions come before any arithmetic, and each says why it happened:
 * an unbillable plan, a free integration, a service billing the user's own
 * account, or a call made with the caller's own credential. None of them is an
 * error, and none of them is a silent zero.
 */

import type { IntegrationBillingPolicy } from './policies.js';
import type {
  BillingClass,
  ChargeBasis,
  IntegrationMeasurement,
  MeasurementLimitation,
  MeasurementUnit,
} from './types.js';
import { isMeasurementUnit } from './types.js';

/** Four decimals, rounded up: a fraction of a credit is never free by accident. */
export function creditRound(value: number): number {
  return Math.ceil(Math.max(0, value) * 10_000) / 10_000;
}

const isCount = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export interface IntegrationEstimate {
  readonly credits: number;
  readonly basis: ChargeBasis;
  /**
   * True when the estimate covers only the flat part, so the real charge may be
   * higher. The UI says "from N" rather than "N".
   */
  readonly lowerBound: boolean;
  /** True when nothing is charged on purpose. */
  readonly exempt: boolean;
  readonly policyId: string | null;
  readonly billingClass: BillingClass;
}

export interface IntegrationEstimateInput {
  readonly policy: IntegrationBillingPolicy | null;
  readonly billingClass: BillingClass;
  /** How many outbound requests the caller expects. Unknown stays unknown. */
  readonly expectedRequests?: number | null;
  readonly expectedUnits?: Partial<Record<MeasurementUnit, number | null>> | null;
  readonly byok?: boolean;
  readonly credential?: 'platform' | 'user' | null;
}

const isUserCredential = (input: {
  readonly byok?: boolean;
  readonly credential?: 'platform' | 'user' | null;
}): boolean => input.byok === true || input.credential === 'user';

const exemptEstimate = (
  input: IntegrationEstimateInput,
  reason: IntegrationEstimate['billingClass'] = input.billingClass,
): IntegrationEstimate => ({
  credits: 0,
  basis: 'exempt',
  lowerBound: false,
  exempt: true,
  policyId: input.policy?.id ?? null,
  billingClass: reason,
});

export function estimateIntegrationCharge(input: IntegrationEstimateInput): IntegrationEstimate {
  const { policy } = input;
  if (input.billingClass === 'free') return exemptEstimate(input);
  if (input.billingClass === 'externally-billed' && policy?.chargeExternallyBilled !== true) {
    return exemptEstimate(input);
  }
  if (isUserCredential(input) && policy?.chargeByok !== true) return exemptEstimate(input);
  if (policy === null) {
    return {
      credits: 0,
      basis: 'unmeasured',
      lowerBound: false,
      exempt: false,
      policyId: null,
      billingClass: input.billingClass,
    };
  }

  const requests = isCount(input.expectedRequests) ? input.expectedRequests : null;
  const flat = policy.perOperation + policy.perRequest * (requests ?? 0);
  let usage = 0;
  let measuredAny = false;
  for (const rate of policy.rates) {
    const reported = input.expectedUnits?.[rate.unit];
    const count = isCount(reported) ? reported : null;
    if (count === null) continue;
    measuredAny = true;
    usage += count * rate.creditsPerUnit;
  }
  const credits = creditRound(flat + usage);
  const basis: ChargeBasis =
    usage > 0 && flat > 0 ? 'flat+usage' : usage > 0 ? 'usage' : flat > 0 ? 'flat' : 'unmeasured';
  return {
    credits,
    basis,
    lowerBound:
      (policy.perRequest > 0 && requests === null) || (policy.rates.length > 0 && !measuredAny),
    exempt: false,
    policyId: policy.id,
    billingClass: input.billingClass,
  };
}

export interface IntegrationComputation {
  readonly credits: number;
  readonly basis: ChargeBasis;
  readonly limitations: readonly MeasurementLimitation[];
  readonly exempt: boolean;
  /** Outbound requests that were measured, or null. */
  readonly requests: number | null;
  /** Unit counts that were measured (or derived from a measured duration). */
  readonly units: Readonly<Partial<Record<MeasurementUnit, number>>>;
  readonly durationMs: number | null;
}

export interface IntegrationComputationInput {
  readonly policy: IntegrationBillingPolicy | null;
  readonly planBillable: boolean;
  readonly billingClass: BillingClass;
  readonly measurement: IntegrationMeasurement;
}

const measuredUnits = (
  measurement: IntegrationMeasurement,
): Partial<Record<MeasurementUnit, number>> => {
  const out: Partial<Record<MeasurementUnit, number>> = {};
  const units = measurement.units;
  if (units === null || units === undefined) return out;
  for (const [key, value] of Object.entries(units)) {
    if (!isMeasurementUnit(key)) continue;
    if (!isCount(value)) continue;
    out[key] = value;
  }
  return out;
};

export function computeIntegrationCharge(
  input: IntegrationComputationInput,
): IntegrationComputation {
  const { policy, measurement } = input;
  const durationMs = isCount(measurement.durationMs) ? measurement.durationMs : null;
  const requests = isCount(measurement.requests) ? measurement.requests : null;
  const units = measuredUnits(measurement);
  // A measured duration is a measured number of seconds. Deriving it here is not
  // an invention: it is the same measurement expressed in the unit the policy
  // prices.
  if (durationMs !== null && units.second === undefined) {
    units.second = durationMs / 1000;
  }

  const exempt = (limitation?: MeasurementLimitation): IntegrationComputation => ({
    credits: 0,
    basis: 'exempt',
    limitations: limitation === undefined ? [] : [limitation],
    exempt: true,
    requests,
    units,
    durationMs,
  });

  if (!input.planBillable) return exempt();
  if (input.billingClass === 'free') return exempt();
  if (input.billingClass === 'externally-billed' && policy?.chargeExternallyBilled !== true) {
    return exempt('external-billing-excluded');
  }
  if (isUserCredential(measurement) && policy?.chargeByok !== true) return exempt('byok-excluded');

  if (policy === null) {
    return {
      credits: 0,
      basis: 'unmeasured',
      limitations: ['no-policy'],
      exempt: false,
      requests,
      units,
      durationMs,
    };
  }

  const limitations: MeasurementLimitation[] = [];
  if (policy.perRequest > 0 && requests === null) limitations.push('request-count-unavailable');

  const flat = policy.perOperation + policy.perRequest * (requests ?? 0);
  let usage = 0;
  for (const rate of policy.rates) {
    if (rate.creditsPerUnit <= 0) continue;
    const count = units[rate.unit];
    if (count === undefined) {
      limitations.push(
        rate.unit === 'second' && durationMs === null
          ? 'duration-unavailable'
          : 'units-unavailable',
      );
      continue;
    }
    usage += count * rate.creditsPerUnit;
  }

  const credits = creditRound(flat + usage);
  const basis: ChargeBasis =
    usage > 0 && flat > 0 ? 'flat+usage' : usage > 0 ? 'usage' : flat > 0 ? 'flat' : 'unmeasured';

  return { credits, basis, limitations, exempt: false, requests, units, durationMs };
}
