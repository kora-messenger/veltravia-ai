/**
 * Runtime types - Step 17 (Preview / App Runtime).
 *
 * A preview runtime is a BOUNDED, REVISION-BOUND execution context for a
 * project workspace: it prepares/builds the project and serves a preview
 * through a platform-controlled URL. This module is provider-neutral data
 * model + contract only - no execution, no host access, no vendor SDKs.
 *
 * Honesty rule: every runtime carries an `isolationLevel` reported by the
 * executor behind the boundary. A simulated (mock) runtime MUST identify
 * itself as `simulated`; only a genuinely isolated adapter may claim
 * `isolated`. Nothing in this layer may claim OS isolation it does not
 * have.
 */

export type RuntimeId = string;
export type PreviewToken = string;

/** Supported runtime type taxonomy. */
export const RUNTIME_TYPES = ['web', 'fullstack', 'backend', 'mobile-preview'] as const;
export type RuntimeType = (typeof RUNTIME_TYPES)[number];

/**
 * Which runtime types are actually ACTIVE. Step 17 activates web +
 * fullstack (both map to supported generation templates). `backend` and
 * `mobile-preview` are declared for the taxonomy but INACTIVE: requesting
 * them fails with a typed unsupported error.
 */
export const ACTIVE_RUNTIME_TYPES: readonly RuntimeType[] = ['web', 'fullstack'];

/** Runtime lifecycle states (validated - illegal transitions throw). */
export const RUNTIME_STATES = [
  'created',
  'preparing',
  'building',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
  'expired',
  'cancelled',
] as const;
export type RuntimeStatus = (typeof RUNTIME_STATES)[number];

/** Health states a started runtime can report. Bounded - never a poll loop. */
export const RUNTIME_HEALTH_STATES = [
  'starting',
  'healthy',
  'unhealthy',
  'stopped',
  'failed',
] as const;
export type RuntimeHealthStatus = (typeof RUNTIME_HEALTH_STATES)[number];

/** Structured command - executable + arguments. Shell strings do not exist here. */
export interface RuntimeCommand {
  /** Allowlisted executable name - path-free, no shell metacharacters. */
  readonly executable: string;
  readonly arguments: readonly string[];
  /** Optional workspace-relative working directory (never a host path). */
  readonly workingDirectory?: string;
  /** Inert description for logs/humans - never executed. */
  readonly label?: string;
}

/** One health check definition - bounded attempts, bounded timeout. */
export interface RuntimeHealthCheck {
  /** Relative path the gateway probes (e.g. "/"). */
  readonly path: string;
  /** Milliseconds between bounded checks while starting. */
  readonly intervalMs: number;
  /** Per-check timeout. */
  readonly timeoutMs: number;
  /** HARD ceiling on checks before the runtime is marked failed. */
  readonly maxChecks: number;
}

/**
 * Explicit environment entries for the runtime. Values are validated against
 * secret shapes and REJECTED when credential-shaped. Host environment is
 * NEVER inherited (see executor contract). Connector tokens never appear
 * here - the runtime layer has no connector surface at all.
 */
export type RuntimeEnvironment = Readonly<Record<string, string>>;

/** Bounded resource limits for one runtime. Never unlimited. */
export interface RuntimeLimits {
  /** Wall-clock ceiling for the preparation+build phase. */
  readonly buildTimeoutMs: number;
  /** Wall-clock ceiling for startup (including bounded health checks). */
  readonly startTimeoutMs: number;
  /** Maximum runtime lifetime in milliseconds (hard expiry). */
  readonly maxLifetimeMs: number;
  /** Idle timeout: a runtime with no interaction for this long expires. */
  readonly idleTimeoutMs: number;
  /** Peak memory allowance in megabytes (requested of the executor). */
  readonly maxMemoryMb: number;
  /** Disk allowance in megabytes (requested of the executor). */
  readonly maxDiskMb: number;
  /** Combined runtime log capture allowance in bytes (hard truncation). */
  readonly maxLogBytes: number;
}

/** The typed runtime plan - how a specific workspace revision is previewed. */
export interface RuntimePlan {
  readonly runtimeType: RuntimeType;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Workspace revision this plan (and any runtime from it) is pinned to. */
  readonly expectedRevision: number;
  /** Required workspace-relative files that must exist before build. */
  readonly requiredFiles: readonly string[];
  /** Build command, executed FIRST. Optional for pure-start projects. */
  readonly buildCommand: RuntimeCommand | null;
  /** Start command that serves the preview. Always present. */
  readonly startCommand: RuntimeCommand;
  /** The single preview port the plan is allowed to expose (1-65535). */
  readonly port: number;
  /** Explicit, validated, non-secret environment entries. */
  readonly environment: RuntimeEnvironment;
  readonly healthCheck: RuntimeHealthCheck;
  readonly limits: RuntimeLimits;
  /** Human-readable evidence of HOW the plan was derived (paths + scripts only). */
  readonly evidence: readonly string[];
}

/** One structured runtime log line. Application output is UNTRUSTED DATA. */
export interface RuntimeLogEntry {
  readonly timestamp: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly phase: 'prepare' | 'build' | 'start' | 'health' | 'run' | 'stop' | 'expire';
  readonly message: string;
}

/** Failure kinds the runtime layer can report (typed, scrubbed). */
export const RUNTIME_FAILURE_KINDS = [
  'build_failed',
  'missing_dependency',
  'invalid_command',
  'start_failed',
  'port_conflict',
  'health_failed',
  'start_timeout',
  'resource_exhausted',
  'executor_error',
] as const;
export type RuntimeFailureKind = (typeof RUNTIME_FAILURE_KINDS)[number];

/** Structured, scrubbed failure report attached to a failed runtime. */
export interface RuntimeFailure {
  readonly kind: RuntimeFailureKind;
  readonly phase: 'build' | 'start' | 'health' | 'run';
  /** Bounded, scrubbed description - no infrastructure internals. */
  readonly message: string;
  /** Workspace-relative paths implicated (bounded, metadata only). */
  readonly affectedPaths: readonly string[];
}

/** The stored runtime record. Immutable except for validated transitions. */
export interface RuntimeRecord {
  readonly runtimeId: RuntimeId;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Workspace revision this runtime is bound to. */
  readonly revision: number;
  readonly status: RuntimeStatus;
  readonly runtimeType: RuntimeType;
  readonly plan: RuntimePlan;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  /** Hard expiry timestamp derived from createdAt + maxLifetimeMs. */
  readonly expiresAt: string;
  /** Platform-controlled preview URL (opaque runtime id only). */
  readonly previewUrl: string | null;
  /** Last health report, when a runtime has started at least once. */
  readonly lastHealth: RuntimeHealthStatus | null;
  /** Structured failure report when status === 'failed'. */
  readonly failure: RuntimeFailure | null;
  /** Honest isolation level reported by the executor (never self-upgraded). */
  readonly isolationLevel: 'simulated' | 'isolated';
  /** Executor identity, e.g. "mock-runtime" or a future "container-runtime". */
  readonly executorId: string;
}

/** Normalized runtime view returned by the manager/API (safe fields only). */
export interface RuntimeView {
  readonly runtimeId: RuntimeId;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: RuntimeStatus;
  readonly runtimeType: RuntimeType;
  readonly isolationLevel: 'simulated' | 'isolated';
  readonly executorId: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly expiresAt: string;
  readonly previewUrl: string | null;
  readonly lastHealth: RuntimeHealthStatus | null;
  readonly failure: RuntimeFailure | null;
  /** Current workspace revision - lets clients see staleness honestly. */
  readonly currentRevision: number;
  /** True when the workspace has moved past this runtime's revision. */
  readonly stale: boolean;
  /** Runtime plan summary - commands as declared, ports, limits. */
  readonly plan: RuntimePlan;
}

/** Options for RuntimeManager.create. */
export interface CreateRuntimeInput {
  readonly workspaceId: string;
  /**
   * Optional explicit runtime type. When omitted it is DETECTED from the
   * workspace evidence (manifest scripts, framework detections, files).
   */
  readonly runtimeType?: RuntimeType;
  /**
   * Override the simulated executor behavior (mock scenarios). Real
   * executors ignore this. Allows deterministic failure QA.
   */
  readonly scenario?: string;
}
