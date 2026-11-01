import { describe, expect, it } from 'vitest';

import { SourceError } from '../errors/index.js';
import { compareManifests } from '../snapshot/index.js';
import { buildManifest, contentHashOf, InMemoryContentStore } from '../store/index.js';
import { FakeProjectsPort, FakeTreePort } from './fakes.js';
import { assertSafeSourcePath, SourceRepositoryManager } from './index.js';

function setup(seed: Record<string, string> = { 'src/index.ts': 'export const a = 1;\n' }) {
  const tree = new FakeTreePort();
  tree.seed(seed);
  const projects = new FakeProjectsPort(
    new Map([
      ['prj_a', { ownerRef: 'owner-a', workspaceId: 'ws_a' }],
      ['prj_b', { ownerRef: 'owner-b', workspaceId: 'ws_b' }],
    ]),
  );
  let counter = 0;
  const manager = new SourceRepositoryManager({
    projects,
    tree,
    store: new InMemoryContentStore(),
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    generateId: () => `id_${(counter += 1)}`,
  });
  return { tree, manager, projects };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe(code);
  }
}

describe('path safety', () => {
  it('accepts ordinary project paths', () => {
    expect(assertSafeSourcePath('src/app/main.ts')).toBe('src/app/main.ts');
    expect(assertSafeSourcePath('README.md')).toBe('README.md');
  });

  it('rejects traversal, absolute paths and separators that escape', () => {
    for (const path of [
      '../secrets',
      'src/../../etc/passwd',
      '/etc/passwd',
      'C:\\keys',
      'src//main.ts',
      'src/',
    ]) {
      expect(() => assertSafeSourcePath(path)).toThrow(SourceError);
    }
  });

  it('refuses credential file names outright', () => {
    expect(() => assertSafeSourcePath('.env')).toThrow(/credentials/i);
    expect(() => assertSafeSourcePath('config/id_rsa')).toThrow(SourceError);
  });
});

describe('repository reads', () => {
  it('lists files and directories with hashes', async () => {
    const { manager } = setup({ 'src/index.ts': 'x', 'README.md': 'y' });
    const tree = await manager.tree('owner-a', { projectId: 'prj_a' });
    expect(tree.files.map((file) => file.path)).toEqual(['src/index.ts', 'README.md']);
    expect(tree.directories).toEqual(['src']);
    expect(tree.files[0]?.contentHash).toBe(contentHashOf('x'));
    expect(tree.totals).toEqual({ files: 2, bytes: 2 });
  });

  it('reads a file with its revision and hash', async () => {
    const { manager } = setup({ 'src/index.ts': 'hello' });
    const file = await manager.readFile('owner-a', { projectId: 'prj_a', path: 'src/index.ts' });
    expect(file.content).toBe('hello');
    expect(file.revision).toBe(1);
    expect(file.truncated).toBe(false);
  });

  it('hides another owner’s repository instead of confirming it exists', async () => {
    const { manager } = setup();
    await expectCode(
      manager.tree('owner-b', { projectId: 'prj_a' }),
      'SOURCE_REPOSITORY_NOT_FOUND',
    );
    await expectCode(
      manager.readFile('owner-b', { projectId: 'prj_a', path: 'src/index.ts' }),
      'SOURCE_REPOSITORY_NOT_FOUND',
    );
  });

  it('refuses a missing file and a bad path', async () => {
    const { manager } = setup();
    await expectCode(
      manager.readFile('owner-a', { projectId: 'prj_a', path: 'nope.ts' }),
      'SOURCE_PATH_NOT_FOUND',
    );
    await expectCode(
      manager.readFile('owner-a', { projectId: 'prj_a', path: '../x' }),
      'SOURCE_PATH_INVALID',
    );
  });
});

describe('writes', () => {
  it('creates, updates, renames, moves and deletes through one change set', async () => {
    const { manager, tree } = setup();
    await manager.createDirectory('owner-a', { projectId: 'prj_a', path: 'docs' });
    await manager.createFile('owner-a', {
      projectId: 'prj_a',
      path: 'docs/guide.md',
      content: '# Guide',
    });
    const read = await manager.readFile('owner-a', { projectId: 'prj_a', path: 'docs/guide.md' });
    await manager.updateFile('owner-a', {
      projectId: 'prj_a',
      path: 'docs/guide.md',
      content: '# Guide v2',
      expectedRevision: read.revision,
    });
    const result = await manager.changeSet('owner-a', {
      projectId: 'prj_a',
      operations: [
        { op: 'rename', path: 'docs/guide.md', newName: 'handbook.md' },
        { op: 'move', fromPath: 'docs/handbook.md', toDirectory: '' },
        { op: 'delete', path: 'src/index.ts' },
      ],
    });
    expect(result.applied).toBe(3);
    expect(tree.snapshotPaths()).toEqual(['handbook.md']);
    expect(tree.readContent('handbook.md')).toBe('# Guide v2');
  });

  it('rejects a stale revision rather than overwriting', async () => {
    const { manager } = setup();
    await expectCode(
      manager.updateFile('owner-a', {
        projectId: 'prj_a',
        path: 'src/index.ts',
        content: 'changed',
        expectedRevision: 99,
      }),
      'SOURCE_REVISION_CONFLICT',
    );
  });

  it('rejects credentials in content', async () => {
    const { manager } = setup();
    await expectCode(
      manager.createFile('owner-a', {
        projectId: 'prj_a',
        path: 'src/key.ts',
        content: 'const token = "ghp_abcdefghijklmnopqrstuvwxyz01";',
      }),
      'SOURCE_SECRET_REJECTED',
    );
  });

  it('refuses a create over an existing file', async () => {
    const { manager } = setup();
    await expectCode(
      manager.createFile('owner-a', { projectId: 'prj_a', path: 'src/index.ts', content: 'x' }),
      'SOURCE_PATH_CONFLICT',
    );
  });
});

describe('atomic change sets', () => {
  it('applies nothing when any operation is invalid', async () => {
    const { manager, tree } = setup();
    await expectCode(
      manager.changeSet('owner-a', {
        projectId: 'prj_a',
        operations: [
          { op: 'create', path: 'a.ts', content: 'a' },
          { op: 'update', path: 'src/index.ts', content: 'b', expectedRevision: 99 },
        ],
      }),
      'SOURCE_REVISION_CONFLICT',
    );
    expect(tree.snapshotPaths()).toEqual(['src/index.ts']);
  });

  it('rolls back earlier writes when a later write fails', async () => {
    const { manager, tree } = setup();
    tree.failOn = 'b.ts';
    await expectCode(
      manager.changeSet('owner-a', {
        projectId: 'prj_a',
        operations: [
          { op: 'create', path: 'a.ts', content: 'a' },
          { op: 'create', path: 'b.ts', content: 'b' },
        ],
      }),
      'SOURCE_CHANGE_SET_FAILED',
    );
    expect(tree.snapshotPaths()).toEqual(['src/index.ts']);
  });

  it('refuses the same path twice in one change set', async () => {
    const { manager } = setup();
    await expectCode(
      manager.changeSet('owner-a', {
        projectId: 'prj_a',
        operations: [
          { op: 'create', path: 'a.ts', content: 'a' },
          { op: 'delete', path: 'a.ts' },
        ],
      }),
      'SOURCE_INVALID_REQUEST',
    );
  });
});

describe('history', () => {
  it('records source writes with their actor', async () => {
    const { manager } = setup();
    await manager.createFile('owner-a', { projectId: 'prj_a', path: 'notes.md', content: 'n' });
    const history = await manager.history('owner-a', { projectId: 'prj_a' });
    expect(history.entries[0]?.path).toBe('notes.md');
    expect(history.entries[0]?.actor).toBe('source-api');
    expect(history.summary.kinds.created).toBe(1);
  });

  it('attributes changes made outside the source API', async () => {
    const { manager, tree } = setup();
    await manager.tree('owner-a', { projectId: 'prj_a' }); // establish baseline
    tree.seed({ 'agent-file.ts': 'written by the coding agent' });
    const history = await manager.history('owner-a', { projectId: 'prj_a' });
    const entry = history.entries.find((item) => item.path === 'agent-file.ts');
    expect(entry?.actor).toBe('external-writer');
    expect(entry?.changeKind).toBe('created');
  });
});

describe('snapshots', () => {
  it('captures a manifest that can be listed and compared', async () => {
    const { manager } = setup({ 'a.ts': 'one', 'b.ts': 'two' });
    const first = await manager.createSnapshot('owner-a', {
      projectId: 'prj_a',
      label: 'Before edits',
    });
    expect(first.files).toBe(2);
    expect(first.bytes).toBe(6);

    await manager.createFile('owner-a', { projectId: 'prj_a', path: 'c.ts', content: 'three' });
    const second = await manager.createSnapshot('owner-a', {
      projectId: 'prj_a',
      label: 'After edits',
    });

    const comparison = await manager.compareSnapshots('owner-a', {
      projectId: 'prj_a',
      fromSnapshotId: first.id,
      toSnapshotId: second.id,
    });
    expect(comparison.added.map((item) => item.path)).toEqual(['c.ts']);
    expect(comparison.summary).toContain('1 added');
  });

  it('restores a snapshot exactly and snapshots the state it replaced', async () => {
    const { manager, tree } = setup({ 'a.ts': 'one' });
    const snapshot = await manager.createSnapshot('owner-a', {
      projectId: 'prj_a',
      label: 'Known good',
    });
    await manager.createFile('owner-a', { projectId: 'prj_a', path: 'later.ts', content: 'later' });

    const restore = await manager.restoreSnapshot('owner-a', {
      projectId: 'prj_a',
      snapshotId: snapshot.id,
    });
    expect(restore.deleted).toBe(1);
    expect(tree.snapshotPaths()).toEqual(['a.ts']);
    expect(restore.preRestoreSnapshotId).not.toBe(snapshot.id);
  });

  it('keeps a repository’s snapshots owner-scoped', async () => {
    const { manager } = setup();
    const snapshot = await manager.createSnapshot('owner-a', { projectId: 'prj_a' });
    await expectCode(
      manager.getSnapshot('owner-b', { projectId: 'prj_a', snapshotId: snapshot.id }),
      'SOURCE_REPOSITORY_NOT_FOUND',
    );
  });

  it('compares a snapshot with the live tree through "current"', async () => {
    const { manager } = setup({});
    const ownerRef = 'owner-a';
    const scope = { projectId: 'prj_a' };
    await manager.changeSet(ownerRef, {
      ...scope,
      operations: [{ op: 'create', path: 'a.ts', content: 'one\n' }],
    });
    const snapshot = await manager.createSnapshot(ownerRef, { ...scope, label: 'before' });

    const node = await manager.readFile(ownerRef, { ...scope, path: 'a.ts' });
    await manager.changeSet(ownerRef, {
      ...scope,
      operations: [
        { op: 'update', path: 'a.ts', content: 'two\n', expectedRevision: node.revision },
        { op: 'create', path: 'b.ts', content: 'new\n' },
      ],
    });

    const comparison = await manager.compareSnapshots(ownerRef, {
      ...scope,
      fromSnapshotId: snapshot.id,
      toSnapshotId: 'current',
    });
    expect(comparison.to).toBe('current');
    expect(comparison.modified.map((entry) => entry.path)).toEqual(['a.ts']);
    expect(comparison.added.map((entry) => entry.path)).toEqual(['b.ts']);
    expect(comparison.removed).toEqual([]);
  });

  it('reports a missing snapshot honestly', async () => {
    const { manager } = setup();
    await expectCode(
      manager.getSnapshot('owner-a', { projectId: 'prj_a', snapshotId: 'nope' }),
      'SOURCE_SNAPSHOT_NOT_FOUND',
    );
  });
});

describe('manifests and storage', () => {
  it('produces a deterministic manifest hash for the same tree', async () => {
    const { manager } = setup({ 'a.ts': 'one', 'b.ts': 'two' });
    const first = await manager.manifest('owner-a', { projectId: 'prj_a' });
    const second = await manager.manifest('owner-a', { projectId: 'prj_a' });
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('changes the manifest hash when one byte changes', () => {
    const base = buildManifest([{ path: 'a.ts', contentHash: contentHashOf('one'), size: 3 }]);
    const changed = buildManifest([{ path: 'a.ts', contentHash: contentHashOf('one!'), size: 4 }]);
    expect(base.hash).not.toBe(changed.hash);
  });

  it('reports the store as non-durable development storage', async () => {
    const { manager } = setup();
    const storage = manager.storage();
    expect(storage.content).toMatchObject({ implementation: 'in-memory', durable: false });
  });
});

describe('manifest comparison', () => {
  it('sorts results and counts unchanged files', () => {
    const comparison = compareManifests(
      'a',
      [
        { path: 'b.ts', contentHash: 'h1', size: 1 },
        { path: 'a.ts', contentHash: 'h2', size: 1 },
      ],
      'b',
      [
        { path: 'b.ts', contentHash: 'h1', size: 1 },
        { path: 'a.ts', contentHash: 'h3', size: 2 },
      ],
    );
    expect(comparison.unchanged).toBe(1);
    expect(comparison.modified[0]?.path).toBe('a.ts');
    expect(comparison.summary).toContain('1 modified');
  });
});
