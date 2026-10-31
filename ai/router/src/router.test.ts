import { describe, expect, it } from 'vitest';
import type { AICapability } from '@veltravia/ai-core';
import {
  InMemoryObservationStore,
  InMemoryRouterPreferenceStore,
  ModelRouter,
  RouterError,
  buildCatalog,
  describeCapabilities,
  type ConnectionFacts,
  type ProviderFacts,
} from './index.js';

const NOW = () => new Date('2026-10-31T12:00:00.000Z');

const providers: ProviderFacts[] = [
  {
    providerId: 'openai',
    displayName: 'OpenAI',
    modelCapabilities: ['text-generation', 'structured-output', 'streaming', 'vision'],
    reportsModels: true,
  },
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    modelCapabilities: ['text-generation', 'large-context', 'code-generation'],
  },
  {
    providerId: 'local',
    displayName: 'Local runner',
    modelCapabilities: ['text-generation'],
    models: [{ modelId: 'tiny', displayName: 'Tiny local', contextWindowTokens: 4096 }],
  },
];

function connection(overrides: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    id: 'conn_openai',
    providerId: 'openai',
    displayName: 'My OpenAI key',
    status: 'active',
    modelIds: ['gpt-5', 'gpt-5-mini'],
    defaultModelId: 'gpt-5',
    lastValidatedAt: '2026-10-30T09:00:00.000Z',
    ...overrides,
  };
}

function makeConnections(entries: readonly ConnectionFacts[]) {
  return {
    async list(ownerRef: string) {
      return ownerRef === 'owner-a' ? entries : [];
    },
  };
}

function makeRouter(
  entries: readonly ConnectionFacts[] = [connection()],
  options: {
    readonly preferences?: InMemoryRouterPreferenceStore;
    readonly discovery?: ConstructorParameters<typeof ModelRouter>[0]['options']['discovery'];
    readonly observations?: InMemoryObservationStore;
  } = {},
) {
  return new ModelRouter({
    options: {
      connections: makeConnections(entries),
      providers,
      preferences: options.preferences ?? new InMemoryRouterPreferenceStore(),
      now: NOW,
      ...(options.discovery !== undefined ? { discovery: options.discovery } : {}),
    },
    ...(options.observations !== undefined ? { observations: options.observations } : {}),
  });
}

const scope = { ownerRef: 'owner-a' };

describe('model catalog', () => {
  it('lists one row per provider model the owner can use', async () => {
    const router = makeRouter();
    const { models, providers: providerCount } = await router.catalog(scope);
    expect(models).toHaveLength(2);
    expect(providerCount).toBe(1);
    expect(models[0]).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5',
      capabilitySource: 'catalog',
      discoverySource: 'connection',
    });
  });

  it('never invents a context window or a capability', async () => {
    const router = makeRouter();
    const { models, notes } = await router.catalog(scope);
    expect(models.every((model) => model.contextWindowTokens === null)).toBe(true);
    expect(notes.join(' ')).toMatch(/context window/i);
    expect(notes.join(' ')).toMatch(/platform catalog/i);
  });

  it('marks a provider-reported model as provider-reported', async () => {
    const router = makeRouter([connection()], {
      discovery: async () => ({
        'gpt-5': {
          modelId: 'gpt-5',
          contextWindowTokens: 400000,
          capabilities: ['text-generation', 'vision'] as AICapability[],
        },
      }),
    });
    const { models } = await router.catalog(scope);
    const gpt5 = models.find((model) => model.modelId === 'gpt-5');
    expect(gpt5?.capabilitySource).toBe('provider-reported');
    expect(gpt5?.contextWindowTokens).toBe(400000);
    expect(gpt5?.streaming).toBe(false);
  });

  it('shows a disabled connection as unavailable with a reason', async () => {
    const router = makeRouter([
      connection({ id: 'conn_off', status: 'invalid', displayName: 'Switched off' }),
    ]);
    const { models } = await router.catalog(scope);
    expect(models.every((model) => model.available)).toBe(false);
    expect(models[0]?.unavailableReason).toMatch(/failed its last check/i);
  });

  it('survives a discovery failure without failing the catalog', async () => {
    const router = makeRouter([connection()], {
      discovery: async () => {
        throw new Error('provider down');
      },
    });
    const { models } = await router.catalog(scope);
    expect(models).toHaveLength(2);
    expect(models[0]?.capabilitySource).toBe('catalog');
  });

  it('builds a catalog from seeds with declared windows', () => {
    const rows = buildCatalog({
      connections: [connection({ id: 'conn_local', providerId: 'local', modelIds: ['tiny'] })],
      providers,
    });
    expect(rows[0]?.contextWindowTokens).toBe(4096);
    expect(rows[0]?.displayName).toBe('Tiny local');
  });

  it('describes capabilities in plain words', () => {
    expect(describeCapabilities(['text-generation', 'vision'])).toBe('writes text, reads images');
  });
});

describe('task categories', () => {
  it('reports which categories the connected models can serve', async () => {
    const router = makeRouter();
    const capabilities = await router.capabilities(scope);
    const byCategory = new Map(capabilities.map((entry) => [entry.category, entry]));
    expect(byCategory.get('general-conversation')?.supported).toBe(true);
    expect(byCategory.get('structured-data-extraction')?.modelCount).toBe(2);
    expect(byCategory.get('coding')?.supported).toBe(true);
  });

  it('distinguishes "nothing connected" from "connected but unusable"', async () => {
    // An invalid connection still appears in the catalog, so the reason a
    // category is unsupported must never be "no provider is connected".
    const router = makeRouter([
      connection({ id: 'conn_bad', status: 'invalid', modelIds: ['gpt-test-mini'] }),
    ]);
    const capabilities = await router.capabilities(scope);
    const conversation = capabilities.find((entry) => entry.category === 'general-conversation');
    expect(conversation?.supported).toBe(false);
    expect(conversation?.reason).not.toMatch(/no provider is connected/i);
    expect(conversation?.reason).toMatch(/not usable right now/i);
    expect(conversation?.reason).toMatch(/failed its last check/i);

    const empty = makeRouter([]);
    const emptyCapabilities = await empty.capabilities(scope);
    expect(
      emptyCapabilities.find((entry) => entry.category === 'general-conversation')?.reason,
    ).toMatch(/no provider is connected/i);
  });

  it('says plainly that video understanding has no adapter', async () => {
    const router = makeRouter();
    const capabilities = await router.capabilities(scope);
    const video = capabilities.find((entry) => entry.category === 'video-understanding');
    expect(video?.supported).toBe(false);
    expect(video?.reason).toMatch(/no connected adapter accepts video input/i);
  });

  it('says plainly that embeddings have no adapter', async () => {
    const router = makeRouter();
    const capabilities = await router.capabilities(scope);
    const embeddings = capabilities.find((entry) => entry.category === 'embeddings');
    expect(embeddings?.supported).toBe(false);
    expect(embeddings?.reason).toMatch(/embeddings adapter/i);
  });

  it('refuses a category nothing can serve instead of pretending', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, { category: 'video-understanding' });
    expect(decision.outcome).toBe('unsupported');
    expect(decision.selected).toBeNull();
    expect(decision.summary).toMatch(/not available yet/i);
  });

  it('refuses image understanding when no model declares vision', async () => {
    const router = makeRouter([
      connection({
        providerId: 'anthropic',
        modelIds: ['claude-x'],
      }),
    ]);
    const decision = await router.route(scope, { category: 'image-understanding' });
    expect(decision.outcome).toBe('unsupported');
    expect(decision.summary).toMatch(/reading images/i);
  });

  it('explains that nothing is connected yet', async () => {
    const router = makeRouter([]);
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.outcome).toBe('unsupported');
    expect(decision.summary).toMatch(/no ai provider is connected/i);
  });
});

describe('automatic routing', () => {
  it('routes a general request and explains the choice', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.outcome).toBe('routed');
    expect(decision.selected?.providerId).toBe('openai');
    expect(decision.decidedBy).toBe('automatic');
    expect(decision.summary).toMatch(/because it declares writing text/i);
    expect(decision.audit.consideredCount).toBe(2);
  });

  it('prefers a model that declares the capability the task needs', async () => {
    const router = makeRouter([
      connection({
        providerId: 'anthropic',
        id: 'conn_anthropic',
        modelIds: ['claude-x'],
      }),
      connection(),
    ]);
    const decision = await router.route(scope, { category: 'structured-data-extraction' });
    expect(decision.selected?.providerId).toBe('openai');
    const rejected = decision.rejected.map((entry) => entry.reason).join(' ');
    expect(rejected).toMatch(/does not declare returning typed fields/i);
  });

  it('rejects models without streaming when the caller needs it', async () => {
    const router = makeRouter([
      connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
    ]);
    const decision = await router.route(scope, {
      category: 'general-conversation',
      needsStreaming: true,
    });
    expect(decision.outcome).toBe('unsupported');
    expect(decision.rejected[0]?.reason).toMatch(/does not declare streaming/i);
  });

  it('rejects a model whose context window is too small', async () => {
    const router = makeRouter([
      connection({ providerId: 'local', id: 'conn_local', modelIds: ['tiny'] }),
    ]);
    const decision = await router.route(scope, {
      category: 'general-conversation',
      estimatedInputTokens: 8000,
    });
    expect(decision.outcome).toBe('unsupported');
    expect(decision.rejected[0]?.reason).toMatch(/less than the 8,000 this request needs/i);
  });

  it('warns instead of guessing when a window is unknown', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, {
      category: 'general-conversation',
      estimatedInputTokens: 900000,
    });
    expect(decision.outcome).toBe('routed');
    expect(decision.warnings.join(' ')).toMatch(/do not report a context window/i);
    expect(decision.audit.missingEvidence).toContain('context window for some models');
  });

  it('prefers stronger reasoning when the owner asks for it', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter(
      [
        connection(),
        connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
      ],
      { preferences },
    );
    await router.updatePreferences(scope, { preference: 'stronger-reasoning' });
    const decision = await router.route(scope, { category: 'complex-reasoning' });
    expect(decision.selected?.providerId).toBe('anthropic');
    expect(decision.summary).toMatch(/strongest reasoner/i);
  });

  it('says cost comparison is unavailable rather than claiming the cheapest', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter([connection()], { preferences });
    await router.updatePreferences(scope, { preference: 'lower-cost' });
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.costComparison).toBe('unavailable');
    expect(decision.warnings.join(' ')).toMatch(/cost comparison is unavailable/i);
    expect(decision.summary).toMatch(/no cost comparison was possible/i);
    expect(decision.summary).not.toMatch(/cheapest model/i);
  });

  it('ranks by measured response time only when something was measured', async () => {
    const observations = new InMemoryObservationStore();
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter([connection()], { preferences, observations });

    // Nothing measured yet: the router says so instead of claiming speed.
    await router.updatePreferences(scope, { preference: 'faster' });
    const unmeasured = await router.route(scope, { category: 'general-conversation' });
    expect(unmeasured.warnings.join(' ')).toMatch(/no response times have been measured/i);
    expect(unmeasured.audit.missingEvidence).toContain('measured latency');

    await router.recordOutcome(scope, {
      providerId: 'openai',
      modelId: 'gpt-5-mini',
      status: 'success',
      latencyMs: 400,
    });
    await router.recordOutcome(scope, {
      providerId: 'openai',
      modelId: 'gpt-5',
      status: 'success',
      latencyMs: 5200,
    });
    const measured = await router.route(scope, { category: 'general-conversation' });
    expect(measured.selected?.modelId).toBe('gpt-5-mini');
    expect(measured.summary).toMatch(/best measured response time/i);
  });

  it('pauses a model after repeated failures and says why', async () => {
    const router = makeRouter([
      connection({ modelIds: ['gpt-5'] }),
      connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await router.recordOutcome(scope, {
        providerId: 'openai',
        modelId: 'gpt-5',
        status: 'failure',
      });
    }
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.selected?.providerId).toBe('anthropic');
    expect(decision.rejected.map((entry) => entry.reason).join(' ')).toMatch(
      /paused for a short while/i,
    );
  });

  it('keeps decisions per owner and never returns another owner’s decision', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(await router.decision(scope, decision.id)).toMatchObject({ id: decision.id });
    await expect(router.decision({ ownerRef: 'owner-b' }, decision.id)).rejects.toBeInstanceOf(
      RouterError,
    );
  });

  it('records an unknown category as an error rather than a guess', async () => {
    const router = makeRouter();
    await expect(
      router.route(scope, { category: 'quantum-telepathy' as never }),
    ).rejects.toMatchObject({ code: 'ROUTER_UNKNOWN_CATEGORY' });
  });
});

describe('manual routing', () => {
  it('uses the model the caller picked', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, {
      category: 'general-conversation',
      mode: 'manual',
      connectionId: 'conn_openai',
      modelId: 'gpt-5-mini',
    });
    expect(decision.selected?.modelId).toBe('gpt-5-mini');
    expect(decision.decidedBy).toBe('manual-request');
    expect(decision.summary).toMatch(/because you chose it/i);
  });

  it('refuses a manual model that cannot do the task', async () => {
    const router = makeRouter([connection({ providerId: 'anthropic', modelIds: ['claude-x'] })]);
    await expect(
      router.route(scope, {
        category: 'structured-data-extraction',
        mode: 'manual',
        connectionId: 'conn_openai',
        modelId: 'claude-x',
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_MODEL_NOT_COMPATIBLE' });
  });

  it('refuses a manual pick without a model', async () => {
    const router = makeRouter();
    await expect(
      router.route(scope, { category: 'general-conversation', mode: 'manual' }),
    ).rejects.toMatchObject({ code: 'ROUTER_INVALID_REQUEST' });
  });

  it('refuses another owner’s connection', async () => {
    const router = makeRouter();
    await expect(
      router.route(scope, {
        category: 'general-conversation',
        mode: 'manual',
        connectionId: 'conn_someone_else',
        modelId: 'gpt-5',
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_PREFERENCE_UNUSABLE' });
  });

  it('reports an unavailable manual model without switching', async () => {
    const router = makeRouter([connection({ status: 'disabled' })]);
    const decision = await router.route(scope, {
      category: 'general-conversation',
      mode: 'manual',
      connectionId: 'conn_openai',
      modelId: 'gpt-5',
    });
    expect(decision.outcome).toBe('needs-attention');
    expect(decision.selected).toBeNull();
    expect(decision.summary).toMatch(/turned off/i);
  });
});

describe('preferences', () => {
  it('uses the default model when the owner set one', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter([connection()], { preferences });
    await router.updatePreferences(scope, {
      defaultModel: { connectionId: 'conn_openai', modelId: 'gpt-5-mini' },
    });
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.selected?.modelId).toBe('gpt-5-mini');
    expect(decision.decidedBy).toBe('user-default');
    expect(decision.summary).toMatch(/it is your default model/i);
  });

  it('applies a task-specific preference over the default', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter(
      [
        connection(),
        connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
      ],
      { preferences },
    );
    await router.updatePreferences(scope, {
      defaultModel: { connectionId: 'conn_openai', modelId: 'gpt-5' },
      taskPreferences: { coding: { connectionId: 'conn_anthropic', modelId: 'claude-x' } },
    });
    const coding = await router.route(scope, { category: 'coding' });
    expect(coding.selected?.providerId).toBe('anthropic');
    expect(coding.decidedBy).toBe('task-preference');

    const general = await router.route(scope, { category: 'general-conversation' });
    expect(general.selected?.providerId).toBe('openai');
  });

  it('lets a project preference override the user default', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter(
      [
        connection(),
        connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
      ],
      { preferences },
    );
    await router.updatePreferences(scope, {
      defaultModel: { connectionId: 'conn_openai', modelId: 'gpt-5' },
      projectPreferences: {
        prj_1: { connectionId: 'conn_anthropic', modelId: 'claude-x' },
      },
    });
    const decision = await router.route(scope, {
      category: 'general-conversation',
      projectId: 'prj_1',
    });
    expect(decision.selected?.providerId).toBe('anthropic');
    expect(decision.decidedBy).toBe('project-preference');
  });

  it('honours project mode only when the project has its own model', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, {
      category: 'general-conversation',
      mode: 'project',
      projectId: 'prj_empty',
    });
    expect(decision.outcome).toBe('needs-attention');
    expect(decision.summary).toMatch(/no model of its own/i);
  });

  it('refuses a stored preference that cannot run the task and does not switch silently', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter(
      [connection({ providerId: 'local', id: 'conn_local', modelIds: ['tiny'] })],
      { preferences },
    );
    await router.updatePreferences(scope, {
      defaultModel: { connectionId: 'conn_local', modelId: 'tiny' },
    });
    const decision = await router.route(scope, { category: 'image-understanding' });
    expect(decision.outcome).toBe('needs-attention');
    expect(decision.selected).toBeNull();
    expect(decision.summary).toMatch(/tiny local cannot do this task/i);
    expect(decision.summary).toMatch(/does not change your chosen model on its own/i);
  });

  it('falls back only when the owner allowed it, and says what replaced what', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter(
      [
        connection(),
        connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
      ],
      { preferences },
    );
    await router.updatePreferences(scope, {
      defaultModel: { connectionId: 'conn_anthropic', modelId: 'claude-x' },
      allowFallback: true,
    });
    const decision = await router.route(scope, { category: 'structured-data-extraction' });
    expect(decision.outcome).toBe('routed');
    expect(decision.selected?.providerId).toBe('openai');
    expect(decision.fallback).toMatchObject({
      policy: 'compatible-alternate',
      used: true,
      replaced: 'claude-x',
    });
    expect(decision.summary).toMatch(/you allowed a compatible alternative/i);
  });

  it('refuses a preference for a model not on the connection', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter([connection()], { preferences });
    await expect(
      router.updatePreferences(scope, {
        defaultModel: { connectionId: 'conn_openai', modelId: 'gpt-9-ultra' },
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_PREFERENCE_UNUSABLE' });
  });

  it('turns automatic selection off and keeps the owner’s model', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter(
      [
        connection(),
        connection({ providerId: 'anthropic', id: 'conn_anthropic', modelIds: ['claude-x'] }),
      ],
      { preferences },
    );
    await router.updatePreferences(scope, {
      autoSelect: false,
      defaultModel: { connectionId: 'conn_anthropic', modelId: 'claude-x' },
    });
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.selected?.providerId).toBe('anthropic');
    expect(decision.decidedBy).toBe('user-default');
  });

  it('keeps the project override of automatic selection', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter([connection()], { preferences });
    await router.updatePreferences(scope, {
      projectPreferences: { prj_2: { connectionId: 'conn_openai', modelId: 'gpt-5-mini' } },
    });
    const decision = await router.route(scope, {
      category: 'general-conversation',
      projectId: 'prj_2',
    });
    expect(decision.selected?.modelId).toBe('gpt-5-mini');
  });

  it('deletes a preference when asked', async () => {
    const preferences = new InMemoryRouterPreferenceStore();
    const router = makeRouter([connection()], { preferences });
    await router.updatePreferences(scope, {
      defaultModel: { connectionId: 'conn_openai', modelId: 'gpt-5-mini' },
    });
    const cleared = await router.updatePreferences(scope, { defaultModel: null });
    expect(cleared.defaultModel).toBeNull();
  });
});

describe('security and audit', () => {
  it('never puts a secret or a credential reference in a decision', async () => {
    const router = makeRouter();
    const decision = await router.route(scope, {
      category: 'general-conversation',
      purpose: 'answer a question',
    });
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toMatch(/sk-|api[_-]?key|credentialRef|bearer/i);
  });

  it('records a bounded, owner-scoped history', async () => {
    const router = makeRouter();
    for (let index = 0; index < 5; index += 1) {
      await router.route(scope, { category: 'general-conversation' });
    }
    const history = await router.recentDecisions(scope, 2);
    expect(history).toHaveLength(2);
    expect(await router.recentDecisions({ ownerRef: 'owner-b' })).toHaveLength(0);
  });

  it('ignores an observation for a model this owner does not have', async () => {
    const observations = new InMemoryObservationStore();
    const router = makeRouter([connection()], { observations });
    await observations.record({
      providerId: 'openai',
      modelId: 'gpt-5',
      status: 'failure',
      at: NOW().toISOString(),
    });
    await observations.record({
      providerId: 'openai',
      modelId: 'gpt-5',
      status: 'failure',
      at: NOW().toISOString(),
    });
    await observations.record({
      providerId: 'openai',
      modelId: 'gpt-5',
      status: 'failure',
      at: NOW().toISOString(),
    });
    // gpt-5 is the owner's own model, so it is paused; gpt-5-mini is untouched.
    const decision = await router.route(scope, { category: 'general-conversation' });
    expect(decision.selected?.modelId).toBe('gpt-5-mini');
  });

  it('requires an owner on every entry point', async () => {
    const router = makeRouter();
    await expect(router.route({ ownerRef: '   ' }, { category: 'coding' })).rejects.toMatchObject({
      code: 'ROUTER_INVALID_REQUEST',
    });
  });
});
