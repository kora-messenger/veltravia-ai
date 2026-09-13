import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';

/**
 * Builds the API's ConnectorManager.
 *
 * Step 4 registers exactly one connector: the offline mock, which exists to
 * prove the framework end to end. Real connectors (GitHub, databases, object
 * storage, payments, ...) arrive in later steps and will be registered here
 * the same way - through the provider-neutral interface, with credentials
 * referenced (never stored) and permissions granted explicitly by operators.
 *
 * The manager grants NOTHING by default: registering a connector never grants
 * permissions, and these endpoints expose metadata/status only - no
 * credentials, no actions.
 */
export function createConnectorManager(now: () => Date = () => new Date()): ConnectorManager {
  const manager = new ConnectorManager({ now });
  manager.register(createMockConnector({ now }));
  return manager;
}
