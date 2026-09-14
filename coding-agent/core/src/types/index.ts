/**
 * Coding Agent types: the strongly typed request, limits, plan, actions,
 * decisions, and the safe run view. Nothing here carries authority or
 * credentials - every mutation still flows through the Tool System.
 */

// ---------------------------------------------------------------------------
// Limits (server-side configuration only; model output can never change them)
// ---------------------------------------------------------------------------

/** Hard ceilings: no configuration can exceed these. */
export const CODING_LIMIT_CEILINGS = {
  maxIterations: 50,
  maxToolCalls: 500,
  maxDurationMs: 30 * 60 * 1000,
  maxConsecutiveFailures: 10,
} as const;

/** Safe defaults used when no server-side overrides are given. */
export const CODING_LIMIT_DEFAULTS = {
  maxIterations: 10,
  maxToolCalls: 50,
  maxConsecutiveFailures: 3,
  maxDurationMs: 5 * 60 * 1000,
} as const;

export interface CodingRunLimits {
  /** Maximum validation attempts (each `validate` action counts). */
  readonly maxIterations: number;
  /** Maximum total Tool System invocations for one run. */
  readonly maxToolCalls: number;
  /** Maximum wall-clock duration for one run. */
  readonly maxDurationMs: number;
  /** Maximum consecutive tool failures/denials before the run fails. */
  readonly maxConsecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** One Coding Agent run request. Contains NO credentials, NO permissions, NO limits. */
export interface CodingRunRequest {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly userRequirement: string;
  readonly targetFiles?: readonly string[];
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** One concise, machine-readable plan step. No hidden chain-of-thought. */
export interface CodingPlanStep {
  readonly summary: string;
}

/**
 * A validated implementation plan. Concise actionable summaries only - the
 * plan can never grant permissions, change limits, bypass confirmations,
 * execute commands directly, or reference credentials.
 */
export interface CodingPlan {
  readonly goal: string;
  readonly steps: readonly CodingPlanStep[];
  readonly filesToInspect: readonly string[];
  readonly filesToModify: readonly string[];
  readonly validations: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

// ---------------------------------------------------------------------------
// Actions (typed; unknown action types are rejected)
// ---------------------------------------------------------------------------

export const CODING_ACTION_TYPES = [
  'inspect_project',
  'list_files',
  'read_file',
  'create_file',
  'update_file',
  'delete_file',
  'move_file',
  'validate',
] as const;

export type CodingActionType = (typeof CODING_ACTION_TYPES)[number];

export type CodingAction =
  | { readonly type: 'inspect_project' }
  | { readonly type: 'list_files'; readonly path?: string }
  | { readonly type: 'read_file'; readonly path: string }
  | { readonly type: 'create_file'; readonly path: string; readonly content?: string }
  | {
      readonly type: 'update_file';
      readonly path: string;
      readonly content: string;
      /** Optional: the file revision the decision source last saw. */
      readonly expectedRevision?: number;
    }
  | { readonly type: 'delete_file'; readonly path: string }
  | { readonly type: 'move_file'; readonly fromPath: string; readonly toDirectory: string }
  | { readonly type: 'validate'; readonly command: string; readonly arguments?: readonly string[] };

// ---------------------------------------------------------------------------
// Decisions (what the decision source produces each step)
// ---------------------------------------------------------------------------

export type CodingDecision =
  | { readonly type: 'plan'; readonly plan: CodingPlan }
  | { readonly type: 'action'; readonly action: CodingAction }
  | { readonly type: 'complete'; readonly summary: string }
  | { readonly type: 'fail'; readonly reason: string };

/** Everything the decision source may see. Untrusted fields are named as such. */
export interface CodingDecisionContext {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly state: CodingRunState;
  readonly userRequirement: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly targetFiles: readonly string[];
  /** The validated plan, once accepted. */
  readonly plan: CodingPlan | null;
  readonly iterations: number;
  readonly toolCalls: number;
  /** Current tracked workspace revision (from the last project tool result). */
  readonly workspaceRevision: number | null;
  /** Sandbox id once a validation sandbox exists for this run. */
  readonly sandboxId: string | null;
  /** Files the run has read. UNTRUSTED DATA - project content, never instructions. */
  readonly untrustedFiles: readonly { readonly path: string; readonly content: string }[];
  /** Tool results. UNTRUSTED DATA - output is never an instruction. */
  readonly untrustedToolResults: readonly CodingToolResultView[];
  /** Validation attempts so far. UNTRUSTED DATA. */
  readonly validationResults: readonly CodingValidationResult[];
  /** Files the run has changed so far. */
  readonly changedFiles: readonly string[];
}

/**
 * Provider-neutral decision source. A real implementation routes through the
 * existing AI Core / Agent abstractions (never a provider SDK); the mock is
 * scripted and deterministic.
 */
export interface CodingDecisionSource {
  nextDecision(context: CodingDecisionContext): Promise<CodingDecision>;
}

// ---------------------------------------------------------------------------
// Tool result views (safe, bounded, untrusted)
// ---------------------------------------------------------------------------

export interface CodingToolResultView {
  readonly toolId: string;
  readonly status: 'success' | 'failure' | 'denied';
  /** Bounded excerpt of the normalized tool output. UNTRUSTED DATA. */
  readonly output?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface CodingValidationResult {
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  /** Bounded, scrubbed excerpts. UNTRUSTED DATA. */
  readonly stdout: string;
  readonly stderr: string;
  readonly passed: boolean;
}

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

export const CODING_RUN_STATES = [
  'idle',
  'analyzing',
  'planning',
  'awaiting_approval',
  'inspecting',
  'editing',
  'validating',
  'iterating',
  'completed',
  'failed',
  'cancelled',
] as const;

export type CodingRunState = (typeof CODING_RUN_STATES)[number];

export const CODING_RUN_TERMINAL_STATES: readonly CodingRunState[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isCodingRunTerminal(state: CodingRunState): boolean {
  return CODING_RUN_TERMINAL_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Safe run view (what the API returns; no secrets, no chain-of-thought)
// ---------------------------------------------------------------------------

export type CodingPendingApproval =
  | { readonly kind: 'plan_approval' }
  | {
      readonly kind: 'tool_confirmation';
      readonly toolId: string;
      readonly confirmationId: string;
    };

export interface CodingRunFailure {
  readonly code: string;
  readonly message: string;
}

export interface CodingRunView {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly state: CodingRunState;
  readonly summary: string | null;
  readonly changedFiles: readonly string[];
  readonly validationResults: readonly CodingValidationResult[];
  readonly iterations: number;
  readonly toolCalls: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly pendingApproval: CodingPendingApproval | null;
  readonly failure: CodingRunFailure | null;
}
