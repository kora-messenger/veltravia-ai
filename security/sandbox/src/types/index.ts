/**
 * Sandbox types - Step 8.
 *
 * The sandbox is the security-first execution abstraction: untrusted code
 * and project commands are NEVER executed in the API host process. This
 * module defines the provider-neutral data model only - no execution, no
 * host access, no vendor SDKs.
 */

export type SandboxId = string;
export type ExecutionId = string;

/** Sandbox lifecycle states (validated - illegal transitions throw). */
export const SANDBOX_STATUSES = [
  'creating',
  'ready',
  'running',
  'stopping',
  'stopped',
  'failed',
  'expired',
  'destroyed',
] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/** Execution states. `stopping` is only entered by cancellation. */
export const EXECUTION_STATUSES = [
  'running',
  'stopping',
  'completed',
  'failed',
  'timed_out',
  'terminated',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TERMINATION_REASONS = [
  'cancelled',
  'memory',
  'cpu',
  'processes',
  'output',
  'file_size',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * Hard resource limits for one execution. Every value is explicit and
 * validated: zero/negative/absurd values are rejected at validation time.
 */
export interface ResourceLimits {
  /** Wall-clock kill deadline. The runtime must terminate on breach. */
  readonly timeoutMs: number;
  /** Peak memory allowance in megabytes. */
  readonly maxMemoryMb: number;
  /** CPU time allowance in milliseconds. */
  readonly maxCpuTimeMs: number;
  /** Combined stdout+stderr capture allowance in bytes (hard truncation). */
  readonly maxOutputBytes: number;
  /** Maximum simultaneous child processes. */
  readonly maxProcesses: number;
  /** Maximum bytes a single execution may write to the workspace. */
  readonly maxFileBytes: number;
}

/** Per-execution limit overrides (all optional; bounded by hard ceilings). */
export type ResourceLimitOverrides = Partial<ResourceLimits>;

/**
 * Whether a limit is actually enforced by the runtime, merely requested, or
 * not available. A mock runtime must NEVER claim OS-level enforcement it
 * does not have.
 */
export type ResourceControlState = 'enforced' | 'requested' | 'unavailable';

/** Honest, per-limit enforcement report produced by the runtime. */
export type ResourceEnforcement = Readonly<Record<keyof ResourceLimits, ResourceControlState>>;

/** Normalized resource usage of one execution. */
export interface ResourceUsage {
  readonly cpuTimeMs: number;
  readonly memoryPeakMb: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly processCount: number;
  readonly fileBytesWritten: number;
}

/**
 * Command policy: an ALLOWLIST of executables (registration of a command
 * grants nothing else), plus a hard denylist that always wins, and an
 * explicitly-reviewed shell flag that Step 8 never enables.
 */
export interface CommandPolicy {
  /** Allowed executable names - exact, path-free names only. */
  readonly allowedCommands: readonly string[];
  /**
   * Shell interpreters (sh/bash/zsh/cmd/powershell/pwsh) are denied unless
   * this is true AND the command is explicitly allowlisted. Step 8 APIs and
   * profiles never enable it; a future shell feature requires a separate
   * reviewed policy.
   */
  readonly allowShellExecution: boolean;
}

/** One explicitly declared network destination (allowlist mode only). */
export interface NetworkDestination {
  /** Exact hostname, or `*.domain` for a subdomain group. No URLs, no IPs schemes. */
  readonly host: string;
  /** Optional destination port (1-65535). */
  readonly port?: number;
}

/**
 * Network policy. Default is `disabled` - the sandbox must NOT reach the
 * internet. Unrestricted internet access does not exist as a policy state.
 */
export interface NetworkPolicy {
  readonly mode: 'disabled' | 'allowlist';
  /** Required non-empty in `allowlist` mode; ignored (must be empty) in `disabled`. */
  readonly allowedDestinations: readonly NetworkDestination[];
}

/** The full security profile pinned to a sandbox at creation time. */
export interface SandboxProfile {
  readonly commandPolicy: CommandPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly defaultLimits: ResourceLimits;
  /** Minimal environment entries every execution receives (names + values validated). */
  readonly defaultEnvironment: Readonly<Record<string, string>>;
}

/** Immutable sandbox record. Policy and limits can never change after creation. */
export interface SandboxRecord {
  readonly id: SandboxId;
  /** Opaque workspace reference (a Project Engine workspace id) - never a host path. */
  readonly workspaceRef: string;
  readonly status: SandboxStatus;
  readonly profile: SandboxProfile;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** TTL - the sandbox must not live forever. */
  readonly expiresAt: string;
  /** Most recent execution id, if any. */
  readonly lastExecutionId: ExecutionId | null;
}

/** Structured execution request - no shell strings, no host paths, no host env. */
export interface SandboxExecutionRequest {
  /** Executable name (exact, allowlisted). */
  readonly command: string;
  /** Arguments array - passed through WITHOUT a shell, never interpreted. */
  readonly arguments: readonly string[];
  /** Workspace-relative working directory (never absolute, never traversal). */
  readonly workingDirectory?: string;
  /** Explicit environment entries ONLY - the host environment is never inherited. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Optional per-execution limit overrides bounded by hard ceilings. */
  readonly limits?: ResourceLimitOverrides;
}

/** The request the manager hands to the runtime - fully resolved and validated. */
export interface RuntimeExecutionRequest {
  readonly executionId: ExecutionId;
  readonly sandboxId: SandboxId;
  readonly workspaceRef: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly limits: ResourceLimits;
  readonly networkPolicy: NetworkPolicy;
}

/** Normalized runtime outcome - safe data only (no host internals). */
export interface RuntimeExecutionOutcome {
  /** Process exit code, or null when the process never completed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly terminated: boolean;
  readonly terminationReason: TerminationReason | null;
  readonly truncated: boolean;
  readonly resourceUsage: ResourceUsage;
  /** Honest per-limit enforcement report. Mocks must not claim OS enforcement. */
  readonly enforcement: ResourceEnforcement;
}

/** Fully normalized, scrubbed, bounded execution result. */
export interface SandboxExecutionResult extends RuntimeExecutionOutcome {
  readonly executionId: ExecutionId;
  readonly sandboxId: SandboxId;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Number of secret-shaped fragments scrubbed from stdout/stderr. */
  readonly scrubbedCount: number;
}

/** Persistent execution record. Arguments are stored scrubbed. */
export interface SandboxExecutionRecord {
  readonly id: ExecutionId;
  readonly sandboxId: SandboxId;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: SandboxExecutionResult | null;
}

/** Sandbox permissions - granted ONLY via the Tool System, never by the sandbox. */
export const SANDBOX_PERMISSIONS = [
  'sandbox.create',
  'sandbox.execute',
  'sandbox.stop',
  'sandbox.destroy',
] as const;
export type SandboxPermission = (typeof SANDBOX_PERMISSIONS)[number];
