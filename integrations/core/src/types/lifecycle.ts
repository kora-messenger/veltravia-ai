/**
 * Integration lifecycle statuses.
 *
 * The lifecycle answers "what state is this integration / connection in
 * right now" - it is DELIBERATELY SEPARATE from authorization:
 *
 *     connected  !=  authorized for every operation
 *
 * A connected connection still evaluates every operation against its
 * GRANTED scopes, the Tool System's tool permissions, risk levels, and
 * (for high/critical risk) human confirmation. Lifecycle never grants
 * anything; permissions always stay explicit.
 */

export const INTEGRATION_STATUSES = [
  'available',
  'configured',
  'connected',
  'disconnected',
  'disabled',
  'error',
] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  return typeof value === 'string' && (INTEGRATION_STATUSES as readonly string[]).includes(value);
}

/** Connection-level lifecycle (a connection is one instance of a connection). */
export const CONNECTION_STATUSES = ['connected', 'disconnected', 'disabled', 'error'] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return typeof value === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(value);
}
