import type { AICapability } from '@veltravia/ai-core';
import type {
  CatalogModel,
  CapabilitySource,
  ConnectionFacts,
  ProviderFacts,
  ProviderModelSeed,
} from './types.js';

/**
 * The normalized model catalog.
 *
 * Three inputs are folded together, and the result never overstates any of them:
 *   1. the owner's connections (which providers and models they may use);
 *   2. the platform's provider facts (what the adapter can request);
 *   3. optional discovery (what the vendor reported for a model).
 *
 * A capability is only ever claimed from one of those sources. Nothing is
 * inferred from a model name: `gpt-4o` is not assumed to see images because the
 * letter "o" appears in its name, and no window size is guessed.
 */

export interface CatalogInput {
  readonly connections: readonly ConnectionFacts[];
  readonly providers: readonly ProviderFacts[];
  /**
   * Provider-reported model facts, keyed by connection then model. Populated
   * when discovery ran for that connection; absent entries mean "not reported".
   */
  readonly discovered?: Readonly<Record<string, Readonly<Record<string, ProviderModelSeed>>>>;
  /**
   * Models the router has observed failing, with a plain reason. Outage handling
   * uses this instead of quietly dropping a vendor.
   */
  readonly unavailable?: Readonly<Record<string, string>>;
}

function providerById(providers: readonly ProviderFacts[]): ReadonlyMap<string, ProviderFacts> {
  return new Map(providers.map((provider) => [provider.providerId, provider]));
}

function seedOf(
  provider: ProviderFacts | undefined,
  modelId: string,
  discovered: Readonly<Record<string, ProviderModelSeed>> | undefined,
): { seed: ProviderModelSeed | undefined; source: 'discovery' | 'catalog' | 'connection' } {
  const fromDiscovery = discovered?.[modelId];
  if (fromDiscovery !== undefined) {
    return { seed: fromDiscovery, source: 'discovery' };
  }
  const fromCatalog = provider?.models?.find((entry) => entry.modelId === modelId);
  if (fromCatalog !== undefined) {
    return { seed: fromCatalog, source: 'catalog' };
  }
  return { seed: undefined, source: 'connection' };
}

/**
 * Builds one row per provider/model the owner may use.
 *
 * A disabled or invalid connection still appears, marked unavailable with a
 * reason, so the settings screen can explain what is wrong instead of the model
 * silently disappearing.
 */
export function buildCatalog(input: CatalogInput): readonly CatalogModel[] {
  const providers = providerById(input.providers);
  const rows: CatalogModel[] = [];

  for (const connection of input.connections) {
    const provider = providers.get(connection.providerId);
    const discovered = input.discovered?.[connection.id];
    const providerName = provider?.displayName ?? connection.providerId;

    for (const modelId of connection.modelIds) {
      const { seed, source } = seedOf(provider, modelId, discovered);
      const capabilities: readonly AICapability[] =
        seed?.capabilities !== undefined && seed.capabilities.length > 0
          ? seed.capabilities
          : (provider?.modelCapabilities ?? []);

      const capabilitySource: CapabilitySource =
        seed?.capabilities !== undefined && seed.capabilities.length > 0
          ? source === 'discovery'
            ? 'provider-reported'
            : 'catalog'
          : 'catalog';

      const unavailableFromObservation = input.unavailable?.[`${connection.providerId}:${modelId}`];
      const connectionProblem =
        connection.status === 'disabled'
          ? 'This provider connection is turned off.'
          : connection.status === 'invalid'
            ? 'This provider connection failed its last check, so its models cannot be used.'
            : null;

      const unavailableReason = connectionProblem ?? unavailableFromObservation ?? null;

      rows.push({
        providerId: connection.providerId,
        providerName,
        connectionId: connection.id,
        connectionName: connection.displayName,
        modelId,
        displayName: seed?.displayName ?? modelId,
        capabilities,
        capabilitySource,
        contextWindowTokens: seed?.contextWindowTokens ?? null,
        maxOutputTokens: seed?.maxOutputTokens ?? null,
        streaming: capabilities.includes('streaming'),
        available: unavailableReason === null,
        unavailableReason,
        discoverySource: source,
        connectionDefault: connection.defaultModelId === modelId,
        lastValidatedAt: connection.lastValidatedAt ?? null,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      a.providerName.localeCompare(b.providerName) || a.displayName.localeCompare(b.displayName),
  );
}

/** Which declared capabilities every model in the catalog agrees on. */
export function catalogCapabilitySummary(
  models: readonly CatalogModel[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const model of models) {
    for (const capability of model.capabilities) {
      counts[capability] = (counts[capability] ?? 0) + 1;
    }
  }
  return counts;
}

/** A model's capabilities as plain words, never as a raw union member. */
export function describeCapabilities(capabilities: readonly AICapability[]): string {
  const WORDS: Readonly<Record<string, string>> = {
    'text-generation': 'writes text',
    'structured-output': 'returns typed fields',
    streaming: 'streams as it writes',
    vision: 'reads images',
    'image-generation': 'creates images',
    'tool-calling': 'can call tools',
    embeddings: 'produces vectors',
    'audio-input': 'takes audio in',
    'audio-output': 'speaks',
    'large-context': 'handles long context',
    'code-generation': 'writes code',
  };
  return capabilities.map((capability) => WORDS[capability] ?? capability).join(', ');
}
