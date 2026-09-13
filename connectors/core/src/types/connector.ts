import type { CredentialReference } from '../credentials/index.js';
import type { ConnectorOperation } from '../operations/index.js';
import type { ConnectorMetadata } from './metadata.js';
import type { Permission } from '../permissions/index.js';
import type { ConnectorHealth, ConnectorStatusInfo } from './status.js';

/**
 * The provider-neutral connector contract.
 *
 * Every future connector - GitHub, GitLab, PostgreSQL, S3, Stripe, Paystack,
 * Vercel, ... - implements exactly this interface. The core knows nothing
 * about vendors: no SDKs, no vendor types, no vendor errors cross this
 * boundary. What the core sees is metadata, a permission catalog, declared
 * operations, a credential REFERENCE, and lifecycle behavior.
 *
 * Design rules:
 * - All properties are readonly declarations; behavior goes through methods.
 * - `connect`/`disconnect`/`checkHealth` are the ONLY network-capable seams,
 *   and even they are invoked exclusively by the ConnectorManager - never by
 *   the AI and never at registration time.
 * - Nothing here executes operations (that is the future Tool System).
 */
export interface Connector {
  /** Identity card of this connector - pure metadata, no vendor coupling. */
  readonly metadata: ConnectorMetadata;

  /**
   * The permission catalog this connector DECLARES (what it could do).
   * Declaring a permission grants nothing - grants are explicit manager state.
   */
  readonly permissions: readonly Permission[];

  /** Operations this connector supports - declarations, not executors. */
  readonly operations: readonly ConnectorOperation[];

  /**
   * Optional metadata-only pointer to the credential this connector uses.
   * Structurally incapable of carrying a raw secret - see CredentialReference.
   */
  readonly credential?: CredentialReference;

  /**
   * The connector's own status snapshot (lifecycle overlay lives in the
   * manager; this reports what the connector itself knows).
   */
  getStatus(): ConnectorStatusInfo;

  /** Checks the connector's external service health. May use the network. */
  checkHealth(): Promise<ConnectorHealth>;

  /** Establishes the external connection. May use the network. */
  connect(): Promise<void>;

  /** Closes the external connection. May use the network. */
  disconnect(): Promise<void>;
}
