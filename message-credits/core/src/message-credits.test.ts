/**
 * What a message charge promises (Step 54).
 *
 * The tests worth writing are the ones a quiet billing bug would pass: a missing
 * measurement must not become a zero-token charge, a cached token must not be
 * billed twice, BYOK must cost nothing, and a retried interaction must not be
 * charged again.
 */

import { describe, expect, it } from 'vitest';

import { computeCharge, creditRound, estimateCharge, flatCredits } from './charge.js';
import {
  canTransition,
  isOpenCharge,
  isSettledCharge,
  MessageCreditError,
  CHARGE_STATE_GUIDE,
} from './lifecycle.js';
import {
  defaultChargingCatalog,
  parseChargingCatalog,
  planCharging,
  policyFor,
} from './policies.js';

const catalog = defaultChargingCatalog();
const paid = planCharging(catalog, 'paid');
const development = planCharging(catalog, 'development');

describe('the shipped policy table', () => {
  it('prices a chat turn flat plus tokens, and says the numbers are defaults', () => {
    const policy = policyFor(paid, 'chat.message', 'openai/gpt-4o-mini');
    expect(policy).not.toBeNull();
    expect(policy?.flat).toEqual({ credits: 1 });
    expect(policy?.tokens?.per1kOutput).toBe(0.75);
    expect(catalog.defaultsOnly).toBe(true);
    expect(catalog.version).toContain('default');
  });

  it('lets a large model cost more without changing the interaction kind', () => {
    const policy = policyFor(paid, 'chat.message', 'anthropic/claude-sonnet');
    expect(policy?.id).toBe('paid.chat.reasoning');
    expect(policy?.flat?.credits).toBe(2);
  });

  it('never applies a model override to a different interaction kind', () => {
    const policy = policyFor(paid, 'coding.run', 'anthropic/claude-sonnet');
    expect(policy?.id).toBe('paid.coding');
  });

  it('refuses a malformed environment table instead of half-applying it', () => {
    expect(() => parseChargingCatalog('not json')).toThrow(/not valid JSON/);
    expect(() => parseChargingCatalog('{"plans": "nope"}')).toThrow(/plans array/);
  });

  it('accepts a deployment table and marks it as no longer defaults-only', () => {
    const custom = parseChargingCatalog(
      JSON.stringify({
        version: 'acme/1',
        plans: [
          {
            planId: 'paid',
            label: 'Paid',
            billable: true,
            policies: [
              {
                id: 'acme.chat',
                label: 'Chat',
                kind: 'chat.message',
                flat: { credits: 4 },
                tokens: null,
                chargeByok: false,
              },
            ],
          },
        ],
      }),
    );
    expect(custom.version).toBe('acme/1');
    expect(custom.defaultsOnly).toBe(false);
    expect(flatCredits(policyFor(planCharging(custom, 'paid'), 'chat.message', null))).toBe(4);
  });
});

describe('measuring a charge', () => {
  const policy = policyFor(paid, 'chat.message', 'openai/gpt-4o-mini');

  it('charges the flat part plus the measured tokens', () => {
    const charge = computeCharge({
      policy,
      planBillable: true,
      measurement: { inputTokens: 1000, outputTokens: 2000, toolCalls: 2 },
    });
    // 1 flat + 0.25 input + 1.50 output + 0.20 tool calls
    expect(charge.credits).toBe(2.95);
    expect(charge.basis).toBe('flat+usage');
    expect(charge.limitations).toEqual([]);
  });

  it('records a missing measurement instead of inventing tokens', () => {
    const charge = computeCharge({ policy, planBillable: true, measurement: {} });
    expect(charge.credits).toBe(1);
    expect(charge.basis).toBe('flat');
    expect(charge.limitations).toContain('tokens-unavailable');
    expect(charge.limitations).toContain('output-tokens-missing');
  });

  it('does not bill a cached token twice', () => {
    const cached = computeCharge({
      policy,
      planBillable: true,
      measurement: { inputTokens: 2000, cachedTokens: 1000, outputTokens: 0, toolCalls: 0 },
    });
    // (1000 billable input at 0.25/1k) + (1000 cached at 0.05/1k) + 1 flat
    expect(cached.credits).toBe(1.3);
  });

  it("never bills a BYOK call's tokens, and says that it did not", () => {
    const charge = computeCharge({
      policy,
      planBillable: true,
      measurement: { inputTokens: 9000, outputTokens: 9000, byok: true },
    });
    // The flat platform charge applies on this paid policy; the provider tokens
    // do not, because the caller's own key paid for them.
    expect(charge.credits).toBe(1);
    expect(charge.basis).toBe('flat');
    expect(charge.limitations).toContain('byok-tokens-excluded');
  });

  it('charges a BYOK call nothing at all on a policy that does not charge BYOK', () => {
    const developmentPolicy = policyFor(development, 'chat.message', null);
    const charge = computeCharge({
      policy: developmentPolicy,
      planBillable: true,
      measurement: { inputTokens: 9000, outputTokens: 9000, byok: true },
    });
    expect(charge.credits).toBe(0);
    expect(charge.exempt).toBe(true);
  });

  it('charges nothing on a non-billable plan, whatever the policy says', () => {
    const charge = computeCharge({
      policy: policyFor(development, 'chat.message', null),
      planBillable: false,
      measurement: { inputTokens: 5000, outputTokens: 5000 },
    });
    expect(charge.exempt).toBe(true);
    expect(charge.credits).toBe(0);
  });

  it('prices an interaction with no policy at zero and flags the gap', () => {
    const charge = computeCharge({
      policy: null,
      planBillable: true,
      measurement: { inputTokens: 10, outputTokens: 10 },
    });
    expect(charge.credits).toBe(0);
    expect(charge.basis).toBe('unmeasured');
    expect(charge.limitations).toContain('provider-not-reported');
  });

  it('rounds up so a fraction of a credit is never free', () => {
    expect(creditRound(0.00001)).toBe(0.0001);
    expect(creditRound(1.23456)).toBe(1.2346);
  });
});

describe('estimating before the work', () => {
  const policy = policyFor(paid, 'chat.message', 'openai/gpt-4o-mini');

  it('is a lower bound when the prompt size is unknown', () => {
    const estimate = estimateCharge({ policy });
    expect(estimate.credits).toBe(1);
    expect(estimate.lowerBound).toBe(true);
  });

  it('includes tokens the caller actually declared', () => {
    const estimate = estimateCharge({
      policy,
      expectedInputTokens: 1000,
      maxOutputTokens: 1000,
    });
    expect(estimate.credits).toBe(2);
    expect(estimate.lowerBound).toBe(false);
    expect(estimate.basis).toBe('flat+usage');
  });

  it('estimates only the flat part for a BYOK request', () => {
    const estimate = estimateCharge({ policy, byok: true, expectedInputTokens: 9000 });
    expect(estimate.credits).toBe(1);
    expect(estimate.exempt).toBe(false);
  });
});

describe('the charge lifecycle', () => {
  it('lets a hold settle once and never reopen', () => {
    expect(canTransition('reserved', 'committed')).toBe(true);
    expect(canTransition('reserved', 'released')).toBe(true);
    expect(canTransition('committed', 'refunded')).toBe(true);
    expect(canTransition('committed', 'reserved')).toBe(false);
    expect(canTransition('released', 'committed')).toBe(false);
    expect(canTransition('refunded', 'committed')).toBe(false);
  });

  it('knows which states are still open', () => {
    expect(isOpenCharge('reserved')).toBe(true);
    expect(isSettledCharge('committed')).toBe(true);
    expect(isSettledCharge('released')).toBe(true);
  });

  it('explains every state it can report', () => {
    for (const guide of Object.values(CHARGE_STATE_GUIDE)) {
      expect(guide.length).toBeGreaterThan(10);
    }
  });

  it('carries a status and a code on a refusal', () => {
    const error = new MessageCreditError('INSUFFICIENT_CREDITS', 'Not enough credit.', 402, {
      required: 5,
    });
    expect(error.status).toBe(402);
    expect(error.details['required']).toBe(5);
  });
});
