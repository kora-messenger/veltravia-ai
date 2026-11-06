import { describe, expect, it } from 'vitest';

import { contentSha } from './hash.js';
import { buildPlan, type PlanInput } from './planner.js';
import type { RemoteFile } from './ports.js';

const FAKE_KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3';

const local = (files: Record<string, string>) =>
  Object.entries(files).map(([path, content]) => ({ path, content }));
const remote = (files: Record<string, string>): RemoteFile[] =>
  Object.entries(files).map(([path, content]) => ({
    path,
    hashOfText: contentSha(content),
    size: content.length,
    notText: null,
  }));
const base = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([p, c]) => [p, contentSha(c)]));

function plan(over: Partial<PlanInput> & Pick<PlanInput, 'local' | 'remote'>) {
  return buildPlan({ base: null, branchIsDefault: false, remoteSkippedCount: 0, ...over });
}

describe('initial sync', () => {
  it('pushes everything into an empty repository and asks for approval', () => {
    const p = plan({ local: local({ 'a.ts': 'a', 'src/b.ts': 'b' }), remote: [] });
    expect(p.mode).toBe('initial');
    expect(p.push.map((c) => `${c.kind}:${c.path}`)).toEqual(['add:a.ts', 'add:src/b.ts']);
    expect(p.approvalReasons).toEqual(['first-sync']);
    expect(p.conflicts).toEqual([]);
  });

  it('flags existing remote content and plans to pull what the project lacks', () => {
    const p = plan({ local: local({ 'a.ts': 'a' }), remote: remote({ 'README.md': '# hi' }) });
    expect(p.approvalReasons).toEqual(['first-sync', 'remote-has-content']);
    expect(p.pull.map((c) => c.path)).toEqual(['README.md']);
    expect(p.push.map((c) => c.path)).toEqual(['a.ts']);
  });

  it('is a conflict, never an overwrite, when both sides have the same path differently', () => {
    const p = plan({ local: local({ 'a.ts': 'mine' }), remote: remote({ 'a.ts': 'theirs' }) });
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]).toMatchObject({ path: 'a.ts', kind: 'both-added' });
    expect(p.push).toEqual([]);
    expect(p.pull).toEqual([]);
  });

  it('treats identical files on both sides as in sync, not as a change', () => {
    const p = plan({ local: local({ 'a.ts': 'same' }), remote: remote({ 'a.ts': 'same' }) });
    expect(p.push).toEqual([]);
    expect(p.pull).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.unchanged).toBe(1);
  });
});

describe('later syncs', () => {
  const agreed = { 'keep.ts': 'k', 'edit.ts': 'old', 'gone.ts': 'g' };

  it('pushes local adds, edits and deletes', () => {
    const p = plan({
      base: base(agreed),
      local: local({ 'keep.ts': 'k', 'edit.ts': 'new', 'fresh.ts': 'f' }),
      remote: remote(agreed),
    });
    expect(p.mode).toBe('update');
    expect(p.push.map((c) => `${c.kind}:${c.path}`)).toEqual(
      ['delete:gone.ts', 'modify:edit.ts', 'add:fresh.ts'].sort((a, b) =>
        a.split(':')[1]!.localeCompare(b.split(':')[1]!),
      ),
    );
    expect(p.approvalReasons).toContain('deletes-remote-files');
    expect(p.approvalReasons).not.toContain('first-sync');
  });

  it('pulls remote adds, edits and deletes', () => {
    const p = plan({
      base: base(agreed),
      local: local(agreed),
      remote: remote({ 'keep.ts': 'k', 'edit.ts': 'theirs', 'new.ts': 'n' }),
    });
    expect(p.pull.map((c) => `${c.kind}:${c.path}`).sort()).toEqual([
      'add:new.ts',
      'delete:gone.ts',
      'modify:edit.ts',
    ]);
    expect(p.push).toEqual([]);
    // Pulling touches only the project, so it needs no remote approval.
    expect(p.approvalReasons).toEqual([]);
  });

  it('does both at once when different files changed on each side', () => {
    const p = plan({
      base: base(agreed),
      local: local({ ...agreed, 'edit.ts': 'mine' }),
      remote: remote({ ...agreed, 'gone.ts': 'theirs' }),
    });
    expect(p.push.map((c) => c.path)).toEqual(['edit.ts']);
    expect(p.pull.map((c) => c.path)).toEqual(['gone.ts']);
    expect(p.conflicts).toEqual([]);
  });

  it('reports nothing to do when nothing changed', () => {
    const p = plan({ base: base(agreed), local: local(agreed), remote: remote(agreed) });
    expect(p.push).toEqual([]);
    expect(p.pull).toEqual([]);
    expect(p.unchanged).toBe(3);
    expect(p.approvalReasons).toEqual([]);
  });

  it('asks for approval to write to the default branch', () => {
    const p = plan({
      base: base(agreed),
      local: local({ ...agreed, 'edit.ts': 'new' }),
      remote: remote(agreed),
      branchIsDefault: true,
    });
    expect(p.approvalReasons).toEqual(['default-branch']);
  });
});

describe('conflicts', () => {
  const agreed = { 'f.ts': 'old' };
  const kinds = (p: ReturnType<typeof plan>) => p.conflicts.map((c) => c.kind);

  it('both modified', () => {
    const p = plan({
      base: base(agreed),
      local: local({ 'f.ts': 'L' }),
      remote: remote({ 'f.ts': 'R' }),
    });
    expect(kinds(p)).toEqual(['both-modified']);
  });

  it('local deleted, remote modified', () => {
    const p = plan({ base: base(agreed), local: [], remote: remote({ 'f.ts': 'R' }) });
    expect(kinds(p)).toEqual(['local-deleted-remote-modified']);
    expect(p.push).toEqual([]);
  });

  it('remote deleted, local modified', () => {
    const p = plan({ base: base(agreed), local: local({ 'f.ts': 'L' }), remote: [] });
    expect(kinds(p)).toEqual(['remote-deleted-local-modified']);
    expect(p.pull).toEqual([]);
  });

  it('carries all three hashes and a plain sentence', () => {
    const p = plan({
      base: base(agreed),
      local: local({ 'f.ts': 'L' }),
      remote: remote({ 'f.ts': 'R' }),
    });
    expect(p.conflicts[0]).toMatchObject({
      localHash: contentSha('L'),
      remoteHash: contentSha('R'),
      baseHash: contentSha('old'),
    });
    expect(p.conflicts[0]?.summary).toMatch(/both sides/);
  });

  it('a conflict on one file does not stop the others from planning', () => {
    const p = plan({
      base: base({ ...agreed, 'g.ts': 'g' }),
      local: local({ 'f.ts': 'L', 'g.ts': 'g2' }),
      remote: remote({ 'f.ts': 'R', 'g.ts': 'g' }),
    });
    expect(kinds(p)).toEqual(['both-modified']);
    expect(p.push.map((c) => c.path)).toEqual(['g.ts']);
  });
});

describe('renames', () => {
  it('turns one delete plus one add of identical content into a rename', () => {
    const p = plan({
      base: base({ 'old.ts': 'content', 'x.ts': 'x' }),
      local: local({ 'new.ts': 'content', 'x.ts': 'x' }),
      remote: remote({ 'old.ts': 'content', 'x.ts': 'x' }),
    });
    expect(p.push).toEqual([
      { kind: 'rename', path: 'new.ts', fromPath: 'old.ts', hash: contentSha('content'), size: 7 },
    ]);
    expect(p.approvalReasons).toContain('deletes-remote-files');
  });

  it('leaves an ambiguous move as a plain delete and add', () => {
    const p = plan({
      base: base({ 'a.ts': 'same', 'b.ts': 'same' }),
      local: local({ 'c.ts': 'same' }),
      remote: remote({ 'a.ts': 'same', 'b.ts': 'same' }),
    });
    expect(p.push.map((c) => c.kind).sort()).toEqual(['add', 'delete', 'delete']);
  });
});

describe('secrets and credential files never cross', () => {
  it('does not push a credential file or a secret-bearing file', () => {
    const p = plan({
      local: local({
        '.env': 'A=1',
        'keys/server.pem': 'x',
        'src/leak.ts': `export const t = "${FAKE_KEY}";`,
        'src/ok.ts': 'export const ok = 1;',
      }),
      remote: [],
    });
    expect(p.push.map((c) => c.path)).toEqual(['src/ok.ts']);
    const reasons = Object.fromEntries(p.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toEqual({
      '.env': 'credential-file',
      'keys/server.pem': 'credential-file',
      'src/leak.ts': 'secret-in-content',
    });
    expect(p.skipped.every((s) => s.side === 'local')).toBe(true);
  });

  it('never puts a secret value into the plan', () => {
    const p = plan({
      local: local({ 'src/leak.ts': `export const t = "${FAKE_KEY}";` }),
      remote: [],
    });
    expect(JSON.stringify(p.skipped)).not.toContain(FAKE_KEY);
    expect(JSON.stringify([...p.localHashes])).not.toContain(FAKE_KEY);
  });

  it('does not read a withheld local file as deleted, so the remote copy is not removed', () => {
    // .env was synced once by an older version; locally it is now withheld.
    const p = plan({
      base: base({ '.env': 'A=1', 'a.ts': 'a' }),
      local: local({ '.env': 'A=1', 'a.ts': 'a' }),
      remote: remote({ '.env': 'A=1', 'a.ts': 'a' }),
    });
    expect(p.push.find((c) => c.path === '.env')).toBeUndefined();
    expect(p.push.some((c) => c.kind === 'delete')).toBe(false);
  });

  it('does not delete the remote copy of a file that is only withheld locally', () => {
    // The file synced fine once. Now its LOCAL content contains a key, so it is
    // withheld locally; the remote copy is unchanged and still participates.
    // Reading "withheld" as "deleted" would push a deletion of the remote file.
    const clean = 'export const token = process.env.TOKEN;';
    const p = plan({
      base: base({ 'src/config.ts': clean, 'a.ts': 'a' }),
      local: local({ 'src/config.ts': `export const t = "${FAKE_KEY}";`, 'a.ts': 'a' }),
      remote: remote({ 'src/config.ts': clean, 'a.ts': 'a' }),
    });
    expect(p.push.find((c) => c.path === 'src/config.ts')).toBeUndefined();
    expect(p.push.some((c) => c.kind === 'delete')).toBe(false);
    expect(p.conflicts).toEqual([]);
    expect(p.skipped).toEqual([
      expect.objectContaining({
        path: 'src/config.ts',
        side: 'local',
        reason: 'secret-in-content',
      }),
    ]);
  });

  it('never pulls a credential file from the remote', () => {
    const p = plan({ local: [], remote: remote({ '.env': 'REMOTE=1', 'ok.ts': 'ok' }) });
    expect(p.pull.map((c) => c.path)).toEqual(['ok.ts']);
    expect(p.skipped).toEqual([
      expect.objectContaining({ path: '.env', side: 'remote', reason: 'credential-file' }),
    ]);
  });

  it('does not read a withheld remote file as remotely deleted', () => {
    const p = plan({
      base: base({ '.env': 'A=1', 'a.ts': 'a' }),
      local: local({ 'a.ts': 'a' }),
      remote: remote({ '.env': 'CHANGED=1', 'a.ts': 'a' }),
    });
    expect(p.conflicts).toEqual([]);
    expect(p.pull).toEqual([]);
    expect(p.push).toEqual([]);
  });
});

describe('untrusted remote content', () => {
  it.each(['../../etc/passwd', '/etc/passwd', 'a//b', 'a\\b', '.', 'dir/..', 'a/./b'])(
    'skips the unsafe remote path %j',
    (path) => {
      const p = plan({ local: [], remote: remote({ [path]: 'x', 'ok.ts': 'ok' }) });
      expect(p.pull.map((c) => c.path)).toEqual(['ok.ts']);
      expect(p.skipped.some((s) => s.side === 'remote')).toBe(true);
    },
  );

  it('leaves a remote binary file exactly as it is', () => {
    const p = plan({
      base: base({ 'logo.png': 'old' }),
      local: [],
      remote: [{ path: 'logo.png', hashOfText: null, size: 9, notText: 'binary' }],
    });
    // Not "deleted locally", not pulled, not a conflict.
    expect(p.pull).toEqual([]);
    expect(p.push).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.skipped).toEqual([expect.objectContaining({ path: 'logo.png', reason: 'not-text' })]);
  });

  it('skips paths that differ only by letter case', () => {
    const p = plan({ local: [], remote: remote({ 'README.md': 'a', 'readme.md': 'b' }) });
    expect(p.pull).toHaveLength(1);
    expect(p.skipped).toHaveLength(1);
  });

  it('reports links and submodules it did not touch', () => {
    const p = plan({ local: [], remote: [], remoteSkippedCount: 3 });
    expect(p.skipped[0]).toMatchObject({ reason: 'not-a-file' });
  });

  it('treats an unsafe remote path as data: never echoes control characters', () => {
    const p = plan({ local: [], remote: remote({ 'a\u0000b': 'x' }) });
    expect(JSON.stringify(p.skipped)).not.toContain('\u0000');
  });
});
