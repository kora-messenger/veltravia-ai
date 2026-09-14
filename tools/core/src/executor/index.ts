import type { OperationAuthorization } from '@veltravia/connector-core';

import type { ToolAvailability } from '../availability/index.js';
import {
  digestToolInput,
  type InMemoryConfirmationService,
  type ToolConfirmationRequest,
} from '../confirmation/index.js';
import type { ToolAuditSink, ToolAuditEvent } from '../audit/index.js';
import { createToolAuditEvent } from '../audit/index.js';
import {
  InvalidToolInputError,
  ToolExecutionError,
  ToolOutputValidationError,
  ToolPermissionError,
  ToolUnavailableError,
  isToolError,
} from '../errors/index.js';
import type { ToolInvocation } from '../invocation/index.js';
import type { ToolDefinition } from '../types/definition.js';
import { effectiveConfirmationRequirement } from '../types/definition.js';
import { validateToolObject } from '../validation/schema.js';

/**
 * The host contract the ToolManager satisfies. Structural typing keeps the
 * executor decoupled from the manager implementation.
 */
export interface ToolExecutorHost {
  /** Registered definition (throws ToolNotFoundError when unknown). */
  getDefinition(toolId: string): ToolDefinition;
  /** Currently GRANTED tool permission ids. */
  getGrantedPermissions(toolId: string): readonly string[];
  /** Runtime availability of the tool. */
  getAvailability(toolId: string): ToolAvailability;
  /**
   * Routes a connector-backed tool's operation through the Step 4
   * ConnectorManager permission gate. Throws when the connector/operation is
   * unknown or the tool system is not wired to connectors.
   */
  authorizeConnectorOperation(tool: ToolDefinition): OperationAuthorization;
  /**
   * OPTIONAL connector operation execution seam (Step 10). When wired, a
   * connector-backed tool EXECUTES through this callback after the full gate
   * (authorization + confirmation) has passed. When absent, connector-backed
   * tools still stop at the Step 5 boundary - the failure is explicit.
   */
  executeConnectorOperation?(
    tool: ToolDefinition,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
}

/**
 * A controlled tool implementation. Handlers are TYPED and validated: they
 * receive schema-validated input only, must return a plain object, and are
 * registered BEFORE any execution - never per-invocation, never anonymous.
 * Connector-backed tools CANNOT have local handlers (they must route through
 * the ConnectorManager - no bypassing).
 */
export interface ToolImplementation {
  readonly toolId: string;
  readonly handler: (
    input: Readonly<Record<string, unknown>>,
    context: { readonly invocation: ToolInvocation },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ToolExecutorOptions {
  readonly host: ToolExecutorHost;
  readonly confirmations: InMemoryConfirmationService;
  readonly now: () => Date;
  readonly onAudit?: ToolAuditSink;
}

/** Internal success outcome of the pipeline (failures throw ToolError). */
export interface ToolExecutionSuccess {
  readonly kind: 'success';
  readonly output: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionAwaitingConfirmation {
  readonly kind: 'awaiting_confirmation';
  readonly confirmation: ToolConfirmationRequest;
}

export type ToolExecutionOutcome = ToolExecutionSuccess | ToolExecutionAwaitingConfirmation;

/**
 * The controlled execution pipeline. For EVERY invocation, in order:
 *
 *  1. find the tool (registry)
 *  2. check runtime availability
 *  3. validate the input against the tool's schema
 *  4. check granted tool permissions
 *  5. for connector-backed tools: authorize through the ConnectorManager
 *  6. evaluate the confirmation requirement (definition flag OR high/critical
 *     risk OR connector-operation requirement)
 *  7. execute - and ONLY then:
 *  8. validate the output against the tool's schema
 *  9. produce a normalized result + audit events
 *
 * Step 5 boundary: connector-backed tools stop at authorization - external
 * execution is NOT enabled yet (the framework says so explicitly). Local
 * safe tools (the mock) execute deterministically. No arbitrary functions
 * can be registered or executed: handlers exist only for validated, locally-
 * executable tools.
 */
export class ToolExecutor {
  private readonly host: ToolExecutorHost;
  private readonly confirmations: InMemoryConfirmationService;
  private readonly now: () => Date;
  private readonly onAudit?: ToolAuditSink;
  private readonly implementations = new Map<string, ToolImplementation>();

  constructor(options: ToolExecutorOptions) {
    this.host = options.host;
    this.confirmations = options.confirmations;
    this.now = options.now;
    this.onAudit = options.onAudit;
  }

  /**
   * Registers a typed implementation for a LOCALLY executable tool.
   * Connector-backed tools are rejected: their operations must route through
   * the ConnectorManager, never a local handler. Implementations cannot be
   * swapped while one is registered.
   */
  registerImplementation(implementation: ToolImplementation): void {
    const tool = this.host.getDefinition(implementation.toolId); // throws ToolNotFoundError
    if (tool.connector !== undefined) {
      throw new ToolExecutionError(
        tool.id,
        'connector-backed tools cannot have local implementations - they must route through the ConnectorManager',
      );
    }
    if (typeof implementation.handler !== 'function') {
      throw new ToolExecutionError(tool.id, 'implementation handler must be a function');
    }
    if (this.implementations.has(tool.id)) {
      throw new ToolExecutionError(tool.id, 'an implementation is already registered');
    }
    this.implementations.set(tool.id, implementation);
  }

  /** Whether a local implementation exists for a tool. */
  hasImplementation(toolId: string): boolean {
    return this.implementations.has(toolId);
  }

  /**
   * Runs the pipeline for one invocation. Throws typed ToolError subclasses
   * for every denial/failure; returns success or awaiting-confirmation
   * outcomes. The caller (ToolManager) normalizes both paths into a
   * ToolInvocationResult and emits the audit trail.
   */
  async execute(
    invocation: ToolInvocation,
    options: { readonly confirmationId?: string } = {},
  ): Promise<ToolExecutionOutcome> {
    // 1. Find the tool.
    const tool = this.host.getDefinition(invocation.toolId);

    // 2. Runtime availability - registration alone is never enough.
    //    ('permission_denied' falls through to the explicit permission gate
    //    below, which reports the missing permissions precisely.)
    const availability = this.host.getAvailability(tool.id);
    if (availability.state !== 'available' && availability.state !== 'permission_denied') {
      throw new ToolUnavailableError(tool.id, availability.detail ?? availability.state);
    }

    // 3. Validate the (untrusted) input against the declared schema.
    const inputProblems = validateToolObject(tool.inputSchema, invocation.input);
    if (inputProblems.length > 0) {
      throw new InvalidToolInputError(tool.id, inputProblems);
    }

    // 4. Tool permission gate - grants are explicit; registration granted none.
    const granted = this.host.getGrantedPermissions(tool.id);
    const missing = tool.requiredPermissions.filter((id) => !granted.includes(id));
    if (missing.length > 0) {
      throw new ToolPermissionError(
        `Tool "${tool.id}" is missing granted permissions: ${missing.join(', ')}.`,
        { toolId: tool.id, missingPermissions: [...missing] },
      );
    }

    // 5. Connector-backed tools: authorize through the ConnectorManager.
    //    The Tool System cannot bypass it - there is no other path.
    let connectorAuthorization: OperationAuthorization | undefined;
    if (tool.connector !== undefined) {
      connectorAuthorization = this.host.authorizeConnectorOperation(tool);
      if (!connectorAuthorization.authorized) {
        throw new ToolPermissionError(
          `Connector operation "${tool.connector.operationId}" for tool "${tool.id}" is not authorized: missing connector permissions ${connectorAuthorization.missingPermissions.join(', ')}.`,
          {
            toolId: tool.id,
            connectorId: tool.connector.connectorId,
            operationId: tool.connector.operationId,
            missingPermissions: [...connectorAuthorization.missingPermissions],
          },
        );
      }
    }

    // 6. Confirmation requirement (explicit flag can only RAISE the bar).
    const confirmationRequired =
      effectiveConfirmationRequirement(tool) ||
      (connectorAuthorization?.requiresConfirmation ?? false);
    let confirmation: ToolConfirmationRequest | undefined;
    if (confirmationRequired) {
      if (options.confirmationId === undefined) {
        // No decision yet -> stop here. The human decides; nothing auto-approves.
        confirmation = this.confirmations.request(
          tool.id,
          invocation.id,
          tool.riskLevel,
          digestToolInput(invocation.input),
        );
        return { kind: 'awaiting_confirmation', confirmation };
      }
      confirmation = this.confirmations.get(options.confirmationId);
      if (confirmation.state === 'expired') {
        throw new ToolPermissionError(
          `Confirmation for tool "${tool.id}" has expired - a new invocation is required.`,
          { toolId: tool.id, confirmationId: confirmation.id },
        );
      }
      if (confirmation.state === 'rejected') {
        throw new ToolPermissionError(
          `Confirmation for tool "${tool.id}" was rejected by the human operator.`,
          { toolId: tool.id, confirmationId: confirmation.id },
        );
      }
      if (confirmation.state !== 'approved') {
        throw new ToolPermissionError(
          `Confirmation for tool "${tool.id}" has not been approved yet.`,
          { toolId: tool.id, confirmationId: confirmation.id },
        );
      }
      // A confirmation authorizes exactly one tool with exactly one input.
      if (confirmation.toolId !== tool.id) {
        throw new ToolPermissionError(`Confirmation does not belong to tool "${tool.id}".`, {
          toolId: tool.id,
          confirmationId: confirmation.id,
        });
      }
      if (confirmation.inputDigest !== digestToolInput(invocation.input)) {
        throw new ToolPermissionError(
          `The confirmed input differs from the requested input for tool "${tool.id}" - a new confirmation is required.`,
          { toolId: tool.id, confirmationId: confirmation.id },
        );
      }
      // Single-use: consume the approval so it can never be replayed.
      try {
        this.confirmations.consume(confirmation.id);
      } catch (error) {
        throw new ToolPermissionError(
          `Confirmation for tool "${tool.id}" cannot be used: ${(error as Error).message}`,
          { toolId: tool.id, confirmationId: confirmation.id },
        );
      }
    }

    // 7. Execute.
    let output: Record<string, unknown>;
    if (tool.connector !== undefined) {
      // Connector-backed tool. When a connector execution layer is wired
      // (Step 10: GitHub Connector), execution flows through it - the full
      // gate above (existence, availability, input, tool permissions,
      // connector authorization, confirmation) has already passed, and the
      // connector layer re-checks its own scope and permissions.
      if (this.host.executeConnectorOperation === undefined) {
        // Step 5 boundary: no execution layer is wired. The failure is the
        // explicit stub that marks external execution as not enabled.
        throw new ToolExecutionError(
          tool.id,
          'execution of connector-backed tools is not enabled yet (connector operation execution arrives with the connector execution layer)',
          {
            details: {
              connectorId: tool.connector.connectorId,
              operationId: tool.connector.operationId,
            },
          },
        );
      }
      this.audit('tool_execution_started', tool.id, `Execution of tool "${tool.id}" started`, {
        invocationId: invocation.id,
      });
      try {
        output = await this.host.executeConnectorOperation(tool, invocation.input);
      } catch (error) {
        if (isToolError(error)) throw error;
        throw new ToolExecutionError(tool.id, (error as Error).message ?? 'operation failed', {
          cause: error,
        });
      }
    } else {
      const implementation = this.implementations.get(tool.id);
      if (implementation === undefined) {
        throw new ToolExecutionError(
          tool.id,
          'no implementation is registered for this local tool',
        );
      }

      this.audit('tool_execution_started', tool.id, `Execution of tool "${tool.id}" started`, {
        invocationId: invocation.id,
      });

      try {
        output = await implementation.handler(invocation.input, { invocation });
      } catch (error) {
        if (isToolError(error)) throw error;
        throw new ToolExecutionError(tool.id, (error as Error).message ?? 'handler failed', {
          cause: error,
        });
      }
    }

    // 8. Validate + normalize the output before it can reach the AI.
    const outputProblems = validateToolObject(tool.outputSchema, output);
    if (outputProblems.length > 0) {
      throw new ToolOutputValidationError(tool.id, outputProblems);
    }

    return { kind: 'success', output };
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
