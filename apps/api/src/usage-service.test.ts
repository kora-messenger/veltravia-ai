/**
 * The metering decisions that do not need HTTP (Step 52).
 *
 * Three of these are the ones a reviewer should be able to read and disagree
 * with, so they are pinned here:
 *  - a BYOK call is recorded but never deducted from an allowance;
 *  - a managed provider call needs a paid entitlement in production, and
 *    development mode says yes without one;
 *  - concurrency is judged against what is running now, not what was recorded.
 */

import { describe, expect, it } from 'vitest';

import { createUsageService, UsageLimitError } from './usage-service.js';

const owner = 'usage-unit-owner';
const development = { VELTRAVIA_DEPLOYMENT_MODE: 'development' } as NodeJS.ProcessEnv;
const production = { VELTRAVIA_DEPLOYMENT_MODE: 'production' } as NodeJS.ProcessEnv;

describe('usage service decisions', () => {
  it('counts a managed provider call against the allowance and a BYOK call against nothing', async () => {
    const usage = createUsageService({ env: development });

    await usage.recordProviderCall({
      ownerRef: owner,
      runId: 'run_managed',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      inputTokens: 900,
      outputTokens: 100,
      byok: false,
    });
    await usage.recordProviderCall({
      ownerRef: owner,
      runId: 'run_byok',
      providerId: 'gemini',
      modelId: 'gemini-2.0-flash',
      inputTokens: 5000,
      outputTokens: 5000,
      byok: true,
    });

    const snapshot = await usage.snapshot(owner);
    // Both are recorded: BYOK tokens are the caller's own bill, not a secret.
    expect(snapshot.counters.ai_provider).toBe(11_000);
    const tokens = snapshot.limits.find((row) => row.key === 'providerTokens');
    // The allowance sees only the managed call's 1,000 tokens.
    expect(tokens?.used).toBe(1_000);
    expect(snapshot.cost.byokProviderUsd).toBeGreaterThanOrEqual(0);
    expect(snapshot.cost.managedProviderUsd).toBeGreaterThanOrEqual(0);
  });

  it('asks for a paid plan before a managed key is used in production, and not for BYOK', async () => {
    const usage = createUsageService({ env: production });

    await expect(
      usage.guardProviderCall({ ownerRef: owner, byok: false, requestedTokens: 100 }),
    ).rejects.toBeInstanceOf(UsageLimitError);
    await expect(
      usage.guardProviderCall({ ownerRef: owner, byok: false, requestedTokens: 100 }),
    ).rejects.toMatchObject({ code: 'USAGE_PLAN_REQUIRED', status: 402 });

    // The caller's own key is always allowed: it costs this platform nothing.
    await expect(
      usage.guardProviderCall({ ownerRef: owner, byok: true, requestedTokens: 100 }),
    ).resolves.toBeUndefined();

    // Development mode is the exception, and says so.
    const local = createUsageService({ env: development });
    await expect(
      local.guardProviderCall({ ownerRef: owner, byok: false, requestedTokens: 100 }),
    ).resolves.toBeUndefined();
  });

  it('judges concurrency on what is running, and refuses with the numbers', async () => {
    const usage = createUsageService({ env: development });
    const limit = (await usage.limits(owner)).find((row) => row.key === 'concurrentJobs');
    expect(limit?.value).toBe(3);

    await expect(usage.guardConcurrency({ ownerRef: owner, running: 2 })).resolves.toBeUndefined();

    await expect(usage.guardConcurrency({ ownerRef: owner, running: 3 })).rejects.toMatchObject({
      code: 'USAGE_CONCURRENCY_REACHED',
      status: 429,
    });
    // The message is not "over limit": it is what is running against what is allowed.
    await expect(usage.guardConcurrency({ ownerRef: owner, running: 3 })).rejects.toThrow(
      /3 of 3 jobs can run at once/,
    );
  });

  it('refuses a spent counter and keeps the numbers on the refusal', async () => {
    const usage = createUsageService({ env: development });
    // Spend the whole included job allowance.
    for (let index = 0; index < 500; index += 1) {
      await usage.adjust({
        ownerRef: owner,
        category: 'background_jobs',
        quantity: 1,
        reason: 'Filling the allowance for the refusal path.',
        actor: 'test',
        auditId: `fill-${index}`,
      });
    }
    try {
      await usage.guardBackgroundJob({ ownerRef: owner, operationKey: 'intake:over' });
      throw new Error('the guard allowed a spent allowance');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageLimitError);
      const refusal = error as UsageLimitError;
      expect(refusal.status).toBe(429);
      expect(refusal.decision?.limit).toBe(500);
      expect(refusal.decision?.used).toBe(500);
      expect(refusal.decision?.remaining).toBe(0);
    }
  });

  it('reports an unprobed gauge as unenforced instead of empty', async () => {
    const usage = createUsageService({ env: development });
    const limits = await usage.limits(owner);
    for (const key of ['databaseStorageBytes', 'bandwidthBytes', 'realtimeConnections']) {
      const row = limits.find((entry) => entry.key === key);
      expect(row?.used).toBeNull();
      expect(row?.enforcement).toBe('not_enforced');
      expect(row?.note).toBeTruthy();
    }
    const capabilities = usage.capabilities();
    expect(capabilities.enforcement).toBe('partial');
  });
});
