/**
 * RuntimeExecutor - the preview isolation-boundary ADAPTER interface
 * (Step 17).
 *
 * The RuntimeManager never builds or serves anything itself: it hands
 * validated, bounded requests to an executor behind this interface. The
 * API server is NEVER the runtime. Implementations:
 *
 *   - MockRuntimeExecutor (Step 17, `@veltravia/runtime-mock`): deterministic,
 *     simulated runtime. Builds/starts NOTHING, serves no real OS process,
 *     and reports `isolationLevel: "simulated"`. Development/CI only.
 *   - Future IsolatedRuntimeExecutor: a hardened boundary (container,
 *     microVM, or dedicated worker) that REALLY executes the plan's
 *     structured commands with OS-level limits and serves the declared
 *     port through a controlled gateway. Same interface; nothing else
 *     changes.
 *
 * Executor contract (every implementation MUST honor it):
 *   - execute the plan's structured commands WITHOUT a shell
 *   - never inherit the host environment - the plan environment is the
 *     complete environment (platform secrets and connector tokens are
 *     absent by construction: the runtime layer has no credential surface)
 *   - confine all file access to the bound project workspace
 *   - enforce the plan's limits honestly (report `enforced`, `requested`,
 *     or `unavailable` per limit - never claim enforcement that does not exist)
 *   - expose ONLY the declared preview port through the gateway
 *   - treat application output as untrusted data (bounded, scrubbed)
 *   - never let application output mutate executor behavior
 *   - support one-way cancellation of a starting/running preview
 */

import type {
  RuntimeCommand,
  RuntimeFailureKind,
  RuntimeHealthStatus,
  RuntimeLimits,
  RuntimePlan,
} from '../types/index.js';

/** Bounded log line the executor emits about build/start progress. */
export interface ExecutorLogLine {
  readonly level: 'info' | 'warning' | 'error';
  readonly phase: 'prepare' | 'build' | 'start' | 'health' | 'run';
  readonly message: string;
}

/** Result of a bounded build phase. */
export interface ExecutorBuildResult {
  readonly ok: boolean;
  readonly failureKind: Extract<
    RuntimeFailureKind,
    | 'build_failed'
    | 'missing_dependency'
    | 'invalid_command'
    | 'resource_exhausted'
    | 'executor_error'
  > | null;
  readonly message: string;
  readonly logs: readonly ExecutorLogLine[];
  readonly durationMs: number;
}

/** Result of a bounded start phase (process launched, health pending). */
export interface ExecutorStartResult {
  readonly ok: boolean;
  readonly failureKind: Extract<
    RuntimeFailureKind,
    'start_failed' | 'port_conflict' | 'invalid_command' | 'resource_exhausted' | 'executor_error'
  > | null;
  readonly message: string;
  readonly logs: readonly ExecutorLogLine[];
  /** Opaque token the gateway needs to route the preview (never a host port). */
  readonly previewToken: string | null;
}

/** Bounded health report after start. */
export interface ExecutorHealthReport {
  readonly status: RuntimeHealthStatus;
  readonly message: string;
}

/** Per-limit enforcement honesty, mirroring the sandbox runtime contract. */
export type RuntimeResourceControlState = 'enforced' | 'requested' | 'unavailable';
export type RuntimeResourceEnforcement = Readonly<
  Record<keyof RuntimeLimits, RuntimeResourceControlState>
>;

/** The runtime the executor hosts - exactly one preview target. */
export interface ExecutorRuntimeHandle {
  readonly runtimeId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly plan: RuntimePlan;
  /** Simulated behavior selector (mock scenarios). Real executors may ignore. */
  readonly scenario?: string;
}

export interface RuntimeExecutor {
  /** Executor identity, surfaced in every runtime record (honesty first). */
  readonly executorId: string;
  /** MUST be 'simulated' for mock executors; only a real isolation boundary may claim 'isolated'. */
  readonly isolationLevel: 'simulated' | 'isolated';
  /** Honest per-limit enforcement report. */
  readonly enforcement: RuntimeResourceEnforcement;

  /** Run the plan's bounded build phase. Never a shell. */
  build(handle: ExecutorRuntimeHandle): Promise<ExecutorBuildResult>;

  /** Launch the start command and return the preview token. */
  start(handle: ExecutorRuntimeHandle): Promise<ExecutorStartResult>;

  /** One bounded health probe of a started preview. */
  health(handle: ExecutorRuntimeHandle): Promise<ExecutorHealthReport>;

  /** Preview content for the platform-controlled preview route. UNTRUSTED rendering surface. */
  previewContent(handle: ExecutorRuntimeHandle, meta: PreviewContentMeta): string;

  /** Stop a started preview (idempotent; unknown handles resolve silently). */
  stop(handle: ExecutorRuntimeHandle): Promise<void>;

  /** Whether a handle is currently hosted (used by cleanup + expiry). */
  isHosting(handle: ExecutorRuntimeHandle): boolean;
}

/** Bounded, validated metadata the preview page may render. */
export interface PreviewContentMeta {
  readonly projectName: string;
  readonly isolationLevel: 'simulated' | 'isolated';
  readonly executorId: string;
}

/** Command the executor will be asked to run - structured, no shell strings. */
export type { RuntimeCommand };
