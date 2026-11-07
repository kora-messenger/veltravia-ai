/**
 * Verification types - Step 45.
 *
 * The vocabulary of "did this project actually work". Nothing here executes
 * anything: discovery reads configuration, the policy turns an operation into
 * one exact argv, and the runner records what the sandbox reported.
 */

/** The verification operations a project can be asked to perform. */
export const VERIFICATION_OPERATIONS = [
  'unit',
  'integration',
  'e2e',
  'typecheck',
  'lint',
  'format',
  'build',
  'deps',
] as const;
export type VerificationOperation = (typeof VERIFICATION_OPERATIONS)[number];

/**
 * The terminal state of one operation. `passed` is only ever recorded when a
 * command really ran and exited zero; everything else says why it did not.
 */
export const OPERATION_STATUSES = [
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'unsupported',
  'blocked',
  'incomplete',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Whole-run state. `incomplete` means some operations never got an answer. */
export const RUN_STATUSES = [
  'running',
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'blocked',
  'incomplete',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';

export type DetectionConfidence = 'high' | 'medium' | 'low' | 'none';

export const TEST_FRAMEWORKS = ['vitest', 'jest', 'playwright', 'mocha', 'node-test'] as const;
export type TestFramework = (typeof TEST_FRAMEWORKS)[number];

/** One evidence-backed verification command derived from project configuration. */
export interface VerificationCommand {
  /** `npm:test` or `tool:tsc` - stable, never model-authored. */
  readonly id: string;
  readonly operation: VerificationOperation;
  /** Exact executable name. Always on the policy allowlist. */
  readonly command: string;
  /** Fixed arguments. The model never supplies these. */
  readonly args: readonly string[];
  /** Where the command came from: a declared script or a detected tool. */
  readonly source: 'script' | 'tool';
  readonly label: string;
  readonly confidence: DetectionConfidence;
  /** True when the command may take an optional bounded path filter. */
  readonly acceptsPath: boolean;
}

/** Why an operation could not be offered. Never invented, always explained. */
export interface UnsupportedOperation {
  readonly operation: VerificationOperation;
  readonly reason: string;
}

/** The structured verification profile of one project revision. */
export interface VerificationProfile {
  readonly framework: string | null;
  readonly packageManager: PackageManager;
  readonly scripts: Readonly<Record<string, string>>;
  readonly testFrameworks: readonly TestFramework[];
  readonly commands: readonly VerificationCommand[];
  readonly unsupported: readonly UnsupportedOperation[];
  readonly confidence: DetectionConfidence;
  /** Files the detection actually read, so a report can show its evidence. */
  readonly detectedFrom: readonly string[];
  /** Configuration files that would make more operations available. */
  readonly missing: readonly string[];
}

/** A single project file, as read from project storage. */
export interface ProjectFile {
  readonly path: string;
  readonly content: string;
}

/** Bounded limits for one verification run. */
export interface VerificationLimits {
  readonly maxOperations: number;
  readonly timeoutMsPerOperation: number;
  readonly maxOutputBytes: number;
  readonly maxRepairAttempts: number;
}

export const DEFAULT_VERIFICATION_LIMITS: VerificationLimits = {
  maxOperations: 6,
  timeoutMsPerOperation: 300_000,
  maxOutputBytes: 128_000,
  maxRepairAttempts: 2,
};

export const HARD_VERIFICATION_CEILINGS: VerificationLimits = {
  maxOperations: 8,
  timeoutMsPerOperation: 900_000,
  maxOutputBytes: 512_000,
  maxRepairAttempts: 3,
};

/** Counts parsed out of a test runner's output; null when not parseable. */
export interface TestCounts {
  readonly discovered: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
}

export type BuildStatus = 'passed' | 'failed' | 'not_applicable' | 'unknown';

/** What the sandbox reported, before interpretation. */
export interface RawExecution {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  /** True when the runtime could actually enforce the limits it was given. */
  readonly enforceableTimeout: boolean;
  readonly runtimeId: string;
  readonly providesOsIsolation: boolean;
  /** Limits the runtime could not enforce, named, so a report never overclaims. */
  readonly unenforced: readonly string[];
}

/** One operation's result: what was asked, what ran, what it said. */
export interface OperationResult {
  readonly operation: VerificationOperation;
  readonly commandId: string;
  readonly label: string;
  /** Exact argv that ran, recorded for evidence (never a shell string). */
  readonly argv: readonly string[];
  readonly status: OperationStatus;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly counts: TestCounts;
  readonly buildStatus: BuildStatus;
  readonly errorSummary: string | null;
  /** Bounded, scrubbed tail of the output. */
  readonly outputTail: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
  /** Why nothing ran, when the status is not a command outcome. */
  readonly reason: string | null;
  readonly runtimeId: string | null;
  readonly providesOsIsolation: boolean;
  readonly unenforced: readonly string[];
}

/** Evidence the Primary Agent can check before accepting a worker's delivery. */
export interface VerificationEvidence {
  readonly kind: 'verification-run';
  readonly runId: string;
  readonly projectId: string;
  readonly revision: string | null;
  readonly operations: readonly VerificationOperation[];
  readonly status: RunStatus;
  /** True only when at least one command really executed. */
  readonly executed: boolean;
  readonly executedCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly finishedAt: string | null;
}

/** Reasons a requested operation was refused before execution. */
export const VERIFICATION_BLOCK_REASONS = [
  'not_in_profile',
  'not_authorized',
  'limit_reached',
  'cancelled',
  'no_workspace',
  'sandbox_unavailable',
] as const;
export type VerificationBlockReason = (typeof VERIFICATION_BLOCK_REASONS)[number];

export interface BlockedOperation {
  readonly operation: VerificationOperation;
  readonly reason: VerificationBlockReason;
  readonly detail: string;
}

/** One verification run, as recorded and read back. */
export interface VerificationRunRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly workerId: string | null;
  /** Project revision the run was pinned to, or null when the project has none. */
  readonly revision: string | null;
  readonly status: RunStatus;
  readonly requestedOperations: readonly VerificationOperation[];
  readonly blocked: readonly BlockedOperation[];
  readonly results: readonly OperationResult[];
  readonly evidence: VerificationEvidence | null;
  /** Link to the run this one repairs, when it came from the repair loop. */
  readonly repairsRunId: string | null;
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly limits: VerificationLimits;
  readonly version: number;
}

export interface VerificationRunFilter {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly workerId?: string;
  readonly status?: RunStatus;
  readonly limit?: number;
}

/** Persistence port. The API supplies memory or Postgres. */
export interface VerificationStore {
  save(record: VerificationRunRecord): Promise<void>;
  get(ownerRef: string, runId: string): Promise<VerificationRunRecord | null>;
  list(ownerRef: string, filter?: VerificationRunFilter): Promise<readonly VerificationRunRecord[]>;
}

/** One prepared sandbox standing in for a project revision. */
export interface VerificationSession {
  readonly handle: unknown;
  readonly runtimeId: string;
  readonly providesOsIsolation: boolean;
  readonly unenforced: readonly string[];
  dispose(): Promise<void>;
}

/**
 * The execution seam. The API implements this over the Step 8 sandbox; tests
 * implement it with a scripted double. Core never runs a process itself.
 */
export interface VerificationExecutor {
  prepare(input: {
    readonly projectId: string;
    readonly revision: string | null;
    readonly files: readonly ProjectFile[];
    readonly limits: VerificationLimits;
    readonly commandPolicy: { readonly allowedCommands: readonly string[] };
  }): Promise<VerificationSession>;
  execute(
    session: VerificationSession,
    command: { readonly command: string; readonly args: readonly string[] },
    limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  ): Promise<RawExecution>;
  /** Best-effort stop of the running command, for cancellation. */
  terminate?(session: VerificationSession): Promise<void>;
}

/** Source of project files for a revision. */
export interface ProjectFileSource {
  read(input: {
    readonly projectId: string;
    readonly revision: string | null;
  }): Promise<{ readonly files: readonly ProjectFile[]; readonly revision: string | null }>;
}
