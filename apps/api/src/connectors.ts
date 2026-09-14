import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';

import { createGitHubApiConnector } from './github.js';

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
  // Step 10: the GitHub connector is visible read-only (metadata + status
  // only). It is registered here with NO permission grants - the endpoints
  // below cannot execute anything, and grants belong to operators.
  const github = createGitHubApiConnector({ now });
  manager.register(github.runtime.connector);
  // Tracked, not awaited: while the connection is establishing (or if it
  // fails), /api/connectors reports the honest status. Fail-closed.
  void manager.connect(github.runtime.connectorId).catch(() => undefined);
  return manager;
}
