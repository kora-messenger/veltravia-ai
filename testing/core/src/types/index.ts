/**
 * Testing & Debugging Agent types: the strictly typed TestRun, TestPlan,
 * structured results, deterministic diagnostics, FACT/INFERENCE/RECOMMENDATION
 * diagnoses, bounded RepairPlans, limits, state machine states, and the SAFE
 * run/result views. Nothing here carries authority, credentials, or
 * permissions - every command flows through the Tool System into the Secure
 * Sandbox, and every code mutation flows through the Coding Agent.
 */

// ---------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------

/** Project types supported for testing (mirrors the Step 13 app types). */
export const SUPPORTED_PROJECT_TYPES = ['web', 'backend', 'fullstack', 'unknown'] as const;
export type SupportedProjectType = (typeof SUPPORTED_PROJECT_TYPES)[number];

/** One structural signal found in the project tree (paths only, no content). */
export interface DetectionSignal {
  readonly kind:
    | 'package-manifest'
    | 'typescript-config'
    | 'vite-config'
    | 'react-dependency'
    | 'fastify-dependency'
    | 'node-runtime'
    | 'test-directory'
    | 'test-script';
  readonly detail: string;
}

/** Bounded summary of what detection observed (never file content). */
export interface ProjectDetection {
  readonly projectType: SupportedProjectType;
  readonly signals: readonly DetectionSignal[];
  readonly framework: string | null;
  readonly runtime: string | null;
  readonly testScript: string | null;
  readonly buildScript: string | null;
  readonly manifestPath: string | null;
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Test plan (structural commands only - never raw shell strings)
// ---------------------------------------------------------------------------

export const TEST_COMMAND_PURPOSES = ['validate', 'build', 'test'] as const;
export type TestCommandPurpose = (typeof TEST_COMMAND_PURPOSES)[number];

/**
 * ONE structured command. `executable` is a bare allowlisted-style name (no
 * path separators, no spaces, no shell metacharacters) and `arguments` is a
 * typed string array - the Tool System + Sandbox enforce the real policy.
 * `scriptName` marks commands DERIVED from a manifest script: at execution
 * time the current script value is re-read through the Project Engine and
 * re-derived, so a repair that fixes the script is retested honestly.
 */
export interface TestCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly purpose: TestCommandPurpose;
  readonly label: string;
  readonly scriptName?: string;
}

export interface TestPlan {
  readonly version: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly projectType: SupportedProjectType;
  readonly detection: ProjectDetection;
  readonly validationSteps: readonly string[];
  readonly commands: readonly TestCommand[];
  readonly commandTimeoutMs: number;
  readonly requiredPermissions: readonly string[];
  readonly repairAllowed: boolean;
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Structured results (raw output is bounded + scrubbed, always untrusted)
// ---------------------------------------------------------------------------

export const FAILURE_CATEGORIES = [
  'syntax_error',
  'type_error',
  'test_failure',
  'dependency_error',
  'configuration_error',
  'build_error',
  'runtime_error',
  'missing_file',
  'missing_dependency',
  'unknown_failure',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** One command execution, normalized. Output is a bounded, scrubbed summary. */
export interface TestCommandResult {
  readonly index: number;
  readonly label: string;
  readonly purpose: TestCommandPurpose;
  readonly command: { readonly executable: string; readonly arguments: readonly string[] };
  readonly executed: boolean;
  readonly success: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly terminated: boolean;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
}

/** The aggregate result of one test pass (initial or retest). */
export interface TestPassResult {
  readonly executed: boolean;
  readonly success: boolean;
  readonly results: readonly TestCommandResult[];
  readonly failedCommandIndex: number | null;
  readonly failureCategory: FailureCategory | null;
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Diagnosis (explicit FACT / INFERENCE / RECOMMENDATION vocabulary)
// ---------------------------------------------------------------------------

export type DiagnosisStatementKind = 'fact' | 'inference' | 'recommendation';

export interface DiagnosisStatement {
  readonly kind: DiagnosisStatementKind;
  readonly text: string;
  readonly evidence?: string;
  readonly confidence?: ConfidenceLevel;
}

export interface Diagnosis {
  readonly category: FailureCategory;
  readonly summary: string;
  readonly statements: readonly DiagnosisStatement[];
  readonly affectedPaths: readonly string[];
  readonly confidence: ConfidenceLevel;
  readonly recommendedAction: string;
}

// ---------------------------------------------------------------------------
// Repair plan (typed, bounded, human-approved before any mutation)
// ---------------------------------------------------------------------------

export const REPAIR_CHANGE_MODES = ['update', 'create'] as const;
export type RepairChangeMode = (typeof REPAIR_CHANGE_MODES)[number];

export const REPAIR_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RepairRiskLevel = (typeof REPAIR_RISK_LEVELS)[number];

export const REPAIR_SCOPES = ['single-file', 'multi-file'] as const;
export type RepairScope = (typeof REPAIR_SCOPES)[number];

export interface RepairChange {
  readonly path: string;
  readonly mode: RepairChangeMode;
  readonly content: string;
  readonly reason: string;
  readonly expectedEffect: string;
}

export interface RepairPlan {
  readonly diagnosis: Diagnosis;
  readonly changes: readonly RepairChange[];
  readonly risk: RepairRiskLevel;
  readonly scope: RepairScope;
  readonly verificationPlan: string;
  readonly testsToRerun: readonly string[];
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const TEST_RUN_STATES = [
  'created',
  'planning',
  'awaiting_approval',
  'approved',
  'running',
  'analyzing',
  'awaiting_repair_approval',
  'repairing',
  'retesting',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TestRunState = (typeof TEST_RUN_STATES)[number];

export const TEST_RUN_TERMINAL_STATES: readonly TestRunState[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTestRunTerminal(state: TestRunState): boolean {
  return TEST_RUN_TERMINAL_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Pending approvals (the ONLY human gates; nothing auto-approves)
// ---------------------------------------------------------------------------

export type TestPendingApproval =
  | { readonly kind: 'plan_approval' }
  | { readonly kind: 'tool_confirmation'; readonly toolId: string; readonly confirmationId: string }
  | {
      readonly kind: 'repair_approval';
      readonly repairPlan: RepairPlanView;
      readonly codingRunId: string;
    };

// ---------------------------------------------------------------------------
// Failure view (typed, scrubbed - never raw tool errors)
// ---------------------------------------------------------------------------

export interface TestRunFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RevisionConflictResult {
  readonly path: string | null;
  readonly expectedRevision: number | null;
  readonly currentRevision: number | null;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Limits (bounded by hard ceilings - never unlimited)
// ---------------------------------------------------------------------------

export interface TestRunLimits {
  readonly maxRepairAttempts: number;
  readonly maxCommands: number;
  readonly maxDebugFiles: number;
  readonly maxCommandTimeoutMs: number;
}

export const TEST_RUN_LIMIT_CEILINGS = {
  maxRepairAttempts: 10,
  maxCommands: 64,
  maxDebugFiles: 8,
  maxCommandTimeoutMs: 120_000,
} as const;

export const TEST_RUN_LIMIT_DEFAULTS: TestRunLimits = {
  maxRepairAttempts: 3,
  maxCommands: 24,
  maxDebugFiles: 6,
  maxCommandTimeoutMs: 60_000,
};

// ---------------------------------------------------------------------------
// Safe views (exactly what the API and UI may see - no secrets, no dumps)
// ---------------------------------------------------------------------------

export interface TestRunView {
  readonly runId: string;
  readonly state: TestRunState;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly projectType: SupportedProjectType | null;
  readonly plan: TestPlanView | null;
  readonly results: TestPassResult | null;
  readonly retestResults: TestPassResult | null;
  readonly diagnosis: Diagnosis | null;
  readonly repairPlan: RepairPlanView | null;
  readonly repairAttempts: number;
  readonly commandsExecuted: number;
  readonly codingRunId: string | null;
  readonly revisionConflict: RevisionConflictResult | null;
  readonly pendingApproval: TestPendingApproval | null;
  readonly failure: TestRunFailure | null;
  readonly notes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TestPlanView {
  readonly version: string;
  readonly projectType: SupportedProjectType;
  readonly framework: string | null;
  readonly runtime: string | null;
  readonly signals: readonly DetectionSignal[];
  readonly validationSteps: readonly string[];
  readonly commands: readonly {
    readonly label: string;
    readonly purpose: TestCommandPurpose;
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly scriptName: string | null;
  }[];
  readonly commandTimeoutMs: number;
  readonly repairAllowed: boolean;
  readonly notes: readonly string[];
}

export interface RepairPlanView {
  readonly summary: string;
  readonly category: FailureCategory;
  readonly confidence: ConfidenceLevel;
  readonly affectedPaths: readonly string[];
  readonly changes: readonly {
    readonly path: string;
    readonly mode: RepairChangeMode;
    readonly reason: string;
    readonly expectedEffect: string;
    readonly contentBytes: number;
  }[];
  readonly risk: RepairRiskLevel;
  readonly scope: RepairScope;
  readonly verificationPlan: string;
  readonly testsToRerun: readonly string[];
}
