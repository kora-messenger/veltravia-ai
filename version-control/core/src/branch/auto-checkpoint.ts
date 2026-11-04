import type { ChangeProfile, CheckpointDecision, CheckpointTrigger } from './types.js';

/**
 * When a change earns an automatic checkpoint.
 *
 * A checkpoint costs a stored snapshot and a line in the history, so taking one
 * before every small edit would bury the ones that matter. Three kinds of
 * change are worth one, and the rest are not:
 *
 *  - an AI change that touches several files at once,
 *  - a refactor of existing code,
 *  - a destructive operation a person has approved.
 *
 * Restoring is handled separately: it ALWAYS takes one (see the manager).
 *
 * Pure on purpose: no clock, no store. The same profile gives the same answer,
 * and the reason is written for the history so a person can see why.
 */
export const AUTO_CHECKPOINT_POLICY = {
  /** An AI change touching at least this many files is "multi-file". */
  multiFileThreshold: 3,
} as const;

function decision(
  take: boolean,
  trigger: CheckpointTrigger | null,
  reason: string,
): CheckpointDecision {
  return { take, trigger, reason };
}

export function decideAutomaticCheckpoint(
  profile: ChangeProfile,
  policy: { readonly multiFileThreshold: number } = AUTO_CHECKPOINT_POLICY,
): CheckpointDecision {
  // A destructive operation outranks everything: it is the one that cannot be
  // undone by editing, so it always gets a checkpoint.
  if (profile.destructiveApproved || profile.filesDeleted > 0) {
    return decision(
      true,
      'before_destructive',
      profile.filesDeleted > 0
        ? `Removes ${profile.filesDeleted} file${profile.filesDeleted === 1 ? '' : 's'}.`
        : 'An approved destructive operation.',
    );
  }
  if (profile.isRefactor) {
    return decision(true, 'before_refactor', 'Restructures existing code.');
  }
  if (profile.filesAffected >= policy.multiFileThreshold) {
    return decision(true, 'before_ai_change', `Changes ${profile.filesAffected} files at once.`);
  }
  return decision(
    false,
    null,
    profile.filesAffected === 0
      ? 'Nothing to change.'
      : `A small change (${profile.filesAffected} file${profile.filesAffected === 1 ? '' : 's'}); no checkpoint needed.`,
  );
}
