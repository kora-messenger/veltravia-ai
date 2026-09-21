import type { VersionControlManager } from '@veltravia/version-core';

/**
 * Route-level auto-capture hooks (Step 18).
 *
 * Every mutation run (coding, generation, testing) is bracketed by revision
 * captures taken from the ROUTE layer, where the project/workspace pair has
 * already been validated server-side. Captures are BEST-EFFORT observability:
 * a capture failure NEVER fails the run it brackets - it is recorded in the
 * version audit trail and the run proceeds (honest limitation, documented).
 */

export interface RunCaptureHooks {
  readonly version?: VersionControlManager;
}

/** Captures a `*_before` revision. Best-effort: failures never throw. */
export async function captureRunStart(
  hooks: RunCaptureHooks,
  source: 'coding_before' | 'generation_before' | 'testing_before_repair',
  projectId: string,
  workspaceId: string,
): Promise<void> {
  if (hooks.version === undefined) return;
  try {
    await hooks.version.captureRevision({ projectId, workspaceId, source, message: null });
  } catch {
    // Observation only: the run proceeds.
  }
}

/** Captures an `*_after` revision when the run view reached a terminal state. */
export async function captureRunEnd(
  hooks: RunCaptureHooks,
  source: 'coding_after' | 'generation_after' | 'testing_after',
  projectId: string,
  workspaceId: string,
  state: string,
): Promise<void> {
  if (hooks.version === undefined) return;
  if (state !== 'completed' && state !== 'failed') return;
  try {
    await hooks.version.captureRevision({
      projectId,
      workspaceId,
      source,
      message: state === 'completed' ? null : 'run failed',
    });
  } catch {
    // Observation only.
  }
}
