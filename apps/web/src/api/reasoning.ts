import { apiRequest } from './client';

/**
 * Typed client for the reasoning engine (Step 27).
 *
 * The browser is a presentation client: it starts a run, follows the server's
 * own event stream, and renders exactly what the server reports. It never sees
 * a provider credential, never receives hidden reasoning, and never invents an
 * answer - a failed run stays failed.
 */

const base = '/api/reasoning';

export type ReasoningProfileId =
  'workspace' | 'document' | 'intelligence' | 'agent' | 'coding' | 'connected-apps';

export interface ReasoningProfileView {
  readonly id: ReasoningProfileId;
  readonly displayName: string;
  readonly description: string;
  readonly contextKinds: readonly string[];
  readonly toolPrefixes: readonly string[];
}

export interface ReasoningLimits {
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly maxDurationMs: number;
  readonly maxProviderRetries: number;
  readonly contextBudgetChars: number;
}

export interface ReasoningToolView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly riskLevel: string;
  readonly available: boolean;
}

export interface ReasoningCapabilities {
  readonly profiles: readonly ReasoningProfileView[];
  readonly limits: ReasoningLimits;
  readonly ceilings: ReasoningLimits;
  readonly provider: {
    readonly connected: boolean;
    readonly reason: string | null;
    readonly modes: readonly ('gateway' | 'simulated')[];
  };
  readonly tools: readonly ReasoningToolView[];
  readonly simulatedReasoningAllowed: boolean;
}

export type ReasoningStatus =
  'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled' | 'limit_reached';

export interface ReasoningProviderDisclosure {
  readonly providerId: string;
  readonly modelId: string;
  readonly live: boolean;
  readonly simulated: boolean;
}

export interface ReasoningToolStepView {
  readonly id: string;
  readonly toolId: string;
  readonly intent: string;
  readonly status: 'success' | 'failed' | 'rejected' | 'pending_confirmation';
  readonly durationMs?: number;
  readonly error?: { readonly code: string; readonly message: string };
  readonly outputPreview?: string;
}

export interface ReasoningRunView {
  readonly id: string;
  readonly profile: ReasoningProfileId;
  readonly task: string;
  readonly status: ReasoningStatus;
  readonly classification?: { readonly taskType: string; readonly needsTools: boolean };
  readonly plan?: { readonly goal: string; readonly steps: readonly { readonly intent: string }[] };
  readonly steps: readonly ReasoningToolStepView[];
  readonly decisions: readonly string[];
  readonly answer?: string;
  readonly provider?: ReasoningProviderDisclosure;
  readonly usage: {
    readonly iterations: number;
    readonly toolCalls: number;
    readonly modelCalls: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly providerLatencyMs: number;
    readonly latencyMs: number;
  };
  readonly provenance: readonly {
    readonly kind: string;
    readonly label: string;
    readonly trust: string;
  }[];
  readonly contextDropped: readonly { readonly label: string; readonly reason: string }[];
  readonly limitations: readonly string[];
  readonly pendingConfirmation?: {
    readonly confirmationId: string;
    readonly toolId: string;
    readonly riskLevel?: string;
    readonly expiresAt?: string;
  };
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
}

export type ReasoningEvent =
  | {
      readonly type: 'phase';
      readonly at: string;
      readonly phase: string;
      readonly detail?: string;
    }
  | {
      readonly type: 'provider';
      readonly at: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly simulated: boolean;
    }
  | {
      readonly type: 'classification';
      readonly at: string;
      readonly taskType: string;
      readonly needsTools: boolean;
    }
  | {
      readonly type: 'plan';
      readonly at: string;
      readonly goal: string;
      readonly steps: readonly string[];
    }
  | { readonly type: 'delta'; readonly at: string; readonly text: string }
  | {
      readonly type: 'tool';
      readonly at: string;
      readonly toolId: string;
      readonly status: string;
      readonly detail?: string;
    }
  | {
      readonly type: 'confirmation';
      readonly at: string;
      readonly confirmationId: string;
      readonly toolId: string;
      readonly riskLevel?: string;
    }
  | { readonly type: 'final'; readonly at: string; readonly run?: ReasoningRunView }
  | { readonly type: 'usage'; readonly at: string; readonly usage: ReasoningRunView['usage'] }
  | { readonly type: 'error'; readonly at: string; readonly message: string };

export interface ReasoningUsageRecord {
  readonly runId: string;
  readonly profile: string;
  readonly status: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly live: boolean;
  readonly simulated: boolean;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly failureCategory: string | null;
  readonly createdAt: string;
}

export async function getCapabilities(): Promise<ReasoningCapabilities> {
  return apiRequest<ReasoningCapabilities>(base);
}

export async function startRun(input: {
  task: string;
  profile: ReasoningProfileId;
  mode?: 'gateway' | 'simulated';
  projectId?: string;
  conversation?: readonly { role: 'user' | 'assistant'; content: string }[];
  idempotencyKey?: string;
}): Promise<ReasoningRunView> {
  const response = await apiRequest<{ run: ReasoningRunView }>(`${base}/runs`, {
    method: 'POST',
    body: input,
  });
  return response.run;
}

export async function getRun(runId: string): Promise<ReasoningRunView> {
  const response = await apiRequest<{ run: ReasoningRunView }>(`${base}/runs/${runId}`);
  return response.run;
}

export async function cancelRun(runId: string): Promise<ReasoningRunView> {
  const response = await apiRequest<{ run: ReasoningRunView }>(`${base}/runs/${runId}/cancel`, {
    method: 'POST',
    body: {},
  });
  return response.run;
}

export async function decide(
  runId: string,
  confirmationId: string,
  decision: 'approved' | 'rejected',
): Promise<ReasoningRunView> {
  const response = await apiRequest<{ run: ReasoningRunView }>(
    `${base}/runs/${runId}/confirmation`,
    { method: 'POST', body: { confirmationId, decision } },
  );
  return response.run;
}

export async function getUsage(limit = 20): Promise<readonly ReasoningUsageRecord[]> {
  const response = await apiRequest<{ records: readonly ReasoningUsageRecord[] }>(
    `${base}/usage?limit=${limit}`,
  );
  return response.records;
}

/** Whether this run is finished (no further events will arrive). */
export function isTerminal(status: ReasoningStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'limit_reached'
  );
}

/**
 * Follows a run's server-sent events. Returns a close function. The callback
 * receives every event in order and never a duplicate (the browser reconnects
 * with Last-Event-ID automatically).
 */
export function followRun(
  runId: string,
  onEvent: (event: ReasoningEvent) => void,
  onClose?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    onClose?.();
    return () => undefined;
  }
  const source = new EventSource(`${base}/runs/${runId}/events`, { withCredentials: true });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
    onClose?.();
  };
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as ReasoningEvent);
    } catch {
      // A malformed frame is ignored rather than rendered as content.
    }
  };
  source.onerror = () => {
    close();
  };
  return close;
}
