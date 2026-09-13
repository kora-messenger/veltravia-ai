/**
 * SandboxRuntime - the isolation-boundary ADAPTER interface.
 *
 * The SandboxManager never executes commands itself; it hands fully
 * validated, bounded requests to a runtime behind this interface. The API
 * server is NEVER the runtime. Implementations:
 *
 *   - MockSandboxRuntime (Step 8, `@veltravia/sandbox-mock`): deterministic,
 *     offline, executes NO host code - development and CI only. It is NOT
 *     a secure production sandbox and provides NO OS-level isolation.
 *   - Future production runtime: a hardened boundary (container, microVM,
 *     or dedicated worker) implementing the same interface.
 *
 * Runtime contract (every implementation MUST honor it):
 *   - execute the structured command WITHOUT a shell (no sh -c / bash -c /
 *     cmd /c / powershell -Command)
 *   - honor timeoutMs: terminate the work, report timedOut=true
 *   - honor maxOutputBytes: bound capture, report truncated=true
 *   - detect and report limit violations (terminated=true + reason)
 *   - start from the provided environment ONLY - never inherit the host's
 *   - confine all filesystem access to the assigned workspace
 *   - report enforcement states HONESTLY (never claim OS-level enforcement
 *     that does not exist)
 */

import type { RuntimeExecutionRequest, RuntimeExecutionOutcome } from '../types/index.js';

export interface SandboxRuntime {
  /** Runtime identifier (e.g. "mock", "container", "microvm"). */
  readonly runtimeId: string;
  /**
   * True when this runtime provides REAL OS-level isolation (separate
   * kernel namespaces, cgroups, seccomp/AppArmor, non-root user). The mock
   * MUST report false.
   */
  readonly providesOsIsolation: boolean;
  /** Executes one fully-validated request. The ONLY execution path. */
  execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionOutcome>;
  /**
   * Best-effort termination of an in-flight execution. Called by the manager
   * on cancellation, sandbox stop, expiry, and destroy. Implementations
   * must be idempotent and must not orphan work.
   */
  terminate(executionId: string): Promise<void>;
  /** Releases every resource tied to a sandbox (called on destroy). */
  cleanup(sandboxId: string): Promise<void>;
}
