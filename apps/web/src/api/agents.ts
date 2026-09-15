/**
 * Agent API surface + safe UI models (Step 11C-2).
 *
 * Raw backend agent responses are mapped into `AgentRunView` before
 * reaching the UI: unknown/invalid data becomes a typed error, and fields
 * the workspace does not use in this step (iteration counters, tool
 * results, pending confirmations) are dropped rather than passed through.
 * The final answer is the ONLY model output surfaced to the conversation.
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

/**
 * Safe UI model for one agent run. Only the fields the workspace renders:
 * identity, status, the final answer (assistant output), a typed error,
 * and the limit reason. Internal counters and tool history are dropped.
 */
export interface AgentRunView {
  readonly runId: string;
  readonly agentId: string;
  readonly status: AgentRunStatus;
  /** The run's final answer. Present only when the backend reports completion. */
  readonly finalOutput: string | null;
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
  return {
    runId,
    agentId,
    status: status as AgentRunStatus,
    finalOutput: optionalString(raw.finalOutput),
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
}): Promise<AgentRunView> {
  const raw = await apiRequest<unknown>('/api/agents/run', {
    method: 'POST',
    body: {
      agentId: request.agentId,
      task: request.task,
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
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
