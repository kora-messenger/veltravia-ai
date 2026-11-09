/**
 * Turning a measurement into credits (Step 54).
 *
 * The rule that costs the most to get wrong: **a missing number is not a zero**.
 * If a provider does not report output tokens, the charge says so and prices
 * only what it has, instead of inventing a plausible count. A charge that cannot
 * be priced at all is `unmeasured` at zero credits, with the limitation on the
 * record so the reason survives.
 *
 * Cached tokens are a subset of input tokens at most providers, so the input
 * rate is applied to `input - cached` and the cache rate to `cached`. Charging
 * the full input count and the cache count would bill the same token twice.
 */

import type { ChargingPolicy } from './policies.js';
import type { ChargeBasis, MeasurementLimitation, UsageMeasurement } from './types.js';

/** Four decimals, rounded up: a fraction of a credit is never free by accident. */
export function creditRound(value: number): number {
  return Math.ceil(Math.max(0, value) * 10_000) / 10_000;
}

export interface ChargeComputation {
  readonly credits: number;
  readonly basis: ChargeBasis;
  readonly limitations: readonly MeasurementLimitation[];
  /** True when the policy says nothing is charged on purpose. */
  readonly exempt: boolean;
}

const isCount = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** What the flat part alone costs, used for an estimate and as a floor. */
export function flatCredits(policy: ChargingPolicy | null): number {
  return policy?.flat === null || policy === null ? 0 : creditRound(policy.flat.credits);
}

export interface EstimateInput {
  readonly policy: ChargingPolicy | null;
  /** How many tokens the caller expects to send. Unknown stays unknown. */
  readonly expectedInputTokens?: number | null;
  /**
   * The output cap the caller asked for. Used only when it is a real number the
   * caller set, never as a stand-in for a measurement.
   */
  readonly maxOutputTokens?: number | null;
  readonly byok?: boolean;
}

export interface ChargeEstimate {
  readonly credits: number;
  readonly basis: ChargeBasis;
  /**
   * True when the estimate covers only the flat part, so the real charge may be
   * higher. The UI says "from N" rather than "N".
   */
  readonly lowerBound: boolean;
  readonly exempt: boolean;
  readonly policyId: string | null;
}

export function estimateCharge(input: EstimateInput): ChargeEstimate {
  const { policy } = input;
  if (policy === null) {
    return {
      credits: 0,
      basis: 'unmeasured',
      lowerBound: false,
      exempt: false,
      policyId: null,
    };
  }
  if (input.byok === true) {
    const flatOnly = policy.chargeByok ? flatCredits(policy) : 0;
    return {
      credits: flatOnly,
      basis: flatOnly > 0 ? 'flat' : 'exempt',
      lowerBound: false,
      exempt: flatOnly === 0,
      policyId: policy.id,
    };
  }
  const flat = flatCredits(policy);
  const tokens = policy.tokens;
  if (tokens === null) {
    return {
      credits: flat,
      basis: flat > 0 ? 'flat' : 'unmeasured',
      lowerBound: false,
      exempt: false,
      policyId: policy.id,
    };
  }
  const expectedInput = isCount(input.expectedInputTokens) ? input.expectedInputTokens : null;
  const outputCap = isCount(input.maxOutputTokens) ? input.maxOutputTokens : null;
  const tokenPart =
    (expectedInput === null ? 0 : (expectedInput / 1000) * tokens.per1kInput) +
    (outputCap === null ? 0 : (outputCap / 1000) * tokens.per1kOutput);
  const credits = creditRound(flat + tokenPart);
  return {
    credits,
    basis: tokenPart > 0 ? (flat > 0 ? 'flat+usage' : 'usage') : flat > 0 ? 'flat' : 'unmeasured',
    lowerBound: expectedInput === null || outputCap === null,
    exempt: false,
    policyId: policy.id,
  };
}

export function computeCharge(input: {
  readonly policy: ChargingPolicy | null;
  readonly planBillable: boolean;
  readonly measurement: UsageMeasurement;
}): ChargeComputation {
  const { policy, measurement } = input;
  if (!input.planBillable) {
    return { credits: 0, basis: 'exempt', limitations: [], exempt: true };
  }
  if (policy === null) {
    return {
      credits: 0,
      basis: 'unmeasured',
      limitations: ['provider-not-reported'],
      exempt: false,
    };
  }
  if (measurement.byok === true) {
    // The caller's own key paid the provider. Their token cost is never billed
    // here; the platform's flat charge for running the interaction only applies
    // on a policy that explicitly charges BYOK.
    const flatOnly = policy.chargeByok ? flatCredits(policy) : 0;
    return {
      credits: flatOnly,
      basis: flatOnly > 0 ? 'flat' : 'exempt',
      limitations: ['byok-tokens-excluded'],
      exempt: flatOnly === 0,
    };
  }

  const limitations: MeasurementLimitation[] = [];
  const flat = flatCredits(policy);
  const tokens = policy.tokens;

  if (tokens === null) {
    return {
      credits: flat,
      basis: flat > 0 ? 'flat' : 'unmeasured',
      limitations: flat > 0 ? [] : ['tokens-unavailable'],
      exempt: false,
    };
  }

  const inputTokens = isCount(measurement.inputTokens) ? measurement.inputTokens : null;
  const outputTokens = isCount(measurement.outputTokens) ? measurement.outputTokens : null;
  const cachedTokens = isCount(measurement.cachedTokens) ? measurement.cachedTokens : null;
  const toolCalls = isCount(measurement.toolCalls) ? measurement.toolCalls : null;

  if (inputTokens === null) limitations.push('tokens-unavailable');
  if (outputTokens === null) limitations.push('output-tokens-missing');
  // Cached tokens are not a limitation when unreported: the same tokens are
  // already counted in the input total and charged at the input rate, which is
  // the higher of the two. Silence there cannot understate the charge.
  if (toolCalls === null) limitations.push('tool-calls-unavailable');

  // Cached tokens are part of the input count; charge them once, at the cache
  // rate, and the rest at the input rate.
  const cached = cachedTokens === null ? 0 : Math.min(cachedTokens, inputTokens ?? cachedTokens);
  const billableInput = inputTokens === null ? 0 : Math.max(0, inputTokens - cached);
  const tokenPart =
    (billableInput / 1000) * tokens.per1kInput +
    (cached / 1000) * tokens.per1kCached +
    ((outputTokens ?? 0) / 1000) * tokens.per1kOutput +
    (toolCalls ?? 0) * tokens.perToolCall;

  const measuredAnything =
    inputTokens !== null || outputTokens !== null || cached !== 0 || (toolCalls ?? 0) > 0;
  const credits = creditRound(flat + tokenPart);
  const basis: ChargeBasis =
    !measuredAnything && flat === 0
      ? 'unmeasured'
      : tokenPart > 0 && flat > 0
        ? 'flat+usage'
        : tokenPart > 0
          ? 'usage'
          : 'flat';

  return { credits, basis, limitations, exempt: false };
}
