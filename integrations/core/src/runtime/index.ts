import { scrubDetails } from '@veltravia/connector-core';

import { createIntegrationAuditEvent, type IntegrationAuditSink } from '../audit/index.js';
import {
  assertIntegrationEnabled,
  ConnectionManager,
  type Connection,
  type ConnectionOwner,
} from '../connection/index.js';
import {
  IntegrationCredentialUnavailableError,
  IntegrationExecutionFailedError,
  IntegrationNotFoundError,
  isIntegrationError,
  MissingScopeError,
} from '../errors/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { IntegrationDefinition } from '../types/integration.js';
import type { IntegrationRegistry } from '../registry/index.js';

/**
 * THE CONNECTOR RUNTIME.
 *
 * The single sanctioned execution boundary between the platform and an
 * integration's operations. The ONLY caller is the Tool System's
 * connector-execution seam (Step 10) - the AI never reaches this layer
 * directly, and connectors can never be invoked around the Tool System.
 *
 * Pipeline for every execute() call:
 *  1. resolve the integration (typed not-found)
 *  2. verify it is enabled (fail closed)
 *  3. resolve the connection within the OWNER boundary (cross-owner fails
 *     closed as not-found + audited)
 *  4. verify connection state (connected)
 *  5. verify the requested operation is declared by the integration
 *  6. verify authorization: every required scope is GRANTED to the
 *     connection (scopes, tool permissions, and risk are separate
 *     concerns - the Tool System checks tool permissions upstream)
 *  7. evaluate risk: high/critical operations require confirmation - the
 *     CONFIRMATION itself is enforced upstream by the Tool System (the
 *     existing mechanisms stay authoritative; this layer never invents a
 *     second approval path, it only fails closed if asked to execute an
 *     unconfirmed high-risk operation)
 *  8. retrieve the credential INSIDE this boundary (only integration
 *     runtimes call getSecret; the value never leaves the executor call)
 *  9. execute the operation through the registered executor
 * 10. scrub secrets from the result
 * 11. validate the result shape (plain, serializable object)
 * 12. return a safe normalized result
 * 13. write audit events (executed / failed / denied)
 */

/** Input to one runtime execution. */
export interface RuntimeExecutionRequest {
  readonly integrationId: string;
  readonly connectionId: string;
  readonly owner: ConnectionOwner;
  readonly operationId: string;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * Set ONLY by the Tool System adapter after its confirmation gate
   * passed. High/critical-risk operations refuse to execute without it:
   * the runtime is not a bypass around the Tool System's approval flow.
   */
  readonly confirmationGated?: boolean;
}

/** The normalized, safe execution result. */
export interface RuntimeExecutionResult {
  readonly output: Readonly<Record<string, unknown>>;
  /** The connection that executed (usage counters updated). */
  readonly connectionId: string;
}

/**
 * One integration's operation executor - reached only through the runtime.
 * Receives schema-validated input, a bound connection, and - ONLY for
 * credential-bearing integrations - a secret provider callback. The
 * executor must return a plain object; vendor errors are wrapped by the
 * runtime into sanitized typed errors.
 */
export type IntegrationOperationExecutor = (
  input: Readonly<Record<string, unknown>>,
  context: {
    readonly operationId: string;
    readonly connection: Connection;
    readonly definition: IntegrationDefinition;
    readonly getSecret: () => string | undefined;
  },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface IntegrationRuntimeOptions {
  readonly registry: IntegrationRegistry;
  readonly connections: ConnectionManager;
  /** The platform secret boundary - the runtime is its ONLY sanctioned reader. */
  readonly secrets: SecretStore;
  /** Per-integration operation executors, registered by the wiring layer. */
  readonly executors: Readonly<Record<string, IntegrationOperationExecutor>>;
  readonly now?: () => Date;
  readonly onAudit?: IntegrationAuditSink;
}

export class IntegrationRuntime {
  private readonly registry: IntegrationRegistry;
  private readonly connections: ConnectionManager;
  private readonly secrets: SecretStore;
  private readonly executors: Readonly<Record<string, IntegrationOperationExecutor>>;
  private readonly now: () => Date;
  private readonly onAudit?: IntegrationAuditSink;

  constructor(options: IntegrationRuntimeOptions) {
    this.registry = options.registry;
    this.connections = options.connections;
    this.secrets = options.secrets;
    this.executors = options.executors;
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
  }

  /**
   * Executes one operation through the full pipeline. Every failure is a
   * typed, sanitized IntegrationError - provider detail never leaks.
   */
  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const { integrationId, operationId } = request;

    // (1) resolve the integration
    if (!this.registry.has(integrationId)) {
      throw new IntegrationNotFoundError(integrationId);
    }
    const definition = this.registry.get(integrationId);
    // (2) enabled?
    assertIntegrationEnabled(this.registry.isEnabled(integrationId), integrationId);

    // (5) the operation is declared by the integration?
    const tool = definition.tools.find((candidate) => candidate.operationId === operationId);
    if (tool === undefined) {
      this.auditDenied(integrationId, operationId, 'operation not declared by the integration');
      throw new IntegrationExecutionFailedError(
        integrationId,
        operationId,
        `Integration "${integrationId}" does not declare operation "${operationId}".`,
      );
    }

    // (3) resolve the connection inside the owner boundary (fail closed)
    let connection: Connection;
    try {
      connection = this.connections.get(request.connectionId, request.owner);
    } catch (error) {
      this.auditDenied(
        integrationId,
        operationId,
        'connection not found within the owner boundary',
      );
      throw error;
    }

    // (4) connection state
    if (connection.status !== 'connected') {
      this.auditDenied(integrationId, operationId, `connection is ${connection.status}`);
      throw new IntegrationExecutionFailedError(
        integrationId,
        operationId,
        `Connection is ${connection.status} - operations fail closed until it is connected.`,
      );
    }

    // (6) authorization: granted scopes must cover the tool's scopes
    const granted = new Set(connection.grantedScopes);
    const missing = tool.requiredScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      this.auditDenied(
        integrationId,
        operationId,
        `missing granted scope(s): ${missing.join(', ')}`,
      );
      this.audit(
        'integration.authorization_denied',
        integrationId,
        `Operation "${operationId}" denied - missing granted scope(s)`,
        { connectionId: connection.connectionId, missingScopes: [...missing] },
      );
      throw new MissingScopeError(integrationId, missing);
    }

    // (7) risk: high/critical operations must arrive CONFIRMED from the
    // Tool System. The Tool System enforces the confirmation; this layer
    // only refuses to be a bypass around it (the request carries a flag
    // the Tool System sets after its confirmation gate passed).
    if (
      (tool.riskLevel === 'high' || tool.riskLevel === 'critical') &&
      request.confirmationGated !== true
    ) {
      this.auditDenied(
        integrationId,
        operationId,
        'high-risk operation reached the runtime without the Tool System confirmation gate',
      );
      throw new IntegrationExecutionFailedError(
        integrationId,
        operationId,
        'High-risk operations may only execute through the Tool System confirmation gate.',
      );
    }

    // (8) credential retrieval - INSIDE the boundary, value never stored
    const getSecret = (): string | undefined => {
      if (definition.authenticationType === 'none') return undefined;
      const secret = this.secrets.getSecret({
        integrationId,
        secretId: `connection:${connection.connectionId}`,
      });
      if (secret === undefined) {
        throw new IntegrationCredentialUnavailableError(integrationId);
      }
      return secret;
    };

    const executor = this.executors[integrationId];
    if (executor === undefined) {
      this.auditDenied(integrationId, operationId, 'no executor is registered for the integration');
      throw new IntegrationExecutionFailedError(
        integrationId,
        operationId,
        `Integration "${integrationId}" has no registered executor - the wiring layer must register one.`,
      );
    }

    // (9) execute + (10) scrub + (11) validate + (12) normalize
    let raw: Record<string, unknown>;
    try {
      raw = await executor(request.input, {
        operationId,
        connection,
        definition,
        getSecret,
      });
    } catch (error) {
      const detail = isIntegrationError(error) ? error.message : 'the integration operation failed';
      this.connections.markError(connection, detail);
      this.audit(
        'integration.execution_failed',
        integrationId,
        `Operation "${operationId}" failed`,
        { connectionId: connection.connectionId, operationId },
      );
      throw new IntegrationExecutionFailedError(integrationId, operationId, detail, error);
    }
    if (
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.getOwnPropertySymbols(raw).length > 0
    ) {
      this.audit(
        'integration.execution_failed',
        integrationId,
        `Operation "${operationId}" returned a non-object result`,
        { connectionId: connection.connectionId, operationId },
      );
      throw new IntegrationExecutionFailedError(
        integrationId,
        operationId,
        'The integration executor returned a result that is not a plain object.',
      );
    }
    const output = scrubDetails(raw) as Record<string, unknown>;

    this.connections.incrementOperationCount(connection.connectionId);
    this.audit('integration.tool_executed', integrationId, `Operation "${operationId}" executed`, {
      connectionId: connection.connectionId,
      operationId,
    });
    return { output, connectionId: connection.connectionId };
  }

  private auditDenied(integrationId: string, operationId: string, detail: string): void {
    this.audit(
      'integration.authorization_denied',
      integrationId,
      `Operation "${operationId}" denied: ${detail}`,
      { operationId },
    );
  }

  private audit(
    type:
      | 'integration.tool_executed'
      | 'integration.execution_failed'
      | 'integration.authorization_denied',
    integrationId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.onAudit?.(
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
