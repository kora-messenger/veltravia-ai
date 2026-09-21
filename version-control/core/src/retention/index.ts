/**
 * Bounded retention (Step 18).
 *
 * History is NOT infinite by default. Retention evicts the oldest
 * retention-eligible revisions when a workspace exceeds its caps, and a
 * revision that is still referenced by a checkpoint or an unfinished
 * rollback operation is NEVER evicted (rollback guarantees survive).
 */

export interface RetentionPolicy {
  /** Max revision records kept per workspace. */
  readonly maxRevisionsPerWorkspace: number;
  /** Max checkpoints kept per workspace. */
  readonly maxCheckpointsPerWorkspace: number;
  /** Approximate max snapshot bytes kept per workspace. */
  readonly maxSnapshotBytesPerWorkspace: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxRevisionsPerWorkspace: 50,
  maxCheckpointsPerWorkspace: 20,
  maxSnapshotBytesPerWorkspace: 10 * 1024 * 1024,
};

/** Hard ceilings - a deployment can never disable retention entirely. */
export const RETENTION_CEILINGS = {
  maxRevisionsPerWorkspace: 500,
  maxCheckpointsPerWorkspace: 100,
  maxSnapshotBytesPerWorkspace: 256 * 1024 * 1024,
} as const;

export function clampPolicy(policy: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    maxRevisionsPerWorkspace: Math.min(
      Math.max(
        policy.maxRevisionsPerWorkspace ?? DEFAULT_RETENTION_POLICY.maxRevisionsPerWorkspace,
        1,
      ),
      RETENTION_CEILINGS.maxRevisionsPerWorkspace,
    ),
    maxCheckpointsPerWorkspace: Math.min(
      Math.max(
        policy.maxCheckpointsPerWorkspace ?? DEFAULT_RETENTION_POLICY.maxCheckpointsPerWorkspace,
        1,
      ),
      RETENTION_CEILINGS.maxCheckpointsPerWorkspace,
    ),
    maxSnapshotBytesPerWorkspace: Math.min(
      Math.max(
        policy.maxSnapshotBytesPerWorkspace ??
          DEFAULT_RETENTION_POLICY.maxSnapshotBytesPerWorkspace,
        1024,
      ),
      RETENTION_CEILINGS.maxSnapshotBytesPerWorkspace,
    ),
  };
}
