import { apiRequest } from './client';

/**
 * Typed client for Step 29 real-model execution.
 *
 * Streaming uses `fetch` with a readable body, not `EventSource`, for two
 * reasons: EventSource cannot POST, and POST is what a task needs. The parser
 * below only understands the documented event names, so an unexpected frame is
 * ignored rather than rendered as an answer.
 */

export type ExecutionEventType =
  | 'run.started'
  | 'progress'
  | 'route.selected'
  | 'context.prepared'
  | 'delta'
  | 'usage'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface RouteSelected {
  readonly type: 'route.selected';
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly summary: string;
  readonly contextWindowTokens: number | null;
  readonly streaming: boolean;
}

export interface ContextPrepared {
  readonly type: 'context.prepared';
  readonly estimatedInputTokens: number;
  readonly truncated: boolean;
  readonly droppedMessages: number;
  readonly notes: readonly string[];
}

export interface UsageReported {
  readonly type: 'usage';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageSource: 'provider-confirmed' | 'unavailable';
  readonly estimatedCostUsd: number | null;
  readonly costSource: 'declared-pricing' | 'unavailable';
  readonly latencyMs: number;
  readonly streamed: boolean;
}

export interface RunCompleted {
  readonly type: 'run.completed';
  readonly content: string;
  readonly finishReason: string;
  readonly latencyMs: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly streamed: boolean;
}

export interface RunFailed {
  readonly type: 'run.failed';
  readonly code: string;
  readonly message: string;
}

export interface RunCancelled {
  readonly type: 'run.cancelled';
  readonly message: string;
}

export interface ProgressEvent {
  readonly type: 'progress';
  readonly stage: 'routing' | 'context' | 'generating' | 'recording';
  readonly message: string;
}

export interface DeltaEvent {
  readonly type: 'delta';
  readonly text: string;
}

export interface ExecutionCapabilities {
  readonly ready: boolean;
  readonly blockedReason: string | null;
  readonly categories: readonly string[];
  readonly limits: { readonly maxOutputTokens: number; readonly maxHistoryMessages: number };
}

export interface UsageRow {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageSource: string;
  readonly estimatedCostUsd: number | null;
  readonly costSource: string;
  readonly latencyMs: number;
  readonly streamed: boolean;
  readonly requestedAt: string;
}

export type ParsedEvent =
  | RouteSelected
  | ContextPrepared
  | UsageReported
  | RunCompleted
  | RunFailed
  | RunCancelled
  | ProgressEvent
  | DeltaEvent;

export async function getExecutionCapabilities(
  fetchImpl: typeof fetch = fetch,
): Promise<ExecutionCapabilities> {
  return apiRequest<ExecutionCapabilities>('/api/ai/execution', { fetchImpl });
}

export async function getExecutionUsage(
  limit = 20,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly UsageRow[]> {
  const body = await apiRequest<{ records: readonly UsageRow[] }>(
    `/api/ai/execution/usage?limit=${limit}`,
    { fetchImpl },
  );
  return body.records;
}

export async function cancelExecutionRun(
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await apiRequest(`/api/ai/execution/runs/${runId}/cancel`, { method: 'POST', fetchImpl });
}

export interface StartExecutionInput {
  readonly task: string;
  readonly category?: string;
  readonly maxOutputTokens?: number;
  readonly stream?: boolean;
  readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
}

export interface StartExecutionHandlers {
  readonly onEvent: (event: ParsedEvent) => void;
  readonly onRunId?: (runId: string) => void;
}

/**
 * Starts a run and parses the event stream as it arrives.
 *
 * Returns quietly on a closed stream; a non-2xx response is turned into a
 * readable error so the caller never shows an empty answer as a success.
 */
export async function startExecution(
  input: StartExecutionInput,
  handlers: StartExecutionHandlers,
  options: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch('/api/ai/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    let message = 'The run could not be started.';
    let code = 'EXECUTION_FAILED';
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      if (payload.error?.message) message = payload.error.message;
      if (payload.error?.code) code = payload.error.code;
    } catch {
      /* non-JSON failure: keep the generic, honest message */
    }
    handlers.onEvent({ type: 'run.failed', code, message });
    return;
  }

  if (response.body === null) {
    handlers.onEvent({
      type: 'run.failed',
      code: 'EXECUTION_NO_STREAM',
      message: 'This browser could not read the response stream.',
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleBlock(block, handlers);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function handleBlock(block: string, handlers: StartExecutionHandlers): void {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (payload === null || typeof payload !== 'object') return;
  if (eventName === 'run.started') {
    const runId = (payload as { runId?: unknown }).runId;
    if (typeof runId === 'string') handlers.onRunId?.(runId);
    return;
  }
  handlers.onEvent(payload as ParsedEvent);
}
