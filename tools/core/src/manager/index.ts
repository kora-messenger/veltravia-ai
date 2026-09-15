import {
  ConnectorManager,
  ConnectorNotFoundError,
  isConnectorError,
  PermissionSet,
  type OperationAuthorization,
} from '@veltravia/connector-core';

import type { ToolAuditEvent, ToolAuditSink } from '../audit/index.js';
import { createToolAuditEvent } from '../audit/index.js';
import type { ToolAvailability } from '../availability/index.js';
import {
  InMemoryConfirmationService,
  type ConfirmationDecision,
  type ToolConfirmationRequest,
} from '../confirmation/index.js';
import {
  ToolNotFoundError,
  ToolPermissionError,
  ToolUnavailableError,
  isToolError,
} from '../errors/index.js';
import type { ToolInvocationResult } from '../invocation/index.js';
import { createToolInvocation, createToolInvocationResult } from '../invocation/index.js';
import { ToolRegistry } from '../registry/index.js';
import type { PermissionRiskLevel } from '@veltravia/connector-core';
import type { ConfirmationState } from '../confirmation/index.js';
import type { ToolDefinition } from '../types/definition.js';
import { effectiveConfirmationRequirement } from '../types/definition.js';
import { ToolExecutor, type ToolImplementation } from '../executor/index.js';

/** Everything the manager tracks for one tool beyond its definition. */
export interface ManagedToolRecord {
  readonly definition: ToolDefinition;
  /** Operator kill-switch: disabled tools never execute. */
  disabled: boolean;
  disabledDetail?: string;
  /** Granted permission ids - EMPTY at registration, by design. */
  granted: PermissionSet;
}

/** Read-only snapshot for inspections and the (read-only) API surface. */
export interface ToolInspection {
  readonly definition: ToolDefinition;
  readonly requiredPermissions: readonly string[];
  readonly grantedPermissions: readonly string[];
  readonly availability: ToolAvailability;
  readonly confirmationRequired: boolean;
  readonly hasConnectorReference: boolean;
  readonly hasLocalImplementation: boolean;
}

/** Read-only view of one pending/resolved confirmation request (safe metadata only). */
export interface ConfirmationView {
  readonly confirmationId: string;
  readonly invocationId: string;
  readonly toolId: string;
  readonly riskLevel: PermissionRiskLevel;
  readonly state: ConfirmationState;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | undefined;
}

export interface InvokeOptions {
  /** Who/what is requesting (e.g. "api", "agent", "test-harness"). */
  readonly requester: string;
  /** Optional correlation across related invocations. */
  readonly correlationId?: string;
  /** Permissions the requester CLAIMS - claims grant nothing. */
  readonly requestedPermissions?: readonly string[];
  /** Present when a human has already approved this invocation. */
  readonly confirmationId?: string;
}

export interface ToolManagerOptions {
  /** Injectable clock - every timestamp is deterministic in tests. */
  readonly now?: () => Date;
  /** Receives every tool audit event. */
  readonly onAudit?: ToolAuditSink;
  /** Pre-built registry (tests may inject one). */
  readonly registry?: ToolRegistry;
  /** Pre-built confirmation service. */
  readonly confirmations?: InMemoryConfirmationService;
  /**
   * The Step 4 ConnectorManager - the tool system routes connector-backed
   * tools through it and can never bypass it. Optional because a deployment
   * may expose tools without any connector integration.
   */
  readonly connectors?: ConnectorManager;
  /**
   * OPTIONAL connector operation execution layer (Step 10). When wired, a
   * connector-backed tool that passes the full gate (permissions,
   * authorization, confirmation) executes through this seam. The layer is
   * responsible for routing to the right connector connection, enforcing the
   * connection's repository scope, mapping failures to typed ToolErrors, and
   * returning a normalized, schema-validable output. When absent,
   * connector-backed tools fail explicitly (Step 5 boundary).
   */
  readonly connectorExecutor?: ConnectorOperationExecutor;
}

/**
 * The Step 10 connector operation execution layer contract. The executor
 * receives the ALREADY-AUTHORIZED tool definition and its schema-validated
 * input - it must not and cannot re-run the confirmation flow, but it MUST
 * enforce its own connection scope. Every failure surfaces as a typed
 * ToolError so no vendor detail leaks upward.
 */
export interface ConnectorOperationExecutor {
  executeConnectorOperation(
    tool: ToolDefinition,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
}

/**
 * The ToolManager is the primary interface between AI orchestration (a
 * future agent layer) and available tools - and in Step 5 the ONLY entry
 * point for tool interaction:
 *
 * - registration (validated; grants NOTHING) and lifecycle (disable/enable)
 * - explicit, auditable tool-permission grants
 * - runtime availability computation (registration != executable)
 * - human confirmation decisions (never automatic)
 * - controlled invocation through the ToolExecutor pipeline, normalized into
 *   ToolInvocationResults
 *
 * The manager performs no autonomous action: it never invents tools, never
 * grants permissions by itself, never approves confirmations, and never
 * calls an external service.
 */
export class ToolManager {
  private readonly registry: ToolRegistry;
  private readonly now: () => Date;
  private readonly onAudit?: ToolAuditSink;
  private readonly connectors?: ConnectorManager;
  private readonly connectorExecutor?: ConnectorOperationExecutor;
  readonly confirmations: InMemoryConfirmationService;
  private readonly records = new Map<string, ManagedToolRecord>();
  private readonly executor: ToolExecutor;

  constructor(options: ToolManagerOptions = {}) {
    this.registry = options.registry ?? new ToolRegistry();
    this.confirmations =
      options.confirmations ?? new InMemoryConfirmationService({ now: options.now });
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
    this.connectors = options.connectors;
    this.connectorExecutor = options.connectorExecutor;
    const connectorExecutor = options.connectorExecutor;
    this.executor = new ToolExecutor({
      host: {
        getDefinition: (toolId) => this.getDefinition(toolId),
        getGrantedPermissions: (toolId) => this.getGrantedPermissions(toolId),
        getAvailability: (toolId) => this.getAvailability(toolId),
        authorizeConnectorOperation: (tool) => this.authorizeConnectorOperation(tool),
        ...(connectorExecutor !== undefined
          ? {
              executeConnectorOperation: (
                tool: ToolDefinition,
                input: Readonly<Record<string, unknown>>,
              ) => connectorExecutor.executeConnectorOperation(tool, input),
            }
          : {}),
      },
      confirmations: this.confirmations,
      now: this.now,
      onAudit: this.onAudit,
    });
  }

  // ---- registration --------------------------------------------------------

  /** Registers a validated tool definition with an EMPTY permission grant. */
  register(tool: ToolDefinition): void {
    this.registry.register(tool);
    this.records.set(tool.id, {
      definition: tool,
      disabled: false,
      granted: PermissionSet.empty(),
    });
    this.audit('tool_registered', tool.id, `Registered tool "${tool.name}"`);
  }

  /** Whether a tool id is registered. */
  has(id: string): boolean {
    return this.registry.has(id);
  }

  /** The registered tool definition. Throws when unknown. */
  getDefinition(id: string): ToolDefinition {
    return this.registry.get(id);
  }

  /** All registered tool definitions, in registration order. */
  list(): readonly ToolDefinition[] {
    return this.registry.list();
  }

  /** Removes a tool definition and all manager state for it. */
  unregister(id: string): void {
    this.registry.unregister(id);
    this.records.delete(id);
    this.audit('tool_unregistered', id, `Unregistered tool "${id}"`);
  }

  // ---- local implementations ----------------------------------------------

  /** Registers a typed local implementation (connector-backed tools rejected). */
  registerImplementation(implementation: ToolImplementation): void {
    this.executor.registerImplementation(implementation);
  }

  /** Whether a local implementation is registered for a tool. */
  hasImplementation(toolId: string): boolean {
    return this.executor.hasImplementation(toolId);
  }

  // ---- permissions ----------------------------------------------------------

  /** The permission ids this tool REQUIRES (its declaration). */
  getRequiredPermissions(toolId: string): readonly string[] {
    return [...this.getDefinition(toolId).requiredPermissions];
  }

  /** The permission ids currently GRANTED for this tool. */
  getGrantedPermissions(toolId: string): readonly string[] {
    return this.record(toolId).granted.list();
  }

  /** Grants one of the tool's declared required permissions. Nothing else. */
  grantPermission(toolId: string, permissionId: string): void {
    const tool = this.getDefinition(toolId);
    if (!tool.requiredPermissions.includes(permissionId)) {
      throw new ToolPermissionError(
        `Permission "${permissionId}" is not declared by tool "${toolId}" - only declared permissions can be granted.`,
        { toolId, permissionId },
      );
    }
    const record = this.record(toolId);
    record.granted = record.granted.with(permissionId);
    this.audit('tool_permission_granted', toolId, `Granted tool permission "${permissionId}"`, {
      permissionId,
    });
  }

  /** Revokes a previously granted tool permission. */
  revokePermission(toolId: string, permissionId: string): void {
    const tool = this.getDefinition(toolId);
    if (!tool.requiredPermissions.includes(permissionId)) {
      throw new ToolPermissionError(
        `Permission "${permissionId}" is not declared by tool "${toolId}".`,
        { toolId, permissionId },
      );
    }
    const record = this.record(toolId);
    record.granted = record.granted.without(permissionId);
    this.audit('tool_permission_revoked', toolId, `Revoked tool permission "${permissionId}"`, {
      permissionId,
    });
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Operator kill-switch: a disabled tool never executes. */
  disable(toolId: string, detail?: string): void {
    const record = this.record(toolId);
    record.disabled = true;
    record.disabledDetail = detail;
  }

  /** Re-enables a disabled tool. */
  enable(toolId: string): void {
    const record = this.record(toolId);
    record.disabled = false;
    record.disabledDetail = undefined;
  }

  /** Is the tool disabled by the operator? */
  isDisabled(toolId: string): boolean {
    return this.record(toolId).disabled;
  }

  // ---- availability -----------------------------------------------------------

  /**
   * Computes runtime availability - the answer to "may this tool run NOW?".
   * A registered tool is never automatically executable.
   */
  getAvailability(toolId: string): ToolAvailability {
    const tool = this.getDefinition(toolId);
    const record = this.record(toolId);
    if (record.disabled) {
      return {
        state: 'disabled',
        ...(record.disabledDetail !== undefined ? { detail: record.disabledDetail } : {}),
      };
    }
    if (tool.connector !== undefined) {
      if (this.connectors === undefined) {
        return {
          state: 'misconfigured',
          detail: 'tool system is not wired to a ConnectorManager',
        };
      }
      if (!this.connectors.has(tool.connector.connectorId)) {
        return {
          state: 'unavailable',
          detail: `connector "${tool.connector.connectorId}" is not registered`,
        };
      }
      const connectorStatus = this.connectors.getStatus(tool.connector.connectorId);
      if (connectorStatus.status === 'disabled' || connectorStatus.status === 'error') {
        return {
          state: 'unavailable',
          detail: `connector "${tool.connector.connectorId}" is ${connectorStatus.status}`,
        };
      }
      if (connectorStatus.status !== 'configured' && connectorStatus.status !== 'connected') {
        return {
          state: 'awaiting_configuration',
          detail: `connector "${tool.connector.connectorId}" is ${connectorStatus.status}`,
        };
      }
    }
    const missing = tool.requiredPermissions.filter(
      (permissionId) => !record.granted.has(permissionId),
    );
    if (missing.length > 0) {
      return {
        state: 'permission_denied',
        detail: `missing granted permissions: ${missing.join(', ')}`,
      };
    }
    return { state: 'available' };
  }

  // ---- confirmation ---------------------------------------------------------

  /**
   * Records an explicit human decision on a confirmation. Never called by
   * the framework itself - a future UI/agent layer uses this seam to ask
   * "Veltravia AI wants permission to perform this action."
   */
  confirm(confirmationId: string, decision: ConfirmationDecision): ToolConfirmationRequest {
    const request = this.confirmations.decide(confirmationId, decision);
    this.audit(
      decision === 'approved' ? 'tool_confirmation_approved' : 'tool_confirmation_rejected',
      request.toolId,
      `Confirmation for tool "${request.toolId}" was ${decision}`,
      { confirmationId },
    );
    return request;
  }

  // ---- invocation -----------------------------------------------------------

  /**
   * Runs the full controlled pipeline for one invocation and returns a
   * NORMALIZED result: success | failure | denied | awaiting_confirmation.
   * The AI request itself is never authority - everything is re-checked.
   */
  async invoke(
    toolId: string,
    input: Record<string, unknown>,
    options: InvokeOptions,
  ): Promise<ToolInvocationResult> {
    // A caller passing a confirmationId is RESUMING a confirmed invocation:
    // the approval binds to one invocation, so the invocation id is reused.
    let resumeInvocationId: string | undefined;
    if (options.confirmationId !== undefined) {
      try {
        const confirmation = this.confirmations.get(options.confirmationId);
        if (confirmation.toolId !== toolId) {
          throw new ToolPermissionError(`Confirmation does not belong to tool "${toolId}".`, {
            toolId,
            confirmationId: options.confirmationId,
          });
        }
        resumeInvocationId = confirmation.invocationId;
      } catch (error) {
        if (isToolError(error)) throw error;
        throw new ToolPermissionError(`Confirmation cannot be used: ${(error as Error).message}`, {
          toolId,
          confirmationId: options.confirmationId,
        });
      }
    }
    const invocation = createToolInvocation({
      toolId,
      input,
      requester: options.requester,
      ...(resumeInvocationId !== undefined ? { id: resumeInvocationId } : {}),
      ...(options.requestedPermissions !== undefined
        ? { requestedPermissions: options.requestedPermissions }
        : {}),
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
      requestedAt: this.now().toISOString(),
    });
    this.audit('tool_invocation_requested', toolId, `Invocation of tool "${toolId}" requested`, {
      invocationId: invocation.id,
      requester: options.requester,
    });

    try {
      const outcome = await this.executor.execute(invocation, {
        ...(options.confirmationId !== undefined ? { confirmationId: options.confirmationId } : {}),
      });
      if (outcome.kind === 'awaiting_confirmation') {
        this.audit(
          'tool_confirmation_requested',
          toolId,
          `Confirmation required for invocation of tool "${toolId}"`,
          { invocationId: invocation.id, confirmationId: outcome.confirmation.id },
        );
        return createToolInvocationResult({
          invocationId: invocation.id,
          toolId,
          ...(invocation.correlationId !== undefined
            ? { correlationId: invocation.correlationId }
            : {}),
          status: 'awaiting_confirmation',
          requestedAt: invocation.requestedAt,
          completedAt: this.now().toISOString(),
          confirmationId: outcome.confirmation.id,
        });
      }
      this.audit('tool_execution_completed', toolId, `Tool "${toolId}" completed successfully`, {
        invocationId: invocation.id,
      });
      return createToolInvocationResult({
        invocationId: invocation.id,
        toolId,
        ...(invocation.correlationId !== undefined
          ? { correlationId: invocation.correlationId }
          : {}),
        status: 'success',
        output: outcome.output as Record<string, unknown>,
        requestedAt: invocation.requestedAt,
        completedAt: this.now().toISOString(),
      });
    } catch (error) {
      // Normalize EVERY failure into a typed, secret-free, auditable result.
      const toolError = isToolError(error)
        ? error
        : new ToolUnavailableError(toolId, (error as Error).message ?? 'unknown failure');
      const isExecutionFailure =
        toolError.code === 'TOOL_EXECUTION' || toolError.code === 'TOOL_OUTPUT_VALIDATION';
      this.audit(
        isExecutionFailure ? 'tool_execution_failed' : 'tool_invocation_denied',
        toolId,
        `Invocation of tool "${toolId}" ${isExecutionFailure ? 'failed' : 'was denied'}: ${toolError.message}`,
        { invocationId: invocation.id, errorCode: toolError.code },
      );
      return createToolInvocationResult({
        invocationId: invocation.id,
        toolId,
        ...(invocation.correlationId !== undefined
          ? { correlationId: invocation.correlationId }
          : {}),
        status: isExecutionFailure ? 'failure' : 'denied',
        error: toolError.toJSON(),
        requestedAt: invocation.requestedAt,
        completedAt: this.now().toISOString(),
      });
    }
  }

  // ---- inspection -------------------------------------------------------------

  /**
   * Safe, read-only view of one confirmation request (risk level, state,
   * timestamps - never input data, never secrets). Used by presentation
   * layers to describe a pending confirmation; all decisions still flow
   * exclusively through confirm().
   */
  getConfirmation(confirmationId: string): ConfirmationView | null {
    let request: ToolConfirmationRequest;
    try {
      request = this.confirmations.get(confirmationId);
    } catch {
      return null;
    }
    return {
      confirmationId: request.id,
      invocationId: request.invocationId,
      toolId: request.toolId,
      riskLevel: request.riskLevel,
      state: request.state,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      decidedAt: request.decidedAt,
    };
  }

  /** Full read-only snapshot: definition, grants, availability, flags. */
  inspect(toolId: string): ToolInspection {
    const tool = this.getDefinition(toolId);
    return {
      definition: tool,
      requiredPermissions: [...tool.requiredPermissions],
      grantedPermissions: this.getGrantedPermissions(toolId),
      availability: this.getAvailability(toolId),
      confirmationRequired: effectiveConfirmationRequirement(tool),
      hasConnectorReference: tool.connector !== undefined,
      hasLocalImplementation: this.executor.hasImplementation(toolId),
    };
  }

  // ---- internals --------------------------------------------------------------

  record(toolId: string): ManagedToolRecord {
    const record = this.records.get(toolId);
    if (record === undefined) {
      throw new ToolNotFoundError(toolId);
    }
    return record;
  }

  /**
   * Connector-backed tools authorize ONLY through the ConnectorManager -
   * this is the non-bypass seam. Connector errors are normalized into tool
   * errors so no vendor/connector detail leaks upward.
   */
  private authorizeConnectorOperation(tool: ToolDefinition): OperationAuthorization {
    if (this.connectors === undefined || tool.connector === undefined) {
      throw new ToolUnavailableError(tool.id, 'tool system is not wired to a ConnectorManager');
    }
    try {
      return this.connectors.authorizeOperation(
        tool.connector.connectorId,
        tool.connector.operationId,
      );
    } catch (error) {
      if (error instanceof ConnectorNotFoundError || isConnectorError(error)) {
        throw new ToolUnavailableError(tool.id, (error as Error).message);
      }
      throw error;
    }
  }

  private audit(
    type: ToolAuditEvent['type'],
    toolId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.onAudit === undefined) return;
    this.onAudit(
      createToolAuditEvent({
        type,
        toolId,
        summary,
        ...(metadata !== undefined ? { metadata } : {}),
        timestamp: this.now().toISOString(),
      }),
    );
  }
}
