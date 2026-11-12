import { describe, expect, it } from 'vitest';

import {
  billingClassFor,
  canTransition,
  computeIntegrationCharge,
  creditRound,
  defaultIntegrationBillingCatalog,
  estimateIntegrationCharge,
  InMemoryIntegrationCreditStore,
  IntegrationCreditError,
  isIntegrationCreditError,
  parseIntegrationBillingCatalog,
  planBilling,
  resolveIntegrationPolicy,
  type IntegrationCharge,
} from './index.js';

const PAID = () => planBilling(defaultIntegrationBillingCatalog(), 'paid');

const chargeRow = (over: Partial<IntegrationCharge> = {}): IntegrationCharge => ({
  id: 'ich_one',
  ownerRef: 'owner-a',
  workspaceId: null,
  projectId: null,
  integrationId: 'github',
  connectorId: null,
  pluginId: null,
  operationId: 'contents.get',
  executionId: 'run-1',
  requestId: 'inv-1',
  connectionId: 'conn-1',
  kind: 'integration.operation',
  billingClass: 'paid',
  planId: 'paid',
  policyId: 'paid.integration.github',
  credits: 0,
  estimatedCredits: 0,
  state: 'reserved',
  basis: 'flat',
  requests: null,
  units: {},
  durationMs: null,
  limitations: [],
  measurementSource: null,
  byok: false,
  idempotencyKey: 'k-1',
  reservationId: null,
  walletEntryId: null,
  failureReason: null,
  createdAt: '2026-11-11T10:00:00.000Z',
  settledAt: null,
  refundedAt: null,
  ...over,
});

describe('policy resolution', () => {
  it('prefers the exact integration and operation over the kind default', () => {
    const plan = PAID();
    const github = resolveIntegrationPolicy(plan, {
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
    });
    expect(github?.id).toBe('paid.integration.github');

    const other = resolveIntegrationPolicy(plan, {
      kind: 'integration.operation',
      integrationId: 'slack',
      operationId: 'chat.post',
    });
    expect(other?.id).toBe('paid.integration');
  });

  it('keeps offline integrations free on the paid plan', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'integration.operation',
      integrationId: 'mock-storage',
      operationId: 'storage.objects.get',
    });
    expect(policy?.billingClass).toBe('free');
    expect(billingClassFor(policy)).toBe('free');
  });

  it('never lets a policy of another kind price the operation', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'external.service',
      integrationId: 'github',
      operationId: 'contents.get',
    });
    expect(policy?.id).toBe('paid.external');
  });

  it('falls back to the development plan for an unknown plan id', () => {
    const plan = planBilling(defaultIntegrationBillingCatalog(), 'mystery');
    expect(plan.planId).toBe('development');
    expect(plan.billable).toBe(false);
  });
});

describe('catalog parsing', () => {
  it('labels the shipped table as defaults', () => {
    const catalog = defaultIntegrationBillingCatalog();
    expect(catalog.defaultsOnly).toBe(true);
    expect(catalog.currency).toBe('credits');
  });

  it('reads a deployment table and stops calling it defaults', () => {
    const catalog = parseIntegrationBillingCatalog(
      JSON.stringify({
        version: 'custom-1',
        plans: [
          {
            planId: 'paid',
            billable: true,
            policies: [
              {
                id: 'custom.github',
                label: 'GitHub',
                kind: 'integration.operation',
                integrationId: 'github',
                perOperation: 2,
                perRequest: 0.5,
                rates: [{ unit: 'record', creditsPerUnit: 0.01 }],
              },
            ],
          },
        ],
      }),
    );
    expect(catalog.defaultsOnly).toBe(false);
    expect(catalog.version).toBe('custom-1');
    const github = catalog.plans[0]?.policies[0];
    expect(github?.perOperation).toBe(2);
    expect(github?.rates[0]?.creditsPerUnit).toBe(0.01);
    // Absent flags default to the conservative answer.
    expect(github?.chargeByok).toBe(false);
    expect(github?.chargeExternallyBilled).toBe(false);
  });

  it('refuses malformed JSON instead of guessing a price table', () => {
    expect(() => parseIntegrationBillingCatalog('{not json')).toThrow(/not valid JSON/);
    expect(() => parseIntegrationBillingCatalog('{"plans": 3}')).toThrow(/plans array/);
  });
});

describe('estimate', () => {
  it('prices a paid operation from the flat part', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
    });
    const estimate = estimateIntegrationCharge({
      policy,
      billingClass: 'paid',
      expectedRequests: 2,
      expectedUnits: { record: 10 },
    });
    // 0.4 flat + 2 * 0.04 requests => 0.48; GitHub has no per-record rate.
    expect(estimate.credits).toBeCloseTo(0.48, 4);
    expect(estimate.basis).toBe('flat');
    expect(estimate.exempt).toBe(false);
  });

  it('marks an estimate without a request count as a lower bound', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'connector.operation',
      integrationId: 'slack',
    });
    const estimate = estimateIntegrationCharge({ policy, billingClass: 'paid' });
    expect(estimate.lowerBound).toBe(true);
    expect(estimate.credits).toBeCloseTo(0.25, 4);
  });

  it('estimates nothing for a free integration', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'integration.operation',
      integrationId: 'mock-storage',
    });
    const estimate = estimateIntegrationCharge({ policy, billingClass: 'free' });
    expect(estimate).toMatchObject({ credits: 0, exempt: true, billingClass: 'free' });
  });

  it('estimates nothing for an externally billed service', () => {
    const policy = resolveIntegrationPolicy(PAID(), { kind: 'external.service' });
    const estimate = estimateIntegrationCharge({ policy, billingClass: 'externally-billed' });
    expect(estimate.exempt).toBe(true);
  });

  it('estimates nothing for a BYOK call', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'integration.operation',
      integrationId: 'github',
    });
    const estimate = estimateIntegrationCharge({ policy, billingClass: 'paid', byok: true });
    expect(estimate.exempt).toBe(true);
    expect(estimate.credits).toBe(0);
  });
});

describe('settlement', () => {
  const github = () =>
    resolveIntegrationPolicy(PAID(), {
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
    });

  it('charges per operation and per request against what was measured', () => {
    const result = computeIntegrationCharge({
      policy: github(),
      planBillable: true,
      billingClass: 'paid',
      measurement: { requests: 3, source: 'connector' },
    });
    expect(result.credits).toBeCloseTo(0.4 + 3 * 0.04, 4);
    expect(result.basis).toBe('flat');
    expect(result.limitations).toEqual([]);
    expect(result.requests).toBe(3);
  });

  it('records an unreported request count instead of inventing one', () => {
    const result = computeIntegrationCharge({
      policy: github(),
      planBillable: true,
      billingClass: 'paid',
      measurement: { requests: null, source: 'unavailable' },
    });
    expect(result.credits).toBeCloseTo(0.4, 4);
    expect(result.limitations).toContain('request-count-unavailable');
  });

  it('charges measured units at the configured rate', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'connector.operation',
      integrationId: 'slack',
    });
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'paid',
      measurement: { requests: 2, units: { record: 500 } },
    });
    // 0.25 + 2 * 0.02 + 500 * 0.001
    expect(result.credits).toBeCloseTo(0.25 + 0.04 + 0.5, 4);
    expect(result.basis).toBe('flat+usage');
    expect(result.units.record).toBe(500);
  });

  it('records missing units for a configured rate', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'connector.operation',
      integrationId: 'slack',
    });
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'paid',
      measurement: { requests: 1 },
    });
    expect(result.limitations).toContain('units-unavailable');
    expect(result.credits).toBeCloseTo(0.25 + 0.02, 4);
  });

  it('derives seconds from a measured duration', () => {
    const policy = {
      id: 'custom.seconds',
      label: 'Seconds',
      kind: 'external.service' as const,
      integrationId: '*',
      operationId: '*',
      billingClass: 'paid' as const,
      perOperation: 0,
      perRequest: 0,
      rates: [{ unit: 'second' as const, creditsPerUnit: 0.01 }],
      chargeExternallyBilled: true,
      chargeByok: false,
    };
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'paid',
      measurement: { durationMs: 2500 },
    });
    expect(result.units.second).toBe(2.5);
    expect(result.credits).toBeCloseTo(0.025, 4);
    expect(result.basis).toBe('usage');
  });

  it('records a missing duration when the policy prices seconds', () => {
    const policy = {
      id: 'custom.seconds',
      label: 'Seconds',
      kind: 'external.service' as const,
      integrationId: '*',
      operationId: '*',
      billingClass: 'paid' as const,
      perOperation: 0,
      perRequest: 0,
      rates: [{ unit: 'second' as const, creditsPerUnit: 0.01 }],
      chargeExternallyBilled: true,
      chargeByok: false,
    };
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'paid',
      measurement: {},
    });
    expect(result.limitations).toContain('duration-unavailable');
    expect(result.credits).toBe(0);
    expect(result.basis).toBe('unmeasured');
  });

  it('never charges a free integration', () => {
    const policy = resolveIntegrationPolicy(PAID(), {
      kind: 'integration.operation',
      integrationId: 'mock-storage',
    });
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'free',
      measurement: { requests: 9, units: { record: 900 } },
    });
    expect(result).toMatchObject({ credits: 0, exempt: true, basis: 'exempt' });
    expect(result.limitations).toEqual([]);
  });

  it('never charges an externally billed service without explicit authorisation', () => {
    const policy = resolveIntegrationPolicy(PAID(), { kind: 'external.service' });
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'externally-billed',
      measurement: { requests: 5 },
    });
    expect(result.exempt).toBe(true);
    expect(result.limitations).toEqual(['external-billing-excluded']);
  });

  it('charges an externally billed service only when a policy says to', () => {
    const policy = {
      id: 'paid.external.authorised',
      label: 'Authorised external',
      kind: 'external.service' as const,
      integrationId: '*',
      operationId: '*',
      billingClass: 'externally-billed' as const,
      perOperation: 1,
      perRequest: 0,
      rates: [],
      chargeExternallyBilled: true,
      chargeByok: false,
    };
    const result = computeIntegrationCharge({
      policy,
      planBillable: true,
      billingClass: 'externally-billed',
      measurement: { requests: 1 },
    });
    expect(result.exempt).toBe(false);
    expect(result.credits).toBe(1);
  });

  it('never charges usage on the caller own credential', () => {
    const result = computeIntegrationCharge({
      policy: github(),
      planBillable: true,
      billingClass: 'paid',
      measurement: { requests: 4, credential: 'user' },
    });
    expect(result.exempt).toBe(true);
    expect(result.credits).toBe(0);
    expect(result.limitations).toEqual(['byok-excluded']);
  });

  it('records that no policy covered the operation', () => {
    const result = computeIntegrationCharge({
      policy: null,
      planBillable: true,
      billingClass: 'paid',
      measurement: { requests: 1 },
    });
    expect(result.credits).toBe(0);
    expect(result.basis).toBe('unmeasured');
    expect(result.limitations).toEqual(['no-policy']);
  });

  it('exempts an unbillable plan whatever the measurement says', () => {
    const result = computeIntegrationCharge({
      policy: github(),
      planBillable: false,
      billingClass: 'paid',
      measurement: { requests: 10 },
    });
    expect(result).toMatchObject({ credits: 0, exempt: true, basis: 'exempt' });
  });

  it('rounds up to four decimals so a fraction is never silently free', () => {
    expect(creditRound(0.00001)).toBe(0.0001);
    expect(creditRound(0)).toBe(0);
    expect(creditRound(-5)).toBe(0);
  });
});

describe('lifecycle', () => {
  it('lets a hold settle, release or become exempt, once', () => {
    expect(canTransition('reserved', 'committed')).toBe(true);
    expect(canTransition('reserved', 'released')).toBe(true);
    expect(canTransition('reserved', 'exempt')).toBe(true);
    expect(canTransition('committed', 'refunded')).toBe(true);
    expect(canTransition('committed', 'released')).toBe(false);
    expect(canTransition('released', 'reserved')).toBe(false);
    expect(canTransition('refunded', 'committed')).toBe(false);
  });

  it('carries a typed error with a status and details', () => {
    const error = new IntegrationCreditError('NO_CREDIT', 'Not enough credit.', 402, {
      shortfall: 3,
    });
    expect(isIntegrationCreditError(error)).toBe(true);
    expect(error.status).toBe(402);
    expect(error.details['shortfall']).toBe(3);
    expect(isIntegrationCreditError(new Error('x'))).toBe(false);
  });
});

describe('in-memory store', () => {
  it('returns the first row for a repeated idempotency key', async () => {
    const store = new InMemoryIntegrationCreditStore();
    const first = await store.insertCharge(chargeRow());
    const second = await store.insertCharge(chargeRow({ id: 'ich_two' }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.charge.id).toBe('ich_one');
  });

  it('keeps idempotency per owner', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(chargeRow());
    const other = await store.insertCharge(chargeRow({ ownerRef: 'owner-b', id: 'ich_b' }));
    expect(other.created).toBe(true);
  });

  it('compare-and-sets on the state', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(chargeRow());
    const settled = chargeRow({ state: 'committed', credits: 2 });
    expect(await store.saveCharge(settled, 'reserved')).toBe(true);
    expect(await store.saveCharge(chargeRow({ state: 'released' }), 'reserved')).toBe(false);
    expect((await store.findById('owner-a', 'ich_one'))?.state).toBe('committed');
  });

  it('lists charges without ever leaking another owner rows', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(chargeRow());
    await store.insertCharge(chargeRow({ ownerRef: 'owner-b', id: 'ich_b' }));
    const page = await store.listCharges('owner-a', { limit: 10 });
    expect(page.total).toBe(1);
    expect(page.charges[0]?.ownerRef).toBe('owner-a');
  });

  it('aggregates settled charges by integration and skips open holds', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(
      chargeRow({ state: 'committed', credits: 1.5, requests: 2, units: { record: 4 } }),
    );
    await store.insertCharge(
      chargeRow({ id: 'ich_2', idempotencyKey: 'k-2', state: 'reserved', credits: 0 }),
    );
    await store.insertCharge(
      chargeRow({
        id: 'ich_3',
        idempotencyKey: 'k-3',
        integrationId: 'slack',
        state: 'committed',
        credits: 0.5,
      }),
    );
    const groups = await store.aggregate('owner-a', 'integration');
    expect(groups.find((group) => group.key === 'github')).toMatchObject({
      charges: 1,
      credits: 1.5,
      requests: 2,
      units: 4,
    });
    expect(groups.find((group) => group.key === 'slack')?.credits).toBe(0.5);
  });

  it('keeps spending settings per owner and workspace', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.saveSettings({
      ownerRef: 'owner-a',
      workspaceId: 'w1',
      monthlyLimit: 10,
      perOperationLimit: 2,
      updatedAt: '2026-11-11T00:00:00.000Z',
    });
    expect(await store.readSettings('owner-a', 'w2')).toBeNull();
    expect(await store.readSettings('owner-a', 'w1')).toMatchObject({ monthlyLimit: 10 });
  });

  it('lists only open charges for the sweep', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(chargeRow({ state: 'reserved' }));
    await store.insertCharge(chargeRow({ id: 'ich_2', idempotencyKey: 'k-2', state: 'committed' }));
    const open = await store.listOpen('owner-a', 10);
    expect(open.map((row) => row.id)).toEqual(['ich_one']);
  });

  it('lists each account that still holds credit once, oldest hold first', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(
      chargeRow({ id: 'ich_b1', ownerRef: 'owner-b', idempotencyKey: 'b-1' }),
    );
    await store.insertCharge(
      chargeRow({ ownerRef: 'owner-a', createdAt: '2026-11-11T09:00:00.000Z' }),
    );
    await store.insertCharge(
      chargeRow({
        id: 'ich_b2',
        ownerRef: 'owner-b',
        idempotencyKey: 'b-2',
        createdAt: '2026-11-11T11:00:00.000Z',
      }),
    );
    await store.insertCharge(
      chargeRow({ id: 'ich_c', ownerRef: 'owner-c', idempotencyKey: 'c-1', state: 'committed' }),
    );
    // owner-a held first, so it is swept first; owner-c has nothing open and is absent.
    expect(await store.listOpenOwners(10)).toEqual(['owner-a', 'owner-b']);
  });

  it('stops listing owners at the limit it was given', async () => {
    const store = new InMemoryIntegrationCreditStore();
    await store.insertCharge(chargeRow());
    await store.insertCharge(
      chargeRow({ id: 'ich_b', ownerRef: 'owner-b', idempotencyKey: 'b-1' }),
    );
    expect(await store.listOpenOwners(1)).toHaveLength(1);
  });
});
