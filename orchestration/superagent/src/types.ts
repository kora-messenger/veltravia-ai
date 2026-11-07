/**
 * The wire contract between a worker and a model.
 *
 * A model answers with one JSON object per turn: either a tool request or a
 * final report. Anything else is a protocol error the executor can correct on
 * the next turn, never something the server acts on hopefully.
 */

export type WorkerToolPermission = 'read' | 'write' | 'test' | 'schema' | 'network';

export interface WorkerToolDescriptor {
  readonly id: string;
  readonly description: string;
  readonly permission: WorkerToolPermission;
  /** Argument names whose values are project paths and must be in scope. */
  readonly pathArguments: readonly string[];
  /** True when the tool changes project state and must be recorded as a change. */
  readonly mutating: boolean;
}

export interface WorkerToolInvocation {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

export type WorkerToolOutcome =
  | {
      readonly ok: true;
      readonly output: string;
      readonly bytes: number;
      readonly changedPaths?: readonly string[];
      readonly passed?: boolean;
      /** Stable reference for review, e.g. the verification run id. */
      readonly evidenceRef?: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface WorkerToolHandler {
  (invocation: WorkerToolInvocation, context: WorkerToolContext): Promise<WorkerToolOutcome>;
}

export interface WorkerToolContext {
  readonly ownerRef: string;
  readonly workerId: string;
  readonly workerType: string;
  readonly taskId: string;
  readonly projectId: string | null;
  /** Verification operations the assignment authorises; empty when none. */
  readonly verificationOperations: readonly string[];
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly record: (message: string, detail?: Record<string, unknown>) => void;
}

export interface WorkerModelTurn {
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly live: boolean;
}

export interface WorkerUsage {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly live: boolean;
}
