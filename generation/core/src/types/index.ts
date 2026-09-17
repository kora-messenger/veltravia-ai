/**
 * App Generation Engine types: the strictly typed specification, plan,
 * template, dependency/command models, limits, state machine states, and the
 * SAFE run/result views. Nothing here carries authority, credentials, or
 * permissions - every mutation still flows through the Tool System.
 */

// ---------------------------------------------------------------------------
// Supported application types (controlled set; extend deliberately)
// ---------------------------------------------------------------------------

export const APP_TYPES = ['web', 'backend-api', 'fullstack'] as const;
export type AppType = (typeof APP_TYPES)[number];

export const TARGET_PLATFORMS = ['web', 'server', 'web+server'] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

// ---------------------------------------------------------------------------
// App specification
// ---------------------------------------------------------------------------

/** One named screen/page of the future application. */
export interface SpecScreen {
  readonly name: string;
  readonly description?: string;
}

/** One data entity with typed fields (names only - never real data). */
export interface SpecEntity {
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly type: string }[];
}

/**
 * A validated application specification: the structured, typed form of the
 * user's idea. Produced by a GenerationPlanner (AI or deterministic mock)
 * and ALWAYS validated by the policy layer before anything else happens.
 * Optional fields may stay absent when a later phase can infer them.
 */
export interface AppSpecification {
  readonly name: string;
  readonly description: string;
  readonly appType: AppType;
  readonly targetPlatform: TargetPlatform;
  readonly frontendTechnology?: string;
  readonly backendTechnology?: string;
  readonly databaseRequirement?: string;
  readonly authenticationRequirement?: string;
  readonly features: readonly string[];
  readonly screens: readonly SpecScreen[];
  readonly entities: readonly SpecEntity[];
  readonly integrations: readonly string[];
  readonly styling?: string;
  readonly deploymentTarget?: string;
  readonly constraints: readonly string[];
  readonly version: string;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** One file a template (or repair source) wants written. */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/** A template's own structure validation rules (never generic guesses). */
export interface TemplateValidationRules {
  /** Files that must exist for the app to be structurally valid. */
  readonly requiredFiles: readonly string[];
  /** Directories that must exist. */
  readonly requiredDirectories: readonly string[];
  /** Whether a parseable package.json is required. */
  readonly packageManifestRequired: boolean;
}

/** One structured, sandbox-safe validation/test command. */
export interface TemplateCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly purpose: string;
}

/**
 * A deterministic project template. `generateFiles` is a PURE function of the
 * specification - the same spec always yields the same files, and no template
 * ever executes anything, reads the host, or holds credentials.
 */
export interface ProjectTemplate {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly supportedAppTypes: readonly AppType[];
  readonly technologyStack: Readonly<{
    readonly frontend?: string;
    readonly backend?: string;
    readonly buildTool: string;
    readonly language: string;
  }>;
  readonly requiredDependencies: readonly string[];
  readonly validationRules: TemplateValidationRules;
  readonly testCommands: readonly TemplateCommand[];
  /** Deterministic starter-file generation for one specification. */
  generateFiles(spec: AppSpecification): readonly PlannedFile[];
}

// ---------------------------------------------------------------------------
// Dependencies (structured requests - never raw installs)
// ---------------------------------------------------------------------------

export const DEPENDENCY_SOURCES = ['npm'] as const;
export type DependencySource = (typeof DEPENDENCY_SOURCES)[number];

export interface DependencyRequest {
  readonly name: string;
  readonly versionRange: string;
  readonly reason: string;
  readonly source: DependencySource;
}

// ---------------------------------------------------------------------------
// Generation commands (structured; the sandbox re-validates everything)
// ---------------------------------------------------------------------------

export type GenerationCommandPhase = 'test';

export interface GenerationCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly purpose: string;
  readonly phase: GenerationCommandPhase;
}

// ---------------------------------------------------------------------------
// Generation plan
// ---------------------------------------------------------------------------

/** Risk metadata surfaced to the approving human (never secrets). */
export interface GenerationPlanRisk {
  /** Human-readable destructive actions, if any (plans avoid them by design). */
  readonly destructiveActions: readonly string[];
  /** Tool ids the plan may invoke that require human confirmation. */
  readonly confirmationRequiringTools: readonly string[];
  /** Human-readable integrations the app declares (never credentials). */
  readonly externalIntegrations: readonly string[];
}

export interface GenerationPlanProject {
  readonly name: string;
  readonly description: string;
  readonly projectType: string;
}

/**
 * A validated generation plan. Every mutation is explicit: files to create,
 * files to modify, structured dependencies, structured commands, risk
 * metadata. The plan is DATA: it can never carry tool ids to bypass the
 * Tool System, raw shell strings, limits, or credentials - the policy
 * layer rejects all of that.
 */
export interface GenerationPlan {
  readonly version: string;
  readonly project: GenerationPlanProject;
  readonly templateId: string;
  readonly filesToCreate: readonly PlannedFile[];
  readonly filesToModify: readonly PlannedFile[];
  readonly dependencies: readonly DependencyRequest[];
  readonly commands: readonly GenerationCommand[];
  readonly risk: GenerationPlanRisk;
}

// ---------------------------------------------------------------------------
// Limits (server-side configuration only; plans and users cannot raise them)
// ---------------------------------------------------------------------------

export const GENERATION_LIMIT_CEILINGS = {
  maxRepairAttempts: 5,
  maxFilesChanged: 500,
  maxCommands: 50,
  maxDurationMs: 30 * 60 * 1000,
} as const;

export const GENERATION_LIMIT_DEFAULTS = {
  maxRepairAttempts: 2,
  maxFilesChanged: 200,
  maxCommands: 20,
  maxDurationMs: 10 * 60 * 1000,
} as const;

export interface GenerationRunLimits {
  readonly maxRepairAttempts: number;
  readonly maxFilesChanged: number;
  readonly maxCommands: number;
  readonly maxDurationMs: number;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const GENERATION_STATES = [
  'created',
  'planning',
  'awaiting_approval',
  'initializing',
  'generating',
  'validating',
  'testing',
  'repairing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type GenerationState = (typeof GENERATION_STATES)[number];

export const GENERATION_TERMINAL_STATES: readonly GenerationState[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isGenerationTerminal(state: GenerationState): boolean {
  return GENERATION_TERMINAL_STATES.includes(state);
}

/** The execution phases, in order, for progress display. */
export const GENERATION_PHASES = [
  'planning',
  'initialize',
  'generate',
  'validate',
  'test',
  'repair',
] as const;

export type GenerationPhase = (typeof GENERATION_PHASES)[number];

export type GenerationPhaseStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface GenerationPhaseProgress {
  readonly phase: GenerationPhase;
  readonly status: GenerationPhaseStatus;
}

// ---------------------------------------------------------------------------
// Summaries (safe, bounded)
// ---------------------------------------------------------------------------

export interface GenerationChangedFile {
  readonly path: string;
  readonly action: 'created' | 'updated';
}

export interface GenerationValidationSummary {
  readonly passed: boolean;
  readonly checks: readonly { readonly description: string; readonly passed: boolean }[];
}

export interface GenerationTestSummary {
  readonly executed: boolean;
  readonly commands: readonly {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly exitCode: number | null;
    readonly passed: boolean;
    /** Bounded, scrubbed excerpt. UNTRUSTED DATA. */
    readonly stdout: string;
    readonly stderr: string;
  }[];
}

export interface GenerationFailure {
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type GenerationOutcome = 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';

export interface GenerationResult {
  readonly outcome: GenerationOutcome;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly filesChanged: readonly GenerationChangedFile[];
  readonly validation: GenerationValidationSummary | null;
  readonly tests: GenerationTestSummary | null;
  readonly repairAttempts: number;
  readonly warnings: readonly string[];
  readonly remainingIssues: readonly string[];
  readonly completedAt: string;
}

// ---------------------------------------------------------------------------
// Approvals (humans only - the engine never approves itself)
// ---------------------------------------------------------------------------

export type GenerationPendingApproval =
  | { readonly kind: 'plan_approval' }
  | {
      readonly kind: 'tool_confirmation';
      readonly toolId: string;
      readonly confirmationId: string;
    };

// ---------------------------------------------------------------------------
// Safe views (what the API returns; no secrets, no file dumps)
// ---------------------------------------------------------------------------

export interface GenerationPlanView {
  readonly version: string;
  readonly project: GenerationPlanProject;
  readonly templateId: string;
  readonly filesToCreate: readonly { readonly path: string; readonly bytes: number }[];
  readonly filesToModify: readonly { readonly path: string; readonly bytes: number }[];
  readonly dependencies: readonly DependencyRequest[];
  readonly commands: readonly GenerationCommand[];
  readonly risk: GenerationPlanRisk;
}

export interface GenerationRunView {
  readonly runId: string;
  readonly idea: string;
  readonly state: GenerationState;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly templateId: string | null;
  readonly specName: string | null;
  readonly appType: AppType | null;
  readonly phases: readonly GenerationPhaseProgress[];
  readonly changedFiles: readonly GenerationChangedFile[];
  readonly repairAttempts: number;
  readonly failure: GenerationFailure | null;
  readonly pendingApproval: GenerationPendingApproval | null;
  readonly result: GenerationResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
