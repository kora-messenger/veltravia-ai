import { createAuditEvent, type AuditSink, type ConnectorAuditEvent } from '../audit/index.js';
import type { CredentialReference } from '../credentials/index.js';
import {
  ConnectorConnectionError,
  ConnectorNotFoundError,
  ConnectorOperationError,
  ConnectorPermissionError,
  isConnectorError,
} from '../errors/index.js';
import type { ConnectorOperation } from '../operations/index.js';
import { operationRequiresConfirmation } from '../operations/index.js';
import { PermissionSet, type Permission } from '../permissions/index.js';
import { ConnectorRegistry } from '../registry/index.js';
import type { ConnectorCapability } from '../types/capabilities.js';
import type { Connector } from '../types/connector.js';
import type { ConnectorMetadata } from '../types/metadata.js';
import type { ConnectorHealth, ConnectorStatus, ConnectorStatusInfo } from '../types/status.js';

/** Everything the manager tracks for one connector, beyond the registration. */
export interface ManagedConnectorRecord {
  readonly connector: Connector;
  /** Lifecycle status owned by the manager. */
  status: ConnectorStatus;
  statusDetail?: string;
  statusSince: string;
  /** The granted permission ids - EMPTY at registration, by design. */
  granted: PermissionSet;
  /** Optional metadata-only credential reference. */
  credential?: CredentialReference;
}

/** Read-only snapshot for inspections and the (read-only) API surface. */
export interface ConnectorInspection {
  readonly metadata: ConnectorMetadata;
  readonly capabilities: readonly ConnectorCapability[];
  readonly permissions: readonly Permission[];
  readonly grantedPermissions: readonly string[];
  readonly operations: readonly ConnectorOperation[];
  readonly status: ConnectorStatusInfo;
  readonly credential?: CredentialReference;
}

/** The result of the permission gate for a requested operation (no execution). */
export interface OperationAuthorization {
  readonly connectorId: string;
  readonly operation: ConnectorOperation;
  /** True only if every required permission is currently granted. */
  readonly authorized: boolean;
  /** Required-but-not-granted permission ids (empty when authorized). */
  readonly missingPermissions: readonly string[];
  /** Effective human-confirmation requirement (explicit flag OR high risk). */
  readonly requiresConfirmation: boolean;
}

export interface ConnectorManagerOptions {
  /** Injectable clock - keeps every timestamp deterministic in tests. */
  readonly now?: () => Date;
  /** Receives every audit event (logging, persistence arrive in later steps). */
  readonly onAudit?: AuditSink;
  /** Pre-built registry (tests may inject one). */
  readonly registry?: ConnectorRegistry;
}

/**
 * The ConnectorManager is the ONLY sanctioned entry point for interacting
 * with connectors - the future Tool/Function System (Step 5) will call THIS,
 * never a connector directly.
 *
 * Layered responsibilities:
 * - registration (validated) + lifecycle (configure/connect/disconnect/disable)
 * - the permission gate: registration grants NOTHING; grants are explicit
 * - read-only inspection (capabilities, operations, status, health)
 * - operation authorization: validates + permission-checks a requested
 *   operation WITHOUT executing it (execution is Step 5)
 * - audit events for every state change and decision
 *
 * The manager performs no autonomous actions and never invents operations.
 */
export class ConnectorManager {
  private readonly registry: ConnectorRegistry;
  private readonly now: () => Date;
  private readonly onAudit?: AuditSink;
  private readonly records = new Map<string, ManagedConnectorRecord>();

  constructor(options: ConnectorManagerOptions = {}) {
    this.registry = options.registry ?? new ConnectorRegistry();
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
  }

  // ---- registration --------------------------------------------------------

  /**
   * Registers a validated connector. Its granted-permission set starts
   * EMPTY - registering a connector never grants anything (security rule).
   */
  register(connector: Connector): void {
    this.registry.register(connector);
    const timestamp = this.timestamp();
    this.records.set(connector.metadata.id, {
      connector,
      status: 'registered',
      statusSince: timestamp,
      granted: PermissionSet.empty(),
    });
    this.audit(
      'connector_registered',
      connector.metadata.id,
      `Registered connector "${connector.metadata.name}"`,
    );
  }

  /** Whether a connector id is registered. */
  has(id: string): boolean {
    return this.registry.has(id);
  }

  /** The registered connector implementation. */
  get(id: string): Connector {
    return this.registry.get(id);
  }

  /** All registered connectors in registration order. */
  list(): readonly Connector[] {
    return this.registry.list();
  }

  /** Removes a connector and its manager state. */
  unregister(id: string): void {
    this.registry.unregister(id);
    this.records.delete(id);
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Records configuration (optionally a metadata-only credential reference)
   * and moves the connector to "configured". Never reads or stores secrets.
   */
  configure(id: string, credential?: CredentialReference): void {
    const record = this.record(id);
    if (credential !== undefined) record.credential = credential;
    this.setStatus(
      record,
      'configured',
      credential !== undefined ? 'credential reference attached' : undefined,
    );
    this.audit(
      'connector_configured',
      id,
      `Configured connector "${record.connector.metadata.name}"`,
    );
  }

  /**
   * Calls the connector's connect() and tracks the outcome. A failure marks
   * the connector as "error" and rethrows a typed error - the original cause
   * is chained, never swallowed, never leaking secrets.
   */
  async connect(id: string): Promise<void> {
    const record = this.record(id);
    if (record.status === 'disabled') {
      throw new ConnectorConnectionError(id, 'connector is disabled');
    }
    try {
      await record.connector.connect();
    } catch (error) {
      this.setStatus(record, 'error', 'connect failed');
      this.audit('operation_failed', id, 'Connection attempt failed');
      throw this.wrapConnectionError(id, error);
    }
    this.setStatus(record, 'connected');
    this.audit(
      'connector_connected',
      id,
      `Connected connector "${record.connector.metadata.name}"`,
    );
  }

  /** Calls the connector's disconnect() and moves it to "disconnected". */
  async disconnect(id: string): Promise<void> {
    const record = this.record(id);
    try {
      await record.connector.disconnect();
    } catch (error) {
      this.setStatus(record, 'error', 'disconnect failed');
      this.audit('operation_failed', id, 'Disconnection attempt failed');
      throw this.wrapConnectionError(id, error);
    }
    this.setStatus(record, 'disconnected');
    this.audit(
      'connector_disconnected',
      id,
      `Disconnected connector "${record.connector.metadata.name}"`,
    );
  }

  /** Manager-level kill switch: no connector code runs while disabled. */
  disable(id: string): void {
    const record = this.record(id);
    this.setStatus(record, 'disabled', 'disabled by operator');
  }

  /** The manager-owned lifecycle snapshot for one connector. */
  getStatus(id: string): ConnectorStatusInfo {
    const record = this.record(id);
    return {
      status: record.status,
      ...(record.statusDetail !== undefined ? { detail: record.statusDetail } : {}),
      since: record.statusSince,
    };
  }

  /** Delegates to the connector's own health check. */
  async checkHealth(id: string): Promise<ConnectorHealth> {
    return this.record(id).connector.checkHealth();
  }

  // ---- permissions ----------------------------------------------------------

  /** The generic capabilities a connector declares. */
  getCapabilities(id: string): readonly ConnectorCapability[] {
    return this.record(id).connector.metadata.capabilities;
  }

  /** The permission catalog a connector DECLARES (grants are separate). */
  getPermissions(id: string): readonly Permission[] {
    return this.record(id).connector.permissions;
  }

  /** The permission ids currently GRANTED for this connector. */
  getGrantedPermissions(id: string): readonly string[] {
    return this.record(id).granted.list();
  }

  /** Grants a permission the connector declares. Grants nothing else. */
  grantPermission(id: string, permissionId: string): void {
    const record = this.record(id);
    this.requireDeclared(record, permissionId);
    record.granted = record.granted.with(permissionId);
    this.audit('permission_granted', id, `Granted permission "${permissionId}"`, {
      permissionId,
    });
  }

  /** Revokes a previously granted permission. */
  revokePermission(id: string, permissionId: string): void {
    const record = this.record(id);
    this.requireDeclared(record, permissionId);
    record.granted = record.granted.without(permissionId);
    this.audit('permission_revoked', id, `Revoked permission "${permissionId}"`, {
      permissionId,
    });
  }

  /** Whether a permission is granted (declared catalog is NOT enough). */
  hasPermission(id: string, permissionId: string): boolean {
    return this.record(id).granted.has(permissionId);
  }

  /**
   * The permission gate. Throws ConnectorPermissionError when the permission
   * is not currently granted, and audits the denial.
   */
  assertPermission(id: string, permissionId: string): void {
    const record = this.record(id);
    if (!record.granted.has(permissionId)) {
      this.audit('permission_denied', id, `Permission "${permissionId}" denied - not granted`, {
        permissionId,
      });
      throw new ConnectorPermissionError(
        `Permission "${permissionId}" is not granted for connector "${id}".`,
        { permissionId },
      );
    }
  }

  // ---- operations (authorization only - execution is Step 5) ----------------

  /** The operations a connector declares. */
  getOperations(id: string): readonly ConnectorOperation[] {
    return this.record(id).connector.operations;
  }

  /**
   * Runs the permission gate for a requested operation WITHOUT executing it.
   * The result states whether the request would be allowed, which permission
   * ids are missing, and whether human confirmation would be required.
   *
   * This is the seam the future Tool System plugs into: authorize first,
   * then (for high-risk) collect approval, then execute.
   */
  authorizeOperation(id: string, operationId: string): OperationAuthorization {
    const record = this.record(id);
    const operation = record.connector.operations.find((candidate) => candidate.id === operationId);
    if (operation === undefined) {
      this.audit('operation_rejected', id, `Unknown operation "${operationId}" requested`);
      throw new ConnectorOperationError(id, operationId, 'operation does not exist');
    }
    const missing = operation.requiredPermissions.filter(
      (permissionId) => !record.granted.has(permissionId),
    );
    const authorized = missing.length === 0;
    this.audit(
      'operation_requested',
      id,
      authorized
        ? `Operation "${operationId}" authorized`
        : `Operation "${operationId}" blocked - missing permissions`,
      { operationId, authorized, missingPermissions: [...missing] },
    );
    if (!authorized) {
      this.audit('operation_rejected', id, `Operation "${operationId}" rejected`, {
        operationId,
        missingPermissions: [...missing],
      });
    }
    return {
      connectorId: id,
      operation,
      authorized,
      missingPermissions: missing,
      requiresConfirmation: operationRequiresConfirmation(operation, record.connector.permissions),
    };
  }

  // ---- inspection --------------------------------------------------------

  /** Full read-only snapshot: metadata, capabilities, permissions, status. */
  inspect(id: string): ConnectorInspection {
    const record = this.record(id);
    const status = this.getStatus(id);
    return {
      metadata: record.connector.metadata,
      capabilities: record.connector.metadata.capabilities,
      permissions: record.connector.permissions,
      grantedPermissions: record.granted.list(),
      operations: record.connector.operations,
      status,
      ...(record.credential !== undefined ? { credential: record.credential } : {}),
    };
  }

  // ---- internals ----------------------------------------------------------

  private record(id: string): ManagedConnectorRecord {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new ConnectorNotFoundError(id);
    }
    return record;
  }

  private requireDeclared(record: ManagedConnectorRecord, permissionId: string): void {
    if (!record.connector.permissions.some((permission) => permission.id === permissionId)) {
      throw new ConnectorPermissionError(
        `Permission "${permissionId}" is not declared by connector "${record.connector.metadata.id}" - only declared permissions can be granted.`,
        { permissionId },
      );
    }
  }

  private setStatus(
    record: ManagedConnectorRecord,
    status: ConnectorStatus,
    detail?: string,
  ): void {
    record.status = status;
    record.statusDetail = detail;
    record.statusSince = this.timestamp();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private audit(
    type: ConnectorAuditEvent['type'],
    connectorId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.onAudit === undefined) return;
    this.onAudit(
      createAuditEvent({
        type,
        connectorId,
        summary,
        ...(metadata !== undefined ? { metadata } : {}),
        timestamp: this.timestamp(),
      }),
    );
  }

  private wrapConnectionError(id: string, error: unknown): Error {
    if (isConnectorError(error)) return error;
    return new ConnectorConnectionError(id, (error as Error).message ?? 'unknown failure', {
      cause: error,
    });
  }
}
