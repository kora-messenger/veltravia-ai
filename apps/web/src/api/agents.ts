/**
 * Agent API surface + safe UI models (Steps 11C-2 + 11C-3).
 *
 * Raw backend agent responses are mapped into `AgentRunView` before
 * reaching the UI: unknown/invalid data becomes a typed error, and
 * internal counters are dropped rather than passed through. The final
 * answer is the ONLY model output surfaced to the conversation.
 *
 * Step 11C-3 additionally maps the run's tool activity (per-invocation
 * results) and pending-confirmation metadata into safe view models. Tool
 * output is UNTRUSTED DATA - it is kept as inert values and rendered as
 * text, never as instructions. Confirmation fields are metadata only
 * (risk level, lifecycle state, timestamps); the requested input is
 * never surfaced and can never be edited from the browser.
 */
import { apiRequest } from './client';

/**
 * The Agent API's actual response statuses. Terminal statuses are
 * `completed`, `failed`, `cancelled`, and `limit_reached`; `awaiting_tool`
 * is transient within an executing run and `awaiting_confirmation` means
 * the run is paused for a human decision.
 */
export type AgentRunStatus =
  | 'completed'
  | 'awaiting_tool'
  | 'awaiting_confirmation'
  | 'failed'
  | 'cancelled'
  | 'limit_reached';

export const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'limit_reached',
];

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Safe UI model for one registered agent (from GET /api/agents). */
export interface AgentSummaryView {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

/** The Tool System's reported outcome for one tool invocation. */
export type AgentToolStatus = 'success' | 'failure' | 'denied';

/**
 * Safe UI model for one recorded tool invocation. `output` is the Tool
 * System's normalized result - UNTRUSTED DATA, rendered as text only.
 */
export interface ToolResultView {
  readonly invocationId: string;
  readonly toolId: string;
  readonly status: AgentToolStatus;
  /** Normalized tool output (success only). Untrusted external data. */
  readonly output: Record<string, unknown> | null;
  /** Typed, secret-free error information (failure/denied only). */
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly requestedAt: string | null;
  readonly completedAt: string | null;
}

/** The lifecycle states the backend reports for a pending confirmation. */
export type ConfirmationStateView = 'required' | 'approved' | 'rejected' | 'expired';

/**
 * Safe UI model for a run's pending human confirmation. Metadata only:
 * what tool, how risky, and when the request expires. The requested
 * input, digests, and anything editable never reach the browser.
 */
export interface PendingConfirmationView {
  readonly confirmationId: string;
  readonly toolId: string;
  readonly invocationId: string;
  readonly riskLevel: string | null;
  readonly state: ConfirmationStateView | null;
  readonly requestedAt: string | null;
  readonly expiresAt: string | null;
}

/**
 * Safe UI model for one agent run. Only the fields the workspace renders:
 * identity, status, the final answer (assistant output), tool activity,
 * pending-confirmation metadata, a typed error, and the limit reason.
 * Internal counters are dropped.
 */
export interface AgentRunView {
  readonly runId: string;
  readonly agentId: string;
  readonly status: AgentRunStatus;
  /** The run's final answer. Present only when the backend reports completion. */
  readonly finalOutput: string | null;
  /** Recorded tool invocations, in the backend's authoritative order. */
  readonly toolResults: readonly ToolResultView[];
  /** The run's pending human confirmation, if it is paused on one. */
  readonly pendingConfirmation: PendingConfirmationView | null;
  /** Typed, secret-free failure information (failed runs only). */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** Why a limit-reached run stopped, if reported. */
  readonly limitReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const RUN_STATUSES: readonly AgentRunStatus[] = [
  'completed',
  'awaiting_tool',
  'awaiting_confirmation',
  'failed',
  'cancelled',
  'limit_reached',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const TOOL_STATUSES: readonly AgentToolStatus[] = ['success', 'failure', 'denied'];
const CONFIRMATION_STATES: readonly ConfirmationStateView[] = [
  'required',
  'approved',
  'rejected',
  'expired',
];

/** Maps one raw tool-result entry to a safe view. Malformed entries throw. */
function toToolResultView(raw: unknown, source: string): ToolResultView {
  if (!isRecord(raw)) {
    throw new Error(`Invalid tool result payload from ${source}`);
  }
  const invocationId = optionalString(raw.invocationId);
  const toolId = optionalString(raw.toolId);
  const status = raw.status;
  if (invocationId === null || toolId === null || typeof status !== 'string') {
    throw new Error(`Invalid tool result payload from ${source}`);
  }
  if (!TOOL_STATUSES.includes(status as AgentToolStatus)) {
    throw new Error(`Invalid tool result payload from ${source}`);
  }
  let output: Record<string, unknown> | null = null;
  if (raw.output !== undefined && raw.output !== null) {
    if (!isRecord(raw.output)) {
      throw new Error(`Invalid tool result payload from ${source}`);
    }
    output = raw.output;
  }
  let error: ToolResultView['error'] = null;
  if (raw.error !== undefined && raw.error !== null) {
    if (!isRecord(raw.error)) {
      throw new Error(`Invalid tool result payload from ${source}`);
    }
    const code = optionalString(raw.error.code);
    const message = optionalString(raw.error.message);
    if (code === null || message === null) {
      throw new Error(`Invalid tool result payload from ${source}`);
    }
    error = { code, message };
  }
  return {
    invocationId,
    toolId,
    status: status as AgentToolStatus,
    output,
    error,
    requestedAt: optionalString(raw.requestedAt),
    completedAt: optionalString(raw.completedAt),
  };
}

/** Maps the raw pending-confirmation metadata to a safe view. */
function toPendingConfirmationView(raw: unknown, source: string): PendingConfirmationView {
  if (!isRecord(raw)) {
    throw new Error(`Invalid pending confirmation payload from ${source}`);
  }
  const confirmationId = optionalString(raw.confirmationId);
  const toolId = optionalString(raw.toolId);
  const invocationId = optionalString(raw.invocationId);
  if (confirmationId === null || toolId === null || invocationId === null) {
    throw new Error(`Invalid pending confirmation payload from ${source}`);
  }
  const state = raw.state;
  return {
    confirmationId,
    toolId,
    invocationId,
    riskLevel: optionalString(raw.riskLevel),
    state:
      typeof state === 'string' && CONFIRMATION_STATES.includes(state as ConfirmationStateView)
        ? (state as ConfirmationStateView)
        : null,
    requestedAt: optionalString(raw.requestedAt),
    expiresAt: optionalString(raw.expiresAt),
  };
}

/** Maps one raw agent payload to a safe view model. Malformed payloads throw. */
function toAgentRunView(raw: unknown, source: string): AgentRunView {
  if (!isRecord(raw)) {
    throw new Error(`Invalid agent run payload from ${source}`);
  }
  const runId = optionalString(raw.runId);
  const agentId = optionalString(raw.agentId);
  const status = raw.status;
  if (runId === null || agentId === null || typeof status !== 'string') {
    throw new Error(`Invalid agent run payload from ${source}`);
  }
  if (!RUN_STATUSES.includes(status as AgentRunStatus)) {
    throw new Error(`Invalid agent run payload from ${source}`);
  }
  let error: AgentRunView['error'] = null;
  if (raw.error !== undefined && raw.error !== null) {
    if (!isRecord(raw.error)) {
      throw new Error(`Invalid agent run payload from ${source}`);
    }
    const code = optionalString(raw.error.code);
    const message = optionalString(raw.error.message);
    if (code === null || message === null) {
      throw new Error(`Invalid agent run payload from ${source}`);
    }
    error = { code, message };
  }
  let toolResults: readonly ToolResultView[] = [];
  if (raw.toolResults !== undefined) {
    if (!Array.isArray(raw.toolResults)) {
      throw new Error(`Invalid agent run payload from ${source}`);
    }
    toolResults = raw.toolResults.map((entry, index) =>
      toToolResultView(entry, `${source} (tool result ${index})`),
    );
  }
  let pendingConfirmation: PendingConfirmationView | null = null;
  if (raw.pendingConfirmation !== undefined && raw.pendingConfirmation !== null) {
    pendingConfirmation = toPendingConfirmationView(raw.pendingConfirmation, source);
  }
  return {
    runId,
    agentId,
    status: status as AgentRunStatus,
    finalOutput: optionalString(raw.finalOutput),
    toolResults,
    pendingConfirmation,
    error,
    limitReason: optionalString(raw.limitReason),
    createdAt: optionalString(raw.createdAt) ?? '',
    updatedAt: optionalString(raw.updatedAt) ?? '',
  };
}

/** Lists the agents the API offers (id, display name, description only). */
export async function listAgents(): Promise<readonly AgentSummaryView[]> {
  const raw = await apiRequest<{ agents?: unknown }>('/api/agents');
  if (!isRecord(raw) || !Array.isArray(raw.agents)) {
    throw new Error('Invalid agent list payload from /api/agents');
  }
  return raw.agents.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid agent list payload from /api/agents (entry ${index})`);
    }
    const id = optionalString(entry.id);
    if (id === null) {
      throw new Error(`Invalid agent list payload from /api/agents (entry ${index})`);
    }
    return {
      id,
      displayName: optionalString(entry.displayName) ?? id,
      description: optionalString(entry.description) ?? '',
    };
  });
}

/**
 * Creates and executes a real agent run. The backend executes the run
 * within this request (bounded by hard limits), so the response usually
 * already carries the terminal state; a paused run returns
 * `awaiting_confirmation`.
 */
export async function createAgentRun(request: {
  readonly agentId: string;
  readonly task: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
}): Promise<AgentRunView> {
  const raw = await apiRequest<unknown>('/api/agents/run', {
    method: 'POST',
    body: {
      agentId: request.agentId,
      task: request.task,
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      ...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
    },
  });
  return toAgentRunView(raw, 'POST /api/agents/run');
}

/** Retrieves the current safe state of one run. */
export async function getAgentRun(runId: string): Promise<AgentRunView> {
  const raw = await apiRequest<unknown>(`/api/agents/runs/${encodeURIComponent(runId)}`);
  return toAgentRunView(raw, 'GET /api/agents/runs/:runId');
}

/**
 * Requests cancellation of one run. The server decides: the response is
 * the run's current state, which may still be non-terminal while the run
 * stops at its next checkpoint.
 */
export async function cancelAgentRun(runId: string): Promise<AgentRunView> {
  const raw = await apiRequest<unknown>(`/api/agents/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
  return toAgentRunView(raw, 'POST /api/agents/runs/:runId/cancel');
}

/**
 * Submits the human decision for a run's pending confirmation (the only
 * path an approval can take). The SERVER validates expiry, input binding,
 * and permissions, executes the tool if approved, and returns the run's
 * authoritative next state - the browser never decides anything.
 */
export async function submitAgentConfirmation(
  runId: string,
  decision: 'approve' | 'reject',
): Promise<AgentRunView> {
  const raw = await apiRequest<unknown>(
    `/api/agents/runs/${encodeURIComponent(runId)}/confirmation`,
    { method: 'POST', body: { decision } },
  );
  return toAgentRunView(raw, 'POST /api/agents/runs/:runId/confirmation');
}
