/**
 * Provider-neutral connector capabilities.
 *
 * A capability is a GENERIC concept ("this connector can read things"),
 * never a vendor-specific API surface ("list repository branches").
 * Capabilities are DECLARED by each connector - the framework never grants
 * them automatically, and the registry rejects metadata that claims a
 * capability this union does not know (typos cannot slip through).
 *
 * Extensibility: new capabilities are added by widening this union. The core
 * package treats the set as closed so that every capability in the system is
 * documented and greppable; adding one is a deliberate, reviewed change.
 */
export const CONNECTOR_CAPABILITIES = [
  'read',
  'write',
  'create',
  'update',
  'delete',
  'execute',
  'search',
  'deploy',
  'manage_users',
  'manage_files',
  'manage_projects',
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export function isConnectorCapability(value: unknown): value is ConnectorCapability {
  return typeof value === 'string' && (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);
}
