import { GatewayError } from '../errors/index.js';
import type { ProviderDefinition } from '../types/index.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiGatewayAdapter } from './gemini.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { ProviderAdapter } from './adapter.js';
import { findProviderDefinition, PROVIDER_CATALOG } from './catalog.js';

/**
 * Adapter registry. One adapter instance per provider definition; adapters hold
 * no credentials, so sharing them is safe and keeps capability declarations in
 * exactly one place.
 */
export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(definitions: readonly ProviderDefinition[] = PROVIDER_CATALOG) {
    for (const definition of definitions) {
      this.definitions.set(definition.id, definition);
      this.adapters.set(definition.id, createAdapter(definition));
    }
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  definition(providerId: string): ProviderDefinition {
    const definition = this.definitions.get(providerId);
    if (!definition) {
      throw new GatewayError('GATEWAY_PROVIDER_UNKNOWN', `Unknown provider: ${providerId}`, {
        details: { providerId },
      });
    }
    return definition;
  }

  adapter(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new GatewayError('GATEWAY_PROVIDER_UNKNOWN', `Unknown provider: ${providerId}`, {
        details: { providerId },
      });
    }
    return adapter;
  }

  list(): readonly ProviderDefinition[] {
    return [...this.definitions.values()];
  }
}

export function createAdapter(definition: ProviderDefinition): ProviderAdapter {
  switch (definition.adapter) {
    case 'anthropic':
      return new AnthropicAdapter(definition);
    case 'gemini':
      return new GeminiGatewayAdapter(definition);
    case 'openai-compatible':
      return new OpenAICompatibleAdapter(definition);
    default: {
      const unknown: never = definition.adapter;
      throw new GatewayError('GATEWAY_PROVIDER_UNKNOWN', `Unsupported adapter: ${String(unknown)}`);
    }
  }
}

/** Resolves a provider id against the default catalog. */
export function definitionOf(providerId: string): ProviderDefinition {
  const definition = findProviderDefinition(providerId);
  if (!definition) {
    throw new GatewayError('GATEWAY_PROVIDER_UNKNOWN', `Unknown provider: ${providerId}`, {
      details: { providerId },
    });
  }
  return definition;
}
