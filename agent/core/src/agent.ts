import type { AICore, AIRequest, AICapability } from '@veltravia/ai-core';
import { isAIError } from '@veltravia/ai-core';
import type { ToolManager } from '@veltravia/tool-core';
import { validateToolObject } from '@veltravia/tool-core';

import type { AgentAuditEventType } from './audit/index.js';
import { buildAgentContext, toAgentToolMetadata, type AgentContext } from './context/index.js';
import {
  AgentModelError,
  InvalidAgentDecisionError,
  InvalidAgentRequestError,
  scrubAgentSecrets,
} from './errors/index.js';
import {
  parseAgentDecision,
  type AgentDecision,
  type ParsedAgentDecision,
} from './decisions/index.js';
import { buildAgentInstructions, buildSystemInstructions } from './instructions/index.js';
import type { AgentExecutionLimits, AgentExecutionLimitsInput } from './limits/index.js';
import { normalizeToolResult, type AgentToolResultStatus } from './invocation/index.js';
import type { AgentCancellation } from './cancellation/index.js';
import {
  isTerminalAgentStatus,
  type AgentState,
  type AgentStateController,
} from './state/index.js';

/**
 * The Agent abstraction: receives a task, maintains controlled state,
 * reasons via a DecisionSource, requests tools through the Tool System,
 * processes normalized results, and completes/fails/stops within hard
 * limits. No arbitrary internal model behavior is exposed.
 */
export interface Agent {
  /** Unique agent id (lowercase, dot/dash-separated). */
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /**
   * Controlled execution of one run. Returns when the run reaches a
   * terminal status or pauses awaiting a human confirmation. The agent
   * NEVER runs unbounded: the context carries validated limits.
   */
  execute(request: AgentRequest, context: AgentRunContext): Promise<AgentRunOutcome>;
}

/** What one run may ask of the model. No secrets, no raw credentials. */
export interface AgentRequest {
  /** The task/message (untrusted user input). 1..4000 chars. */
  readonly task: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  /** The workspace the run is associated with (validated by the API layer). */
  readonly workspaceId?: string;
  readonly userId?: string;
  /** Restricts the tool ids the agent may see and request (Tool System still decides execution). */
  readonly toolFilter?: readonly string[];
  /** Caller-provided limits; merged with defaults and hard-capped by the manager. */
  readonly limits?: AgentExecutionLimitsInput;
  /** Plain, size-capped metadata. Secret-shaped values are rejected. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Server-derived project/workspace context (safe metadata only, never
   * file contents). Enters the decision context as UNTRUSTED PROJECT DATA -
   * project text never gains instruction authority. Size-capped and
   * secret-scanned like metadata.
   */
  readonly projectContext?: Readonly<Record<string, unknown>>;
}

/** Safe agent response: normalized information only, never chain-of-thought. */
export type AgentResponseStatus =
  | 'completed'
  | 'awaiting_tool'
  | 'awaiting_confirmation'
  | 'failed'
  | 'cancelled'
  | 'limit_reached';

export interface AgentResponse {
  readonly runId: string;
  readonly agentId: string;
  readonly status: AgentResponseStatus;
  readonly iteration: number;
  readonly toolCallCount: number;
  /** Normalized tool results this run recorded (safe data, no secrets). */
  readonly toolResults: readonly {
    readonly invocationId: string;
    readonly toolId: string;
    readonly status: string;
    readonly output?: Record<string, unknown>;
    readonly error?: { readonly code: string; readonly message: string };
    readonly requestedAt: string;
    readonly completedAt: string;
  }[];
  readonly pendingConfirmation?: {
    readonly confirmationId: string;
    readonly toolId: string;
    readonly invocationId: string;
    /**
     * Safe confirmation metadata from the Tool System (risk level,
     * lifecycle state, request/expiry timestamps - never the input, never
     * secrets). Present when the Tool System still holds the request.
     */
    readonly riskLevel?: string;
    readonly state?: 'required' | 'approved' | 'rejected' | 'expired';
    readonly requestedAt?: string;
    readonly expiresAt?: string;
  };
  readonly finalOutput?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly limitReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The outcome an Agent returns to the manager: terminal, or paused on a confirmation. */
export type AgentRunOutcome =
  | { readonly status: 'completed'; readonly finalOutput: string }
  | {
      readonly status: 'failed';
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'limit_reached'; readonly reason: string }
  | {
      readonly status: 'awaiting_confirmation';
      readonly confirmationId: string;
      readonly toolId: string;
      readonly invocationId: string;
    };

/** What the manager hands to an agent for one run. */
export interface AgentRunContext {
  readonly runId: string;
  readonly state: AgentStateController;
  readonly limits: AgentExecutionLimits;
  readonly cancellation: AgentCancellation;
  /** Emits a validated, scrubbed agent audit event. */
  audit(type: AgentAuditEventType, summary: string, metadata?: Record<string, unknown>): void;
  readonly now: () => Date;
}

/** Maximum serialized size of the server-derived project context. */
export const AGENT_PROJECT_CONTEXT_MAX_SERIALIZED = 8000;

/** Validates an AgentRequest. Rejects empty tasks, oversized fields, and secret-shaped metadata. */
export function validateAgentRequest(request: AgentRequest): void {
  const reasons: string[] = [];
  if (typeof request.task !== 'string' || request.task.trim().length === 0) {
    reasons.push('task must be a non-empty string');
  } else if (request.task.length > 4000) {
    reasons.push('task exceeds the maximum length of 4000 characters');
  }
  for (const [field, value] of [
    ['sessionId', request.sessionId],
    ['projectId', request.projectId],
    ['workspaceId', request.workspaceId],
    ['userId', request.userId],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 128)) {
      reasons.push(`${field} must be a string of at most 128 characters`);
    }
  }
  if (request.toolFilter !== undefined) {
    if (!Array.isArray(request.toolFilter)) {
      reasons.push('toolFilter must be an array of tool ids');
    } else if (request.toolFilter.some((id) => typeof id !== 'string' || id.length === 0)) {
      reasons.push('toolFilter entries must be non-empty strings');
    }
  }
  if (request.metadata !== undefined) {
    const serialized = JSON.stringify(request.metadata);
    if (Object.keys(request.metadata).length > 32) {
      reasons.push('metadata must have at most 32 keys');
    } else if (serialized !== undefined && serialized.length > 4000) {
      reasons.push('metadata exceeds the maximum serialized size');
    } else if (serialized !== undefined && scrubAgentSecrets(serialized) !== serialized) {
      reasons.push('metadata must not contain secret-shaped values');
    }
  }
  if (request.projectContext !== undefined) {
    const serializedContext = JSON.stringify(request.projectContext);
    if (
      request.projectContext === null ||
      Array.isArray(request.projectContext) ||
      typeof request.projectContext !== 'object'
    ) {
      reasons.push('projectContext must be a plain object');
    } else if (
      serializedContext !== undefined &&
      serializedContext.length > AGENT_PROJECT_CONTEXT_MAX_SERIALIZED
    ) {
      reasons.push('projectContext exceeds the maximum serialized size');
    } else if (
      serializedContext !== undefined &&
      scrubAgentSecrets(serializedContext) !== serializedContext
    ) {
      reasons.push('projectContext must not contain secret-shaped values');
    }
  }
  if (reasons.length > 0) {
    throw new InvalidAgentRequestError(reasons);
  }
}

/**
 * A DecisionSource produces the next agent decision for a context. The
 * default implementation bridges AI Core (provider-neutral); tests and
 * offline CI use deterministic scripted sources.
 */
export interface DecisionSource {
  decide(context: AgentContext): Promise<AgentDecision>;
}

export interface ModelDecisionSourceOptions {
  /** Explicit model id; otherwise routed by capability. */
  readonly model?: string;
  readonly capabilities?: readonly AICapability[];
  readonly temperature?: number;
}

/**
 * The AI Core-backed decision source: Agent → AI Core → AI Router → AI
 * Provider. It never imports a vendor SDK, and it never trusts raw model
 * output: the response is parsed and structurally validated before the
 * loop sees it.
 */
export class ModelDecisionSource implements DecisionSource {
  private readonly core: AICore;
  private readonly options: ModelDecisionSourceOptions;

  constructor(core: AICore, options: ModelDecisionSourceOptions = {}) {
    this.core = core;
    this.options = options;
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    const instructions = buildAgentInstructions(context);
    const request: AIRequest = {
      messages: instructions.messages,
      system: instructions.system,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      capabilities: this.options.capabilities ?? ['text-generation'],
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...((context.limits.maxOutputTokens ?? 0) > 0
        ? { maxOutputTokens: context.limits.maxOutputTokens }
        : {}),
    };
    let content: string;
    try {
      const response = await this.core.generate(request);
      content = response.content;
    } catch (error) {
      throw new AgentModelError(
        `The decision model failed: ${isAIError(error) ? error.message : (error as Error).message}`,
        { cause: error },
      );
    }
    const parsed = parseAgentDecision(extractDecisionJson(content));
    return parsed.decision;
  }
}

/** Extracts the decision JSON from raw model text (strips code fences; never executes text). */
export function extractDecisionJson(content: string): unknown {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AgentModelError('The decision model returned empty output.');
  }
  const unfenced = content.replace(/```(?:json)?/g, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AgentModelError('The decision model output contains no decision object.');
  }
  const candidate = unfenced.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new AgentModelError('The decision model output is not valid JSON.');
  }
}

export interface DefaultAgentOptions {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Where decisions come from (AI Core bridge, or a scripted test source). */
  readonly decisions: DecisionSource;
  /** The Tool System this agent routes every tool request through. */
  readonly tools: ToolManager;
}

/**
 * The default, provider-neutral agent: a controlled loop, NOT a coding
 * agent and NOT autonomous production automation. Every iteration:
 *
 *  1. check cancellation, duration, iteration, and tool-call limits
 *  2. build the trust-tagged context and ask the DecisionSource
 *  3. parse + structurally validate the decision (never raw model text)
 *  4. for tool requests: validate the tool id + input against the Tool
 *     System, then dispatch THROUGH the ToolManager (the authority)
 *  5. record the normalized result and continue, or pause on
 *     awaiting_confirmation, or terminate (completed/failed/limit_reached)
 *
 * The agent cannot: bypass the Tool System, call connectors directly,
 * execute code, approve its own confirmations, or change its limits.
 */
export class DefaultAgent implements Agent {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  private readonly decisions: DecisionSource;
  private readonly tools: ToolManager;

  constructor(options: DefaultAgentOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.description = options.description;
    this.decisions = options.decisions;
    this.tools = options.tools;
  }

  async execute(request: AgentRequest, context: AgentRunContext): Promise<AgentRunOutcome> {
    const startedAt = context.now();
    while (true) {
      // ---- limit + cancellation checkpoints (checked every iteration) ----
      if (context.cancellation.isRequested()) return this.cancelled(context);
      if (context.now().getTime() - startedAt.getTime() >= context.limits.maxDurationMs) {
        return this.limitReached(context, 'maximum execution duration reached');
      }
      const snapshot = context.state.getState();
      if (isTerminalAgentStatus(snapshot.status)) {
        // A resumed run that was terminal (e.g. cancelled during pause) must not continue.
        return this.resyncOutcome(snapshot);
      }
      if (snapshot.iteration >= context.limits.maxIterations) {
        return this.limitReached(context, 'maximum iterations reached');
      }
      if (snapshot.toolCallCount >= context.limits.maxToolCalls) {
        return this.limitReached(context, 'maximum tool calls reached');
      }

      // ---- one iteration ----
      context.state.incrementIteration();
      context.state.transitionTo('planning');
      const agentContext = this.buildContext(request, context);

      let parsed: ParsedAgentDecision;
      try {
        const decision = await this.decisions.decide(agentContext);
        parsed = parseAgentDecision(decision as unknown); // re-validate structure, ALWAYS
        if (parsed.decision.type === 'request_tool') {
          this.validateToolDecision(parsed.decision, request);
        }
      } catch (error) {
        // Malformed model output is never acted on: count the failure and retry within limits.
        context.state.recordFailure();
        const failures = context.state.getState().consecutiveFailures;
        if (failures >= context.limits.maxConsecutiveFailures) {
          return this.failed(
            context,
            error instanceof Error ? error : new AgentModelError('the decision source failed'),
          );
        }
        continue;
      }
      // NOTE: the failure streak resets only on real progress (a successful
      // tool result or a terminal answer) - a decision that parses but then
      // turns out to be non-actionable still counts as a failure.
      context.audit('agent_decision_created', `Decision: ${parsed.decision.type}`, {
        decisionType: parsed.decision.type,
        ...(parsed.decision.type === 'request_tool' ? { toolId: parsed.decision.toolId } : {}),
      });

      const decision = parsed.decision;
      switch (decision.type) {
        case 'answer': {
          context.state.resetFailureStreak();
          context.state.complete(decision.output);
          return { status: 'completed', finalOutput: decision.output };
        }
        case 'stop': {
          const output = decision.summary ?? 'The agent stopped without a final answer.';
          context.state.resetFailureStreak();
          context.state.complete(output);
          return { status: 'completed', finalOutput: output };
        }
        case 'fail': {
          context.state.fail({ code: 'AGENT_STOPPED', message: decision.message });
          return { status: 'failed', error: { code: 'AGENT_STOPPED', message: decision.message } };
        }
        case 'continue': {
          continue;
        }
        case 'request_confirmation': {
          const pending = context.state.getState().pendingConfirmation;
          if (pending === undefined) {
            // No pending confirmation exists - this decision is malformed.
            context.state.recordFailure();
            if (
              context.state.getState().consecutiveFailures >= context.limits.maxConsecutiveFailures
            ) {
              return this.failed(
                context,
                new InvalidAgentDecisionError([
                  'request_confirmation without a pending confirmation',
                ]),
              );
            }
            continue;
          }
          context.state.transitionTo('waiting_for_confirmation');
          context.audit(
            'agent_waiting_confirmation',
            `Run is waiting for human confirmation of tool "${pending.toolId}"`,
            { toolId: pending.toolId, confirmationId: pending.confirmationId },
          );
          return {
            status: 'awaiting_confirmation',
            confirmationId: pending.confirmationId,
            toolId: pending.toolId,
            invocationId: pending.invocationId,
          };
        }
        case 'request_tool': {
          if (context.cancellation.isRequested()) return this.cancelled(context);
          if (context.state.getState().toolCallCount >= context.limits.maxToolCalls) {
            return this.limitReached(context, 'maximum tool calls reached');
          }
          context.state.incrementToolCallCount();
          context.state.transitionTo('waiting_for_tool');
          context.audit('agent_tool_requested', `Tool requested: ${decision.toolId}`, {
            toolId: decision.toolId,
          });
          context.state.transitionTo('executing');
          // The Tool System is the authority: it re-validates input,
          // permissions, connector authorization, and confirmation.
          const result = await this.tools.invoke(decision.toolId, decision.input, {
            requester: 'agent',
            correlationId: context.runId,
          });
          const agentResult = normalizeToolResult(result);
          context.audit(
            'agent_tool_result_received',
            `Tool result for "${decision.toolId}": ${agentResult.status}`,
            { toolId: decision.toolId, resultStatus: agentResult.status },
          );
          if (agentResult.status === 'awaiting_confirmation') {
            context.state.setPendingConfirmation({
              confirmationId: agentResult.confirmationId as string,
              toolId: decision.toolId,
              invocationId: result.invocationId,
              input: decision.input,
            });
            context.state.transitionTo('waiting_for_confirmation');
            context.audit(
              'agent_waiting_confirmation',
              `Tool "${decision.toolId}" requires human confirmation`,
              { toolId: decision.toolId, confirmationId: agentResult.confirmationId },
            );
            return {
              status: 'awaiting_confirmation',
              confirmationId: agentResult.confirmationId as string,
              toolId: decision.toolId,
              invocationId: result.invocationId,
            };
          }
          recordToolOutcome(context, agentResult);
          const failures = context.state.getState().consecutiveFailures;
          if (failures >= context.limits.maxConsecutiveFailures) {
            const error = {
              code: 'AGENT_CONSECUTIVE_FAILURES',
              message: 'The run reached the maximum number of consecutive failures.',
            };
            context.state.fail(error);
            return { status: 'failed', error };
          }
          continue;
        }
      }
    }
  }

  /** Builds the bounded, trust-tagged decision context. */
  private buildContext(request: AgentRequest, context: AgentRunContext): AgentContext {
    const snapshot = context.state.getState();
    const tools = this.tools
      .list()
      .filter((tool) => request.toolFilter === undefined || request.toolFilter.includes(tool.id))
      .map((tool) => toAgentToolMetadata(tool, this.tools.getAvailability(tool.id)));
    return buildAgentContext({
      ...(request.projectContext !== undefined
        ? { projectContext: JSON.stringify(request.projectContext) }
        : {}),
      systemInstructions: buildSystemInstructions({
        availableToolCount: tools.length,
        remainingIterations: Math.max(0, context.limits.maxIterations - snapshot.iteration),
        limits: context.limits as unknown as Record<string, number>,
      }),
      task: snapshot.task,
      tools,
      toolResults: snapshot.toolInvocations.map((entry) => ({
        toolId: entry.toolId,
        resultText: JSON.stringify(
          entry.output !== undefined ? entry.output : { status: entry.status, error: entry.error },
        ),
      })),
      limits: context.limits as unknown as Record<string, number>,
      remainingIterations: Math.max(0, context.limits.maxIterations - snapshot.iteration),
      stateLine: `iteration ${snapshot.iteration}, tool calls ${snapshot.toolCallCount}, status ${snapshot.status}`,
    });
  }

  /**
   * Model-generated tool decisions are validated against the Tool System
   * BEFORE dispatch: the tool must exist (and be in the request's tool
   * filter), and the input must satisfy the tool's schema. The Tool System
   * still re-validates everything - this is defense in depth, never a bypass.
   */
  private validateToolDecision(
    decision: { readonly toolId: string; readonly input: Record<string, unknown> },
    request: AgentRequest,
  ): void {
    if (request.toolFilter !== undefined && !request.toolFilter.includes(decision.toolId)) {
      throw new InvalidAgentDecisionError([
        `tool "${decision.toolId}" is not in this run's tool filter`,
      ]);
    }
    let tool;
    try {
      tool = this.tools.getDefinition(decision.toolId);
    } catch {
      throw new InvalidAgentDecisionError([`unknown tool id "${decision.toolId}"`]);
    }
    const problems = validateToolObject(tool.inputSchema, decision.input);
    if (problems.length > 0) {
      throw new InvalidAgentDecisionError(problems);
    }
  }

  private cancelled(context: AgentRunContext): AgentRunOutcome {
    context.state.cancel();
    return { status: 'cancelled' };
  }

  private limitReached(context: AgentRunContext, reason: string): AgentRunOutcome {
    context.state.reachLimit(reason);
    return { status: 'limit_reached', reason };
  }

  private failed(context: AgentRunContext, error: Error): AgentRunOutcome {
    const code = 'AGENT_MODEL_ERROR';
    const message = error.message;
    context.state.fail({ code, message });
    return { status: 'failed', error: { code, message } };
  }

  /** Maps an already-terminal state (resumed run) back to an outcome. */
  private resyncOutcome(snapshot: AgentState): AgentRunOutcome {
    switch (snapshot.status) {
      case 'completed':
        return { status: 'completed', finalOutput: snapshot.finalResult ?? '' };
      case 'failed':
        return {
          status: 'failed',
          error: snapshot.error ?? { code: 'AGENT_MODEL_ERROR', message: 'the run failed' },
        };
      case 'cancelled':
        return { status: 'cancelled' };
      case 'limit_reached':
        return { status: 'limit_reached', reason: snapshot.limitReason ?? 'limit reached' };
      default:
        return { status: 'cancelled' };
    }
  }
}

/** Records a completed tool result into run state + failure-streak bookkeeping. */
export function recordToolOutcome(
  context: AgentRunContext,
  result: {
    invocationId: string;
    toolId: string;
    status: AgentToolResultStatus;
    output?: Record<string, unknown>;
    error?: { code: string; message: string };
    requestedAt: string;
    completedAt: string;
  },
): void {
  if (result.status === 'awaiting_confirmation') {
    throw new Error(
      'awaiting_confirmation results pause the run - they are never recorded as completed invocations.',
    );
  }
  context.state.recordToolInvocation({
    invocationId: result.invocationId,
    toolId: result.toolId,
    status: result.status,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    requestedAt: result.requestedAt,
    completedAt: result.completedAt,
  });
  if (result.status === 'success') {
    context.state.resetFailureStreak();
  } else {
    context.state.recordFailure();
  }
}
