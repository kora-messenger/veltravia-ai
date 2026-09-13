import { randomUUID } from 'node:crypto';

import type { ToolManager } from '@veltravia/tool-core';

import type { AgentAuditEvent, AgentAuditEventType, AgentAuditSink } from '../audit/index.js';
import { createAgentAuditEvent } from '../audit/index.js';
import type { HumanConfirmationDecision } from '../confirmation/index.js';
import { planConfirmationResume, type ConfirmationResumePlan } from '../confirmation/index.js';
import { asAgentCancellation, CancellationController } from '../cancellation/index.js';
import {
  AgentNotAllowedError,
  AgentRunNotFoundError,
  AgentRunTerminalError,
} from '../errors/index.js';
import { normalizeToolResult } from '../invocation/index.js';
import { resolveAgentExecutionLimits, type AgentExecutionLimits } from '../limits/index.js';
import { recordToolOutcome } from '../agent.js';
import type {
  Agent,
  AgentRequest,
  AgentResponse,
  AgentRunContext,
  AgentRunOutcome,
} from '../agent.js';
import { validateAgentRequest } from '../agent.js';
import { AgentRegistry } from '../registry/index.js';
import {
  canTransitionAgentStatus,
  createAgentState,
  isTerminalAgentStatus,
  type AgentState,
  type AgentStateController,
  type AgentStateError,
  type AgentToolInvocationEntry,
  type PendingToolConfirmation,
} from '../state/index.js';

/**
 * The manager's state machine implementation: every mutation flows through
 * validated transitions; invalid transitions throw before anything is
 * recorded.
 */
class ManagedAgentState implements AgentStateController {
  constructor(
    private readonly state: AgentState,
    private readonly now: () => Date,
  ) {}

  getState(): AgentState {
    return {
      ...this.state,
      toolInvocations: [...this.state.toolInvocations],
      ...(this.state.pendingConfirmation !== undefined
        ? { pendingConfirmation: this.state.pendingConfirmation }
        : {}),
    } as AgentState;
  }

  transitionTo(status: AgentState['status']): void {
    if (!canTransitionAgentStatus(this.state.status, status)) {
      throw new Error(`Agent transition ${this.state.status} → ${status} is not allowed.`);
    }
    this.state.status = status;
    this.state.updatedAt = this.now().toISOString();
  }

  recordToolInvocation(entry: AgentToolInvocationEntry): void {
    (this.state.toolInvocations as AgentToolInvocationEntry[]).push(entry);
    this.state.updatedAt = this.now().toISOString();
  }

  setPendingConfirmation(pending: PendingToolConfirmation): void {
    this.state.pendingConfirmation = pending;
    this.state.updatedAt = this.now().toISOString();
  }

  clearPendingConfirmation(): void {
    delete this.state.pendingConfirmation;
    this.state.updatedAt = this.now().toISOString();
  }

  complete(finalResult: string): void {
    this.state.finalResult = finalResult;
    this.transitionTo('completed');
  }

  fail(error: AgentStateError): void {
    this.state.error = error;
    this.transitionTo('failed');
  }

  cancel(): void {
    this.transitionTo('cancelled');
  }

  reachLimit(reason: string): void {
    this.state.limitReason = reason;
    this.transitionTo('limit_reached');
  }

  incrementIteration(): void {
    this.state.iteration += 1;
    this.state.updatedAt = this.now().toISOString();
  }

  incrementToolCallCount(): void {
    this.state.toolCallCount += 1;
    this.state.updatedAt = this.now().toISOString();
  }

  recordFailure(): void {
    this.state.consecutiveFailures += 1;
    this.state.updatedAt = this.now().toISOString();
  }

  resetFailureStreak(): void {
    this.state.consecutiveFailures = 0;
    this.state.updatedAt = this.now().toISOString();
  }
}

/** Everything the manager tracks for one run. */
interface ManagedRun {
  readonly runId: string;
  readonly agentId: string;
  readonly request: AgentRequest;
  readonly controller: ManagedAgentState;
  readonly limits: AgentExecutionLimits;
  readonly cancellation: CancellationController;
  readonly startedAt: Date;
  /** True while an execute() pass is in flight. */
  executing: boolean;
}

export interface AgentManagerOptions {
  readonly registry?: AgentRegistry;
  readonly now?: () => Date;
  readonly onAudit?: AgentAuditSink;
  /** The Tool System every run routes through (used to resolve confirmations). */
  readonly tools: ToolManager;
}

/**
 * Controlled management of agent runs: create, inspect, continue, decide
 * confirmations, cancel, list. No background workers, no persistent job
 * queues - a run executes within the creating call (bounded by hard
 * limits) and pauses only on awaiting_confirmation.
 */
export class AgentManager {
  private readonly registry: AgentRegistry;
  private readonly now: () => Date;
  private readonly onAudit?: AgentAuditSink;
  private readonly tools: ToolManager;
  private readonly runs = new Map<string, ManagedRun>();

  constructor(options: AgentManagerOptions) {
    this.registry = options.registry ?? new AgentRegistry();
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
    this.tools = options.tools;
  }

  // ---- registry ----------------------------------------------------------

  register(agent: Agent): void {
    this.registry.register(agent);
  }

  unregister(agentId: string): void {
    this.registry.unregister(agentId);
  }

  listAgents(): readonly Agent[] {
    return this.registry.list();
  }

  // ---- runs ----------------------------------------------------------------

  /** Creates and executes a run (bounded); returns the safe response. */
  async createRun(agentId: string, request: AgentRequest): Promise<AgentResponse> {
    const agent = this.registry.get(agentId);
    validateAgentRequest(request);
    const limits = resolveAgentExecutionLimits(request.limits);
    const runId = randomUUID();
    const createdAt = this.now().toISOString();
    const state = createAgentState({
      agentId,
      runId,
      task: request.task,
      createdAt,
    });
    const controller = new ManagedAgentState(state, this.now);
    const cancellation = new CancellationController();
    const run: ManagedRun = {
      runId,
      agentId,
      request,
      controller,
      limits,
      cancellation,
      startedAt: new Date(createdAt),
      executing: false,
    };
    this.runs.set(runId, run);
    this.audit('agent_run_created', `Run created for agent "${agentId}"`, {
      runId,
      agentId,
      limits: limits as unknown as Record<string, number>,
    });
    return this.executeRun(run, agent);
  }

  /** Safe state snapshot for a run. Never exposes hidden reasoning (none is stored). */
  getRun(runId: string): AgentResponse {
    return this.toResponse(this.run(runId));
  }

  /** Lists runs that have not reached a terminal status. */
  listActiveRuns(): readonly AgentResponse[] {
    return [...this.runs.values()]
      .filter((run) => !isTerminalAgentStatus(run.controller.getState().status))
      .map((run) => this.toResponse(run));
  }

  /**
   * Cancels a run: stops the loop at its next checkpoint, prevents further
   * tool requests, marks the run cancelled, and audits the event. A
   * cancelled run never resumes automatically.
   */
  cancelRun(runId: string): AgentResponse {
    const run = this.run(runId);
    const snapshot = run.controller.getState();
    if (isTerminalAgentStatus(snapshot.status)) {
      throw new AgentRunTerminalError(runId, snapshot.status, 'cancel it again');
    }
    if (run.executing) {
      // The loop will observe the flag at its next checkpoint and cancel itself.
      run.cancellation.request();
    } else {
      // Paused run (awaiting confirmation): cancel directly.
      run.controller.cancel();
      this.audit('agent_cancelled', `Run "${runId}" was cancelled`, { runId });
    }
    return this.toResponse(run);
  }

  /**
   * Submits the human decision for a run's pending confirmation. The
   * decision flows through the Step 5 confirmation mechanism
   * (ToolManager.confirm) - the agent never approves itself. After the
   * decision, the run resumes exactly as planned: an approval executes the
   * SAME invocation with the SAME input; a rejection continues the loop
   * with a denial.
   */
  async submitConfirmationResult(
    runId: string,
    decision: HumanConfirmationDecision,
  ): Promise<AgentResponse> {
    const run = this.run(runId);
    const snapshot = run.controller.getState();
    if (isTerminalAgentStatus(snapshot.status)) {
      throw new AgentRunTerminalError(runId, snapshot.status, 'submit a confirmation result');
    }
    if (
      snapshot.status !== 'waiting_for_confirmation' ||
      snapshot.pendingConfirmation === undefined
    ) {
      throw new AgentNotAllowedError(
        `Run "${runId}" is not awaiting a confirmation (status: ${snapshot.status}).`,
      );
    }
    const pending = snapshot.pendingConfirmation;
    if (run.cancellation.isRequested()) {
      throw new AgentNotAllowedError(`Run "${runId}" is being cancelled.`);
    }
    // The Step 5 confirmation mechanism is the authority for the decision.
    const toolDecision = decision === 'approve' ? ('approved' as const) : ('rejected' as const);
    const confirmation = this.tools.confirm(pending.confirmationId, toolDecision);
    const agent = this.registry.get(run.agentId);
    return this.resumeAfterConfirmation(
      run,
      agent,
      planConfirmationResume(pending, confirmation.state as 'approved' | 'rejected'),
    );
  }

  /**
   * Submits a continuation for a paused run whose confirmation has already
   * been decided elsewhere. Undecided confirmations still require the
   * confirmation endpoint. Never resumes a cancelled or terminal run.
   */
  async submitContinuation(runId: string): Promise<AgentResponse> {
    const run = this.run(runId);
    const snapshot = run.controller.getState();
    if (isTerminalAgentStatus(snapshot.status)) {
      throw new AgentRunTerminalError(runId, snapshot.status, 'continue it');
    }
    if (
      snapshot.status !== 'waiting_for_confirmation' ||
      snapshot.pendingConfirmation === undefined
    ) {
      throw new AgentNotAllowedError(
        `Run "${runId}" is not pausable for continuation (status: ${snapshot.status}).`,
      );
    }
    const pending = snapshot.pendingConfirmation;
    const confirmation = this.tools.confirmations.get(pending.confirmationId);
    if (
      confirmation.state !== 'approved' &&
      confirmation.state !== 'rejected' &&
      confirmation.state !== 'expired'
    ) {
      throw new AgentNotAllowedError(
        `The confirmation for run "${runId}" has not been decided yet - use the confirmation endpoint.`,
      );
    }
    const agent = this.registry.get(run.agentId);
    return this.resumeAfterConfirmation(
      run,
      agent,
      planConfirmationResume(pending, confirmation.state),
    );
  }

  // ---- internals --------------------------------------------------------------

  private run(runId: string): ManagedRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new AgentRunNotFoundError(runId);
    }
    return run;
  }

  private async executeRun(run: ManagedRun, agent: Agent): Promise<AgentResponse> {
    const context: AgentRunContext = {
      runId: run.runId,
      state: run.controller,
      limits: run.limits,
      cancellation: asAgentCancellation(run.cancellation),
      audit: (type: AgentAuditEventType, summary: string, metadata?: Record<string, unknown>) => {
        this.audit(type, summary, { runId: run.runId, agentId: run.agentId, ...metadata });
      },
      now: this.now,
    };
    run.executing = true;
    try {
      const outcome = await agent.execute(run.request, context);
      return this.finalize(run, outcome);
    } finally {
      run.executing = false;
    }
  }

  /** Resumes a paused run after a decided confirmation, then runs to the next pause/terminal. */
  private async resumeAfterConfirmation(
    run: ManagedRun,
    agent: Agent,
    plan: ConfirmationResumePlan,
  ): Promise<AgentResponse> {
    if (plan.kind === 'undecided') {
      throw new AgentNotAllowedError(
        `The confirmation for run "${run.runId}" has not been decided yet - use the confirmation endpoint.`,
      );
    }
    const pending = run.controller.getState().pendingConfirmation as PendingToolConfirmation;
    run.controller.transitionTo('executing');
    if (plan.kind === 'execute') {
      // Resume the SAME invocation with the SAME input: Step 5's
      // input-bound, single-use confirmation remains authoritative.
      const result = await this.tools.invoke(
        pending.toolId,
        { ...pending.input },
        {
          requester: 'agent',
          correlationId: run.runId,
          confirmationId: pending.confirmationId,
        },
      );
      const agentResult = normalizeToolResult(result);
      this.audit(
        'agent_tool_result_received',
        `Tool result for "${pending.toolId}": ${agentResult.status}`,
        {
          runId: run.runId,
          toolId: pending.toolId,
          resultStatus: agentResult.status,
        },
      );
      run.controller.clearPendingConfirmation();
      if (agentResult.status === 'awaiting_confirmation') {
        // Should be impossible (the approval was consumed); fail safe.
        run.controller.fail({
          code: 'AGENT_MODEL_ERROR',
          message: 'confirmation could not be consumed',
        });
        return this.toResponse(run);
      }
      recordToolOutcome(contextFrom(run), agentResult);
    } else {
      // Rejection/expiry: record a denial and let the agent re-reason.
      const nowIso = this.now().toISOString();
      run.controller.clearPendingConfirmation();
      recordToolOutcome(contextFrom(run), {
        invocationId: pending.invocationId,
        toolId: pending.toolId,
        status: 'denied',
        error: { code: 'TOOL_PERMISSION', message: plan.message },
        requestedAt: nowIso,
        completedAt: nowIso,
      });
    }
    run.controller.transitionTo('planning');
    return this.executeRun(run, agent);
  }

  private finalize(run: ManagedRun, outcome: AgentRunOutcome): AgentResponse {
    switch (outcome.status) {
      case 'completed':
        this.audit('agent_completed', `Run "${run.runId}" completed`, { runId: run.runId });
        break;
      case 'failed':
        this.audit('agent_failed', `Run "${run.runId}" failed: ${outcome.error.message}`, {
          runId: run.runId,
          errorCode: outcome.error.code,
        });
        break;
      case 'cancelled':
        this.audit('agent_cancelled', `Run "${run.runId}" was cancelled`, { runId: run.runId });
        break;
      case 'limit_reached':
        this.audit('agent_limit_reached', `Run "${run.runId}" reached a limit: ${outcome.reason}`, {
          runId: run.runId,
          reason: outcome.reason,
        });
        break;
      default:
        break; // awaiting_confirmation: already audited by the agent.
    }
    return this.toResponse(run);
  }

  /** Maps run state to the safe response (never exposes hidden reasoning - none is stored). */
  private toResponse(run: ManagedRun): AgentResponse {
    const snapshot = run.controller.getState();
    return {
      runId: run.runId,
      agentId: run.agentId,
      status: toResponseStatus(snapshot.status),
      iteration: snapshot.iteration,
      toolCallCount: snapshot.toolCallCount,
      toolResults: snapshot.toolInvocations.map((entry) => ({
        invocationId: entry.invocationId,
        toolId: entry.toolId,
        status: entry.status,
        ...(entry.output !== undefined ? { output: entry.output as Record<string, unknown> } : {}),
        ...(entry.error !== undefined ? { error: { ...entry.error } } : {}),
        completedAt: entry.completedAt,
      })),
      ...(snapshot.pendingConfirmation !== undefined
        ? {
            pendingConfirmation: {
              confirmationId: snapshot.pendingConfirmation.confirmationId,
              toolId: snapshot.pendingConfirmation.toolId,
              invocationId: snapshot.pendingConfirmation.invocationId,
            },
          }
        : {}),
      ...(snapshot.finalResult !== undefined ? { finalOutput: snapshot.finalResult } : {}),
      ...(snapshot.error !== undefined ? { error: { ...snapshot.error } } : {}),
      ...(snapshot.limitReason !== undefined ? { limitReason: snapshot.limitReason } : {}),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  }

  private audit(
    type: AgentAuditEventType,
    summary: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.onAudit === undefined) return;
    const event: AgentAuditEvent = createAgentAuditEvent({
      type,
      ...(metadata !== undefined && typeof metadata.agentId === 'string'
        ? { agentId: metadata.agentId as string }
        : { agentId: 'system' }),
      ...(metadata !== undefined && typeof metadata.runId === 'string'
        ? { runId: metadata.runId as string }
        : { runId: 'none' }),
      summary,
      ...(metadata !== undefined ? { metadata } : {}),
      timestamp: this.now().toISOString(),
    });
    this.onAudit(event);
  }
}

/** AgentStatus to safe response status. In-flight statuses surface as awaiting_tool. */
function toResponseStatus(status: AgentState['status']): AgentResponse['status'] {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'limit_reached':
      return status;
    case 'waiting_for_confirmation':
      return 'awaiting_confirmation';
    default:
      // idle | planning | waiting_for_tool | executing - only observable mid-run.
      return 'awaiting_tool';
  }
}

/** Builds the run context the resume path needs for result bookkeeping. */
function contextFrom(run: ManagedRun): AgentRunContext {
  return {
    runId: run.runId,
    state: run.controller,
    limits: run.limits,
    cancellation: asAgentCancellation(run.cancellation),
    audit: () => undefined,
    now: () => new Date(),
  };
}
