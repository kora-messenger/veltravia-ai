/**
 * Provider-neutral connector categories.
 *
 * A category classifies WHAT kind of external service a connector talks to.
 * It is metadata only: it enables filtering and UI grouping, and it makes no
 * assumptions about any specific vendor. New categories are added by widening
 * this union (a minor, non-breaking change for consumers).
 */
export const CONNECTOR_CATEGORIES = [
  'source_control',
  'database',
  'storage',
  'deployment',
  'payments',
  'communication',
  'analytics',
  'ai',
  'other',
] as const;

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export function isConnectorCategory(value: unknown): value is ConnectorCategory {
  return typeof value === 'string' && (CONNECTOR_CATEGORIES as readonly string[]).includes(value);
}
