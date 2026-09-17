import { isConnectorCapability, type ConnectorCapability } from '@veltravia/connector-core';

/**
 * Integration categories.
 *
 * A category classifies WHAT KIND of external service an integration
 * connects Veltravia to. It is METADATA ONLY: it never determines security
 * behavior - risk lives in permissions and risk levels, which are separate
 * concerns. The set grows by widening this union (a minor change).
 */
export const INTEGRATION_CATEGORIES = [
  'development',
  'communication',
  'databases',
  'storage',
  'productivity',
  'payments',
  'deployment',
  'search',
  'analytics',
  'ai',
  'other',
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export function isIntegrationCategory(value: unknown): value is IntegrationCategory {
  return typeof value === 'string' && (INTEGRATION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Maps a connector-core category onto the integration category vocabulary.
 * Used only when an existing connector is wrapped as an integration; new
 * integrations declare their category directly.
 */
export const CONNECTOR_CATEGORY_TO_INTEGRATION: Readonly<Record<string, IntegrationCategory>> = {
  source_control: 'development',
  database: 'databases',
  storage: 'storage',
  deployment: 'deployment',
  payments: 'payments',
  communication: 'communication',
  analytics: 'analytics',
  ai: 'ai',
  other: 'other',
} as const;

/** Environments an integration can run in (metadata, no behavioral power). */
export const INTEGRATION_ENVIRONMENTS = ['development', 'production'] as const;

export type IntegrationEnvironment = (typeof INTEGRATION_ENVIRONMENTS)[number];

export function isIntegrationEnvironment(value: unknown): value is IntegrationEnvironment {
  return (
    typeof value === 'string' && (INTEGRATION_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/** A declared generic capability reused from the connector vocabulary. */
export type IntegrationCapability = ConnectorCapability;

export function isIntegrationCapability(value: unknown): value is IntegrationCapability {
  return isConnectorCapability(value);
}
