/**
 * Agent state and the controlled state machine. Invalid transitions (for
 * example completed → executing) are rejected with typed errors; terminal
 * statuses never transition again - a cancelled run cannot resume.
 */

export const AGENT_STATUSES = [
  'idle',
  'planning',
  'waiting_for_tool',
  'waiting_for_confirmation',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'limit_reached',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);
}

/** Terminal statuses: once reached, the run never transitions again. */
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'limit_reached',
];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

/**
 * The controlled transition table. Anything not listed is rejected -
 * notably every transition OUT of a terminal status.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  idle: ['planning', 'cancelled', 'limit_reached'],
  planning: [
    'planning', // iterations continue in planning
    'waiting_for_tool',
    'waiting_for_confirmation',
    'executing',
    'completed',
    'failed',
    'limit_reached',
    'cancelled',
  ],
  waiting_for_tool: ['executing', 'failed', 'limit_reached', 'cancelled'],
  waiting_for_confirmation: ['executing', 'planning', 'failed', 'limit_reached', 'cancelled'],
  executing: ['planning', 'waiting_for_confirmation', 'failed', 'limit_reached', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  limit_reached: [],
};

export function canTransitionAgentStatus(from: AgentStatus, to: AgentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** A pending confirmation tied to one exact tool invocation request. */
export interface PendingToolConfirmation {
  /** The Step 5 confirmation id. */
  readonly confirmationId: string;
  /** The tool that was requested. */
  readonly toolId: string;
  /** The invocation that awaits a decision. */
  readonly invocationId: string;
  /**
   * The EXACT input that was requested - kept so the resume after approval
   * submits identical input (Step 5 confirmations are input-bound). The
   * agent may never swap it. Not a secret: requests cannot carry credentials.
   */
  readonly input: Readonly<Record<string, unknown>>;
}

/** Safe, normalized error info on the agent state (no chain-of-thought). */
export interface AgentStateError {
  readonly code: string;
  readonly message: string;
}

/**
 * The controlled execution state of one agent run. Deliberately excludes:
 * raw secrets (none may enter), hidden chain-of-thought (never stored),
 * connector credentials (the agent never sees them).
 */
export interface AgentState {
  /** Agent implementation id. */
  readonly agentId: string;
  /** Unique run id (UUID v4). */
  readonly runId: string;
  /** Current status. */
  status: AgentStatus;
  /** The user task (untrusted user input, never a secret). */
  readonly task: string;
  /** How many loop iterations (decisions) have run. */
  iteration: number;
  /** How many tool invocations have been dispatched this run. */
  toolCallCount: number;
  /** Consecutive failures (malformed decisions + failed/denied tool results). */
  consecutiveFailures: number;
  /** ISO-8601 creation time. */
  readonly createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
  /** Normalized tool invocation history (safe metadata only). */
  readonly toolInvocations: readonly AgentToolInvocationEntry[];
  /** Confirmation awaiting a human decision, if any. */
  pendingConfirmation?: PendingToolConfirmation;
  /** Final output once completed. */
  finalResult?: string;
  /** Error information once failed. */
  error?: AgentStateError;
  /** Why a limit was reached, if it was. */
  limitReason?: string;
}

export interface AgentToolInvocationEntry {
  /** Tool invocation id (from the Tool System). */
  readonly invocationId: string;
  readonly toolId: string;
  /** success | failure | denied (awaiting_confirmation pauses instead of entering history). */
  readonly status: 'success' | 'failure' | 'denied';
  /** Normalized result data (only on success). */
  readonly output?: Readonly<Record<string, unknown>>;
  /** Typed, secret-free error info (only on failure/denied). */
  readonly error?: AgentStateError;
  /** ISO-8601 timestamps. */
  readonly requestedAt: string;
  readonly completedAt: string;
}

export interface CreateAgentStateInput {
  readonly agentId: string;
  readonly runId: string;
  readonly task: string;
  readonly createdAt: string;
}

export function createAgentState(input: CreateAgentStateInput): AgentState {
  return {
    agentId: input.agentId,
    runId: input.runId,
    status: 'idle',
    task: input.task,
    iteration: 0,
    toolCallCount: 0,
    consecutiveFailures: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    toolInvocations: [],
  };
}

/**
 * The controlled state-transition mechanism the AgentManager hands to an
 * agent for one run. All mutations flow through these methods; invalid
 * transitions throw before anything is recorded.
 */
export interface AgentStateController {
  /** Current state snapshot (safe copy). */
  getState(): AgentState;
  /** Validated status transition. Throws on invalid transitions. */
  transitionTo(status: AgentStatus): void;
  /** Records one completed (non-confirmation) tool invocation. */
  recordToolInvocation(entry: AgentToolInvocationEntry): void;
  /** Sets the pending confirmation (only valid while waiting). */
  setPendingConfirmation(pending: PendingToolConfirmation): void;
  /** Clears the pending confirmation. */
  clearPendingConfirmation(): void;
  /** Sets the final result and terminates the run as completed. */
  complete(finalResult: string): void;
  /** Terminates the run as failed with a safe error. */
  fail(error: AgentStateError): void;
  /** Terminates the run as cancelled. */
  cancel(): void;
  /** Terminates the run as limit_reached with a safe reason. */
  reachLimit(reason: string): void;
  /** Increments the iteration counter. */
  incrementIteration(): void;
  /** Increments the dispatched-tool-call counter. */
  incrementToolCallCount(): void;
  /** Records one failure (malformed decision or failed/denied tool result). */
  recordFailure(): void;
  /** Resets the consecutive-failure streak after progress. */
  resetFailureStreak(): void;
}
