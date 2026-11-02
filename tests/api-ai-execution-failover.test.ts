import { describe, expect, it } from 'vitest';

import {
  AIProviderGateway,
  CredentialVault,
  InMemoryConnectionStore,
  InMemoryPreferenceStore,
  InMemoryUsageStore,
  InMemoryVaultRecordStore,
} from '@veltravia/ai-gateway';
import {
  FixtureProviderTransport,
  createTestKeyring,
  TEST_OPENAI_KEY,
} from '@veltravia/ai-gateway-mock';

import { createAiExecutionService } from '../apps/api/src/ai-execution-service.js';
import type { ModelRouterService } from '../apps/api/src/model-router-service.js';

/**
 * Provider failover.
 *
 * The owner runs three providers: OpenAI is the default, Groq and OpenRouter are
 * the ones with capacity. A default that cannot serve must cost one failed call,
 * not a stalled answer, and the run must report the provider that actually
 * answered.
 */

function idFor(url: string): 'openai' | 'groq' | 'openrouter' {
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('api.groq.com')) return 'groq';
  return 'openrouter';
}

function harness() {
  // The account runs dry only after both keys are connected: a connect that is
  // refused cannot demonstrate a failover.
  let dry = false;
  const transport = new FixtureProviderTransport({
    override: (request) => {
      const provider = idFor(request.url);
      if (dry && provider === 'openai') {
        const message = 'You have no credits remaining. Add credits to continue using the API.';
        return {
          status: 429,
          body: { error: { message, type: 'insufficient_quota', code: 'insufficient_quota' } },
          text: JSON.stringify({
            error: { message, type: 'insufficient_quota', code: 'insufficient_quota' },
          }),
        };
      }
      return undefined;
    },
  });
  const gateway = new AIProviderGateway({
    vault: new CredentialVault({
      keyring: createTestKeyring([1]),
      store: new InMemoryVaultRecordStore(),
    }),
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage: new InMemoryUsageStore(),
    transport,
    rateLimitFloorMs: 1,
  });
  return {
    gateway,
    transport,
    runDry: () => {
      dry = true;
    },
  };
}

describe('a default provider that cannot serve', () => {
  it('answers from another connected provider and reports which one', async () => {
    const { gateway, runDry } = harness();
    const scope = { ownerRef: 'failover-owner' };
    await gateway.createConnection(scope, { providerId: 'groq', apiKey: TEST_OPENAI_KEY });
    const openai = await gateway.createConnection(scope, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    await gateway.setPreferences(scope, {
      defaultConnectionId: openai.id,
      defaultModelId: openai.defaultModelId ?? undefined,
    });

    runDry();

    const router = {
      async routeFor() {
        return {
          outcome: 'routed',
          summary: 'default',
          selected: {
            connectionId: openai.id,
            providerId: 'openai',
            modelId: openai.defaultModelId ?? 'gpt-4o-mini',
            streaming: false,
            contextWindowTokens: 8000,
          },
        };
      },
    } as unknown as ModelRouterService;

    const service = createAiExecutionService({ gateway, router });
    const { run, events } = service.start({
      ownerRef: 'failover-owner',
      task: 'Say OK',
      stream: false,
    } as never);

    const seen: { type: string; [key: string]: unknown }[] = [];
    let completed: { providerId?: string; content?: string } | null = null;
    for await (const event of events) {
      seen.push(event as never);
      if (event.type === 'run.completed') completed = event as never;
    }

    expect(run.id).toBeTruthy();
    expect(completed?.providerId).toBe('groq');
    expect(completed?.content?.length ?? 0).toBeGreaterThan(0);
    // The switch is stated in the stream, not silent.
    expect(
      seen.some(
        (event) =>
          event.type === 'progress' &&
          String(event.message ?? '').includes('another one is being tried'),
      ),
    ).toBe(true);
  });
});
