/**
 * Connector lifecycle status and health reporting.
 *
 * The lifecycle is owned by the ConnectorManager; the connector itself only
 * reports health. Future connectors can therefore report status without the
 * core architecture ever changing.
 */

export const CONNECTOR_STATUSES = [
  'registered',
  'configured',
  'connected',
  'disconnected',
  'error',
  'disabled',
] as const;

export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export function isConnectorStatus(value: unknown): value is ConnectorStatus {
  return typeof value === 'string' && (CONNECTOR_STATUSES as readonly string[]).includes(value);
}

/** A point-in-time lifecycle snapshot for one connector. */
export interface ConnectorStatusInfo {
  readonly status: ConnectorStatus;
  /** Human-readable, secret-free explanation (e.g. why a connector errored). */
  readonly detail?: string;
  /** ISO-8601 timestamp of when this status was entered. */
  readonly since: string;
}

/** The result of a connector's own health check. */
export interface ConnectorHealth {
  readonly healthy: boolean;
  /** Secret-free explanation ("reachable", "quota exceeded", ...). */
  readonly detail?: string;
  /** ISO-8601 timestamp of when the check was performed. */
  readonly checkedAt: string;
}
