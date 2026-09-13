import {
  DuplicateConnectorError,
  InvalidConnectorError,
  ConnectorNotFoundError,
} from '../errors/index.js';
import type { Connector } from '../types/connector.js';
import { validateConnector } from './validate.js';

/**
 * The connector registry: an ordered, in-memory catalog of VALIDATED
 * connector implementations.
 *
 * - registration validates structure and rejects duplicate ids
 * - retrieval is by unique id and throws ConnectorNotFoundError when missing
 * - listing preserves registration order (deterministic)
 * - unregistration makes the id available again
 *
 * The registry is intentionally low-level: no lifecycle, no permissions, no
 * audit - those belong to the ConnectorManager layered on top.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  /**
   * Registers a connector. Fails with InvalidConnectorError when the
   * implementation violates the contract, and DuplicateConnectorError when
   * the id already exists. Registration is atomic: a rejected connector
   * leaves the registry untouched.
   */
  register(connector: Connector): void {
    const reasons = validateConnector(connector);
    if (reasons.length > 0) {
      throw new InvalidConnectorError(reasons);
    }
    const id = connector.metadata.id;
    if (this.connectors.has(id)) {
      throw new DuplicateConnectorError(id);
    }
    this.connectors.set(id, connector);
  }

  /** Retrieves a connector by its unique id. Throws when unknown. */
  get(id: string): Connector {
    const connector = this.connectors.get(id);
    if (connector === undefined) {
      throw new ConnectorNotFoundError(id);
    }
    return connector;
  }

  /** Whether a connector with this id is registered. */
  has(id: string): boolean {
    return this.connectors.has(id);
  }

  /** All registered connectors, in registration order. */
  list(): readonly Connector[] {
    return [...this.connectors.values()];
  }

  /** Registered connector ids, in registration order. */
  ids(): readonly string[] {
    return [...this.connectors.keys()];
  }

  /** Number of registered connectors. */
  get size(): number {
    return this.connectors.size;
  }

  /**
   * Removes a connector. Throws when unknown. Removing a connector removes
   * only the registration - it never touches external systems.
   */
  unregister(id: string): void {
    if (!this.connectors.has(id)) {
      throw new ConnectorNotFoundError(id);
    }
    this.connectors.delete(id);
  }
}
