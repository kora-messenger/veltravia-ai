import type { Checkpoint, ProjectRevision, RevisionSource } from '../types/index.js';
import type { Branch, ChangeActor, HistoryEntry } from './types.js';

/**
 * Who made a revision. The revision's source says how it came about, and the
 * source is the only reliable signal: a name typed into `createdBy` is just a
 * label, so it is never used to decide whether a change was the agent's.
 */
const AI_SOURCES: ReadonlySet<RevisionSource> = new Set([
  'generation_before',
  'generation_after',
  'testing_before_repair',
  'testing_after',
  'coding_before',
  'coding_after',
]);

export function actorOf(source: RevisionSource): ChangeActor {
  if (AI_SOURCES.has(source)) return 'ai-agent';
  if (source === 'rollback') return 'system';
  return 'user';
}

const SOURCE_WORDS: Readonly<Record<RevisionSource, string>> = {
  manual: 'Saved a version',
  generation_before: 'Before generating the app',
  generation_after: 'After generating the app',
  testing_before_repair: 'Before repairing a test failure',
  testing_after: 'After testing',
  coding_before: 'Before the coding agent changed files',
  coding_after: 'After the coding agent changed files',
  artifact_publish: 'Published an artifact',
  rollback: 'Restored an earlier version',
};

function changeTypeOf(revision: ProjectRevision, isFirst: boolean): HistoryEntry['changeType'] {
  if (revision.source === 'rollback') return 'restore';
  if (isFirst) return revision.message?.startsWith('Branch "') ? 'branch' : 'initial';
  if (actorOf(revision.source) === 'ai-agent') return 'ai-change';
  if (revision.message?.startsWith('Checkpoint:')) return 'checkpoint';
  return 'edit';
}

/**
 * Turns one branch's revisions (newest first, as the store returns them) into
 * display entries. The last item of the list is the branch's first revision.
 */
export function buildHistory(
  branch: Pick<Branch, 'id' | 'name'>,
  revisions: readonly ProjectRevision[],
  checkpoints: readonly Checkpoint[],
): HistoryEntry[] {
  const byRevision = new Map<string, Checkpoint[]>();
  for (const checkpoint of checkpoints) {
    const list = byRevision.get(checkpoint.revisionId) ?? [];
    list.push(checkpoint);
    byRevision.set(checkpoint.revisionId, list);
  }
  return revisions.map((revision, index) => {
    const isFirst = index === revisions.length - 1;
    const pinned = byRevision.get(revision.id) ?? [];
    return {
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      branchId: branch.id,
      branchName: branch.name,
      description: revision.message ?? SOURCE_WORDS[revision.source],
      createdAt: revision.createdAt,
      actor: actorOf(revision.source),
      author: revision.createdBy,
      changeType: changeTypeOf(revision, isFirst),
      filesChanged: revision.change.total,
      added: revision.change.added,
      modified: revision.change.modified,
      deleted: revision.change.deleted,
      checkpointIds: pinned.map((c) => c.id),
      checkpointNames: pinned.map((c) => c.name),
      source: revision.source,
    };
  });
}
