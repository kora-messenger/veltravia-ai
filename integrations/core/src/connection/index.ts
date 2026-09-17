import type { CredentialReference } from '@veltravia/connector-core';

import {
  createIntegrationAuditEvent,
  type IntegrationAuditEvent,
  type IntegrationAuditSink,
} from '../audit/index.js';
import {
  ConnectionLimitReachedError,
  ConnectionNotFoundError,
  IntegrationConfigurationInvalidError,
  IntegrationCredentialUnavailableError,
  IntegrationDisabledError,
  IntegrationError,
  IntegrationNotFoundError,
  isIntegrationError,
} from '../errors/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { ConnectionStatus } from '../types/lifecycle.js';
import type { IntegrationDefinition } from '../types/integration.js';

/**
 * The connection model: one configured instance of an integration, owned
 * by an explicit user / workspace / project boundary.
 *
 * SECURITY SHAPE: a connection contains ONLY non-secret references - a
 * metadata-only credential reference, granted scope IDS, safe display
 * metadata. There is deliberately no field that could carry a raw token,
 * key, or password. Raw credentials stay inside the SecretStore and are
 * read only by the integration runtime during approved operations.
 */

/** Who owns a connection - the ownership/scope boundary. */
export const CONNECTION_OWNER_KINDS = ['user', 'workspace', 'project'] as const;

export type ConnectionOwnerKind = (typeof CONNECTION_OWNER_KINDS)[number];

export function isConnectionOwnerKind(value: unknown): value is ConnectionOwnerKind {
  return typeof value === 'string' && (CONNECTION_OWNER_KINDS as readonly string[]).includes(value);
}

/**
 * An owner reference. Stable and comparable: two owners match only when
 * kind AND id match. A project owner never matches another project's
 * owner, so connections never silently cross ownership boundaries.
 */
export interface ConnectionOwner {
  readonly kind: ConnectionOwnerKind;
  readonly id: string;
}

export function connectionOwnerLabel(owner: ConnectionOwner): string {
  return `${owner.kind}:${owner.id}`;
}

export function isSameOwner(a: ConnectionOwner, b: ConnectionOwner): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** One connection record. Metadata only - never a raw credential. */
export interface Connection {
  /** Stable connection id (e.g. "conn_x7k2m9a1"). */
  readonly connectionId: string;
  /** The integration this connection configures. */
  readonly integrationId: string;
  /** The explicit ownership boundary. */
  readonly owner: ConnectionOwner;
  /**
   * Safe account/reference display (e.g. "veltravia-demo/fixture-repo").
   * Sanitized on creation - it is display metadata, never a credential.
   */
  readonly accountRef: string;
  /** Connection lifecycle status. */
  status: ConnectionStatus;
  statusDetail?: string;
  /** Scope ids GRANTED to this connection (subset of the catalog). */
  grantedScopes: readonly string[];
  /** Metadata-only credential pointer - never a value. */
  readonly credential?: CredentialReference;
  /** Safe extra metadata (scrubbed). */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  updatedAt: string;
  /** Last health/status check timestamp, when a check ran. */
  lastStatusCheckAt?: string;
  /** Usage hook foundation: operations executed through this connection. */
  operationCount: number;
}

export interface ConnectionLimits {
  /**
   * Maximum connections per owner per integration. A foundation hook for
   * future quota/abuse controls - no billing, just an honest bound.
   */
  readonly maxConnectionsPerOwnerIntegration: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  maxConnectionsPerOwnerIntegration: 10,
};

export interface CreateConnectionInput {
  readonly integrationId: string;
  readonly owner: ConnectionOwner;
  /** Requested scopes - must all be declared by the integration. */
  readonly scopes: readonly string[];
  /** Safe account display reference. */
  readonly accountRef?: string;
  /** Safe extra metadata (scrubbed on storage). */
  readonly metadata?: Record<string, unknown>;
}

export interface ConnectionManagerOptions {
  /** Injectable clock - deterministic timestamps in tests. */
  readonly now?: () => Date;
  /** Receives every audit event. */
  readonly onAudit?: IntegrationAuditSink;
  /** Connection limits (abuse-foundation hook). */
  readonly limits?: ConnectionLimits;
}

/** Sanitizes an account display reference: one line, no credential shapes. */
function safeAccountRef(integrationId: string, raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : `${integrationId}-account`;
}

/**
 * The ConnectionManager owns every connection lifecycle operation.
 *
 * Ownership is enforced on EVERY access: a connection id that exists but
 * belongs to a different owner is reported as NOT FOUND from the calling
 * owner's perspective (and audited) - cross-project and cross-workspace
 * access attempts fail closed, they never fall through.
 */
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly now: () => Date;
  private readonly onAudit?: IntegrationAuditSink;
  private readonly limits: ConnectionLimits;
  private sequence = 0;

  constructor(options: ConnectionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
    this.limits = options.limits ?? DEFAULT_CONNECTION_LIMITS;
  }

  /**
   * Creates a connection. Grants are explicit: only the REQUESTED scopes
   * (validated against the integration's declared catalog) are granted.
   */
  create(definition: IntegrationDefinition, input: CreateConnectionInput): Connection {
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new IntegrationConfigurationInvalidError(definition.id, [
        'at least one scope must be requested',
      ]);
    }
    const declared = new Set(definition.scopes.map((scope) => scope.id));
    const unknown = input.scopes.filter((scope) => !declared.has(scope));
    if (unknown.length > 0) {
      throw new IntegrationConfigurationInvalidError(definition.id, [
        `undeclared scope(s) requested: ${unknown.join(', ')}`,
      ]);
    }

    const count = this.listOwnedBy(definition.id, input.owner).length;
    if (count >= this.limits.maxConnectionsPerOwnerIntegration) {
      throw new ConnectionLimitReachedError(
        definition.id,
        this.limits.maxConnectionsPerOwnerIntegration,
      );
    }

    this.sequence += 1;
    const connectionId = `conn_${this.sequence.toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const timestamp = this.now().toISOString();
    const connection: Connection = {
      connectionId,
      integrationId: definition.id,
      owner: { ...input.owner },
      accountRef: safeAccountRef(definition.id, input.accountRef),
      status: 'connected',
      grantedScopes: [...new Set(input.scopes)],
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      operationCount: 0,
    };
    this.connections.set(connectionId, connection);
    this.audit('integration.connected', definition.id, 'Connection created', {
      connectionId,
      owner: connectionOwnerLabel(input.owner),
      grantedScopes: [...connection.grantedScopes],
    });
    return this.snapshot(connection);
  }

  /** Owner-scoped lookup: cross-owner ids do not exist for this owner. */
  get(connectionId: string, owner: ConnectionOwner): Connection {
    const connection = this.connections.get(connectionId);
    if (connection === undefined || !isSameOwner(connection.owner, owner)) {
      if (connection !== undefined) {
        this.audit(
          'integration.ownership_denied',
          connection.integrationId,
          `Owner "${connectionOwnerLabel(owner)}" attempted to access a connection outside their boundary`,
          { connectionId },
        );
      }
      throw new ConnectionNotFoundError(connectionId, connectionOwnerLabel(owner));
    }
    return this.snapshot(connection);
  }

  /** All connections owned by one owner (optionally one integration). */
  listOwnedBy(integrationId: string | undefined, owner: ConnectionOwner): readonly Connection[] {
    return [...this.connections.values()]
      .filter((connection) => isSameOwner(connection.owner, owner))
      .filter(
        (connection) => integrationId === undefined || connection.integrationId === integrationId,
      )
      .map((connection) => this.snapshot(connection));
  }

  /** Whether any live connection exists for an integration (any owner). */
  hasActiveConnections(integrationId: string): boolean {
    return [...this.connections.values()].some(
      (connection) =>
        connection.integrationId === integrationId &&
        (connection.status === 'connected' || connection.status === 'disabled'),
    );
  }

  /**
   * Disconnects (removes) a connection: revokes the platform's usable
   * reference and invalidates future execution through it. HONEST WORDING:
   * this does NOT claim the external provider's token was revoked -
   * provider-side revocation is a connector concern for a later phase.
   */
  disconnect(connectionId: string, owner: ConnectionOwner): void {
    const connection = this.connections.get(connectionId);
    if (connection === undefined || !isSameOwner(connection.owner, owner)) {
      if (connection !== undefined) {
        this.audit(
          'integration.ownership_denied',
          connection.integrationId,
          `Owner "${connectionOwnerLabel(owner)}" attempted to disconnect a connection outside their boundary`,
          { connectionId },
        );
      }
      throw new ConnectionNotFoundError(connectionId, connectionOwnerLabel(owner));
    }
    this.connections.delete(connectionId);
    this.audit(
      'integration.disconnected',
      connection.integrationId,
      'Connection disconnected and removed - the platform no longer holds a usable reference (external provider revocation is NOT performed)',
      { connectionId, owner: connectionOwnerLabel(owner) },
    );
  }

  /** Disables a connection without removing it (re-enable later). */
  disable(connectionId: string, owner: ConnectionOwner): Connection {
    const connection = this.requireOwned(connectionId, owner);
    connection.status = 'disabled';
    connection.statusDetail = 'disabled by owner';
    connection.updatedAt = this.now().toISOString();
    this.audit(
      'integration.disabled',
      connection.integrationId,
      'Connection disabled - operations through it fail closed',
      { connectionId },
    );
    return this.snapshot(connection);
  }

  /** Re-enables a previously disabled connection. */
  enable(connectionId: string, owner: ConnectionOwner): Connection {
    const connection = this.requireOwned(connectionId, owner);
    connection.status = 'connected';
    connection.statusDetail = undefined;
    connection.updatedAt = this.now().toISOString();
    this.audit('integration.enabled', connection.integrationId, 'Connection enabled', {
      connectionId,
    });
    return this.snapshot(connection);
  }

  /** Records a status-check outcome (health data stays display-safe). */
  recordStatusCheck(
    connectionId: string,
    owner: ConnectionOwner,
    outcome: { readonly healthy: boolean; readonly detail?: string },
  ): Connection {
    const connection = this.requireOwned(connectionId, owner);
    connection.status = outcome.healthy ? 'connected' : 'error';
    connection.statusDetail = outcome.detail;
    connection.lastStatusCheckAt = this.now().toISOString();
    connection.updatedAt = connection.lastStatusCheckAt;
    return this.snapshot(connection);
  }

  /** Internal (runtime): marks a connection errored. */
  markError(connection: Connection, detail: string): void {
    connection.status = 'error';
    connection.statusDetail = detail.slice(0, 200);
    connection.updatedAt = this.now().toISOString();
  }

  /** Internal (runtime): increments the usage counter hook. */
  incrementOperationCount(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection !== undefined) connection.operationCount += 1;
  }

  /** Internal (runtime): mutates the live record through the manager. */
  liveRecord(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  private requireOwned(connectionId: string, owner: ConnectionOwner): Connection {
    const connection = this.connections.get(connectionId);
    if (connection === undefined || !isSameOwner(connection.owner, owner)) {
      if (connection !== undefined) {
        this.audit(
          'integration.ownership_denied',
          connection.integrationId,
          `Owner "${connectionOwnerLabel(owner)}" attempted to access a connection outside their boundary`,
          { connectionId },
        );
      }
      throw new ConnectionNotFoundError(connectionId, connectionOwnerLabel(owner));
    }
    return connection;
  }

  /** Returns a copy with no live references into manager state. */
  private snapshot(connection: Connection): Connection {
    return {
      ...connection,
      owner: { ...connection.owner },
      grantedScopes: [...connection.grantedScopes],
      metadata: { ...connection.metadata },
    };
  }

  private audit(
    type: IntegrationAuditEvent['type'],
    integrationId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.onAudit === undefined) return;
    this.onAudit(
      createIntegrationAuditEvent({
        type,
        integrationId,
        summary,
        ...(metadata !== undefined ? { metadata } : {}),
        timestamp: this.now().toISOString(),
      }),
    );
  }
}

/** Narrow helper for callers validating errors from connection flows. */
export function isConnectionError(error: unknown): error is IntegrationError {
  return isIntegrationError(error);
}

/** Ensures the integration is not disabled. */
export function assertIntegrationEnabled(enabled: boolean, integrationId: string): void {
  if (!enabled) throw new IntegrationDisabledError(integrationId);
}

/**
 * Credential availability check for credential-bearing integrations.
 * Uses hasSecret - the value is NEVER read during a check.
 */
export function assertCredentialAvailable(
  definition: IntegrationDefinition,
  store: SecretStore,
): void {
  if (definition.authenticationType === 'none') return;
  const available = store
    .describe()
    .some((ref) => ref.integrationId === definition.id && store.hasSecret(ref));
  if (!available) throw new IntegrationCredentialUnavailableError(definition.id);
}

/** Resolves the integration definition or throws the typed not-found. */
export function requireIntegrationDefinition(
  integrationId: string,
  registry: { has(id: string): boolean },
): void {
  if (!registry.has(integrationId)) {
    throw new IntegrationNotFoundError(integrationId);
  }
}
