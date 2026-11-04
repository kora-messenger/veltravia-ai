import { describe, expect, it } from 'vitest';

import {
  AUTO_CHECKPOINT_POLICY,
  actorOf,
  buildHistory,
  decideAutomaticCheckpoint,
  type Checkpoint,
  type ProjectRevision,
} from '@veltravia/version-core';

const profile = (over: Partial<Parameters<typeof decideAutomaticCheckpoint>[0]> = {}) => ({
  filesAffected: 1,
  filesDeleted: 0,
  destructiveApproved: false,
  isRefactor: false,
  ...over,
});

describe('when an automatic checkpoint is taken', () => {
  it('does not take one for a small change', () => {
    const d = decideAutomaticCheckpoint(profile({ filesAffected: 1 }));
    expect(d.take).toBe(false);
    expect(d.trigger).toBeNull();
    expect(d.reason).toContain('no checkpoint needed');
  });

  it('does not take one when nothing changes', () => {
    expect(decideAutomaticCheckpoint(profile({ filesAffected: 0 })).take).toBe(false);
  });

  it('stays quiet just under the multi-file threshold, then takes one at it', () => {
    const t = AUTO_CHECKPOINT_POLICY.multiFileThreshold;
    expect(decideAutomaticCheckpoint(profile({ filesAffected: t - 1 })).take).toBe(false);
    const at = decideAutomaticCheckpoint(profile({ filesAffected: t }));
    expect(at.take).toBe(true);
    expect(at.trigger).toBe('before_ai_change');
  });

  it('takes one before a refactor, even of a single file', () => {
    const d = decideAutomaticCheckpoint(profile({ filesAffected: 1, isRefactor: true }));
    expect(d.take).toBe(true);
    expect(d.trigger).toBe('before_refactor');
  });

  it('takes one before any change that removes a file', () => {
    const d = decideAutomaticCheckpoint(profile({ filesAffected: 1, filesDeleted: 1 }));
    expect(d.take).toBe(true);
    expect(d.trigger).toBe('before_destructive');
    expect(d.reason).toBe('Removes 1 file.');
  });

  it('takes one before an approved destructive operation', () => {
    const d = decideAutomaticCheckpoint(profile({ destructiveApproved: true }));
    expect(d.trigger).toBe('before_destructive');
  });

  it('puts the destructive reason first when several apply', () => {
    const d = decideAutomaticCheckpoint(
      profile({ filesAffected: 9, isRefactor: true, filesDeleted: 2 }),
    );
    expect(d.trigger).toBe('before_destructive');
    expect(d.reason).toBe('Removes 2 files.');
  });

  it('gives the same answer every time for the same facts', () => {
    const p = profile({ filesAffected: 5 });
    expect(decideAutomaticCheckpoint(p)).toEqual(decideAutomaticCheckpoint(p));
  });

  it('accepts a different threshold', () => {
    expect(
      decideAutomaticCheckpoint(profile({ filesAffected: 2 }), { multiFileThreshold: 2 }).take,
    ).toBe(true);
  });
});

const revision = (over: Partial<ProjectRevision>): ProjectRevision => ({
  id: 'r',
  projectId: 'p',
  workspaceId: 'w',
  revisionNumber: 1,
  parentRevisionId: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  createdBy: 'api',
  source: 'manual',
  status: 'active',
  change: { added: 0, modified: 0, deleted: 0, total: 0 },
  fileCount: 0,
  totalBytes: 0,
  manifestHash: 'h',
  message: null,
  restoredFromRevisionId: null,
  ...over,
});

describe('who made a change', () => {
  it.each([
    ['coding_before', 'ai-agent'],
    ['coding_after', 'ai-agent'],
    ['generation_after', 'ai-agent'],
    ['testing_after', 'ai-agent'],
    ['manual', 'user'],
    ['artifact_publish', 'user'],
    ['rollback', 'system'],
  ] as const)('%s is by %s', (source, who) => {
    expect(actorOf(source)).toBe(who);
  });

  it('decides from the source, not from a name someone typed into createdBy', () => {
    const [entry] = buildHistory(
      { id: 'b', name: 'main' },
      [revision({ source: 'manual', createdBy: 'ai-agent' })],
      [],
    );
    expect(entry?.actor).toBe('user');
  });
});

describe('building the history', () => {
  const checkpoint = (over: Partial<Checkpoint>): Checkpoint => ({
    id: 'c1',
    projectId: 'p',
    workspaceId: 'w',
    revisionId: 'r2',
    name: 'Before login',
    description: null,
    createdAt: '2026-11-04T10:00:00.000Z',
    createdBy: 'api',
    ...over,
  });

  const newestFirst = [
    revision({
      id: 'r3',
      revisionNumber: 3,
      source: 'rollback',
      message: 'Rollback to revision 1',
      change: { added: 0, modified: 2, deleted: 0, total: 2 },
    }),
    revision({
      id: 'r2',
      revisionNumber: 2,
      source: 'coding_after',
      createdBy: 'run-7',
      change: { added: 1, modified: 1, deleted: 1, total: 3 },
    }),
    revision({ id: 'r1', revisionNumber: 1, message: 'Branch "x" created from "main"' }),
  ];

  const entries = buildHistory({ id: 'b1', name: 'x' }, newestFirst, [checkpoint({})]);

  it('keeps the newest-first order and labels the branch', () => {
    expect(entries.map((e) => e.revisionNumber)).toEqual([3, 2, 1]);
    expect(entries.every((e) => e.branchName === 'x' && e.branchId === 'b1')).toBe(true);
  });

  it('tells a restore, an agent change and a new branch apart', () => {
    expect(entries.map((e) => e.changeType)).toEqual(['restore', 'ai-change', 'branch']);
    expect(entries.map((e) => e.actor)).toEqual(['system', 'ai-agent', 'user']);
  });

  it('carries the file counts', () => {
    expect(entries[1]).toMatchObject({ filesChanged: 3, added: 1, modified: 1, deleted: 1 });
  });

  it('attaches the checkpoint that pins a revision', () => {
    expect(entries[1]?.checkpointNames).toEqual(['Before login']);
    expect(entries[0]?.checkpointNames).toEqual([]);
  });

  it('describes a revision with no message in plain words', () => {
    expect(entries[1]?.description).toBe('After the coding agent changed files');
  });

  it('names the author from the revision', () => {
    expect(entries[1]?.author).toBe('run-7');
  });
});
