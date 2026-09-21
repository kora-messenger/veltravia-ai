import { describe, expect, it } from 'vitest';

import { InMemoryRevisionStore } from '@veltravia/version-mock';

import {
  CorruptedSnapshotError,
  ForeignProjectRevisionError,
  ForeignWorkspaceRevisionError,
  InvalidRollbackTargetError,
  OperationAlreadyResolvedError,
  RevisionConflictError,
  RestoreVerificationError,
  RevisionNotFoundError,
  SecretRejectedVersionError,
  VersionControlManager,
  VersionError,
  type GatewayNode,
  type RestoreStep,
  type VersionWorkspaceGateway,
  type VersionAuditEvent,
} from './index.js';

/**
 * A fully controllable fake gateway: an in-memory tree the tests mutate
 * directly, with revision bumping on every restore (like the Project
 * Engine bumps workspace revisions on every mutation).
 */
class FakeGateway implements VersionWorkspaceGateway {
  public nodes: Map<string, GatewayNode> = new Map();
  public revision = 0;
  public applyRestoreCalls: RestoreStep[][] = [];
  public failApply = false;
  private readonly projectIds = new Set(['p1']);

  setFile(path: string, content: string): void {
    this.nodes.set(path, { path, type: 'file', size: content.length, content });
    this.revision += 1;
  }

  setDirectory(path: string): void {
    this.nodes.set(path, { path, type: 'directory', size: 0, content: null });
    this.revision += 1;
  }

  delete(path: string): void {
    this.nodes.delete(path);
    this.revision += 1;
  }

  async getWorkspace(workspaceId: string): Promise<{
    projectId: string;
    workspaceId: string;
    revision: number;
    status: string;
  }> {
    if (workspaceId !== 'w1') {
      throw new VersionError(
        'VERSION_WORKSPACE_NOT_FOUND',
        `Workspace "${workspaceId}" was not found.`,
      );
    }
    return { projectId: 'p1', workspaceId: 'w1', revision: this.revision, status: 'active' };
  }

  async listNodes(workspaceId: string): Promise<readonly GatewayNode[]> {
    if (workspaceId !== 'w1') {
      throw new VersionError(
        'VERSION_WORKSPACE_NOT_FOUND',
        `Workspace "${workspaceId}" was not found.`,
      );
    }
    return [...this.nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async applyRestore(workspaceId: string, steps: readonly RestoreStep[]): Promise<void> {
    if (workspaceId !== 'w1') {
      throw new VersionError(
        'VERSION_WORKSPACE_NOT_FOUND',
        `Workspace "${workspaceId}" was not found.`,
      );
    }
    if (this.failApply)
      throw new VersionError('VERSION_VALIDATION_FAILED', 'restore refused by gateway');
    this.applyRestoreCalls.push([...steps]);
    for (const step of steps) {
      if (step.kind === 'create_directory' || step.kind === 'delete_directory') {
        if (step.kind === 'create_directory') {
          this.nodes.set(step.path, { path: step.path, type: 'directory', size: 0, content: null });
        } else {
          this.nodes.delete(step.path);
        }
        continue;
      }
      if (step.kind === 'delete_file') {
        this.nodes.delete(step.path);
        continue;
      }
      this.nodes.set(step.path, {
        path: step.path,
        type: 'file',
        size: step.content.length,
        content: step.content,
      });
    }
    if (steps.length > 0) this.revision += 1;
  }
}

interface Harness {
  manager: VersionControlManager;
  gateway: FakeGateway;
  store: InMemoryRevisionStore;
  events: VersionAuditEvent[];
}

function harness(options?: { maxRevisions?: number }): Harness {
  const gateway = new FakeGateway();
  const store = new InMemoryRevisionStore();
  const events: VersionAuditEvent[] = [];
  const manager = new VersionControlManager({
    store,
    gateway,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    generateId: (() => {
      let counter = 0;
      return () => `id-${(counter += 1)}`;
    })(),
    auditSink: (event) => events.push(event),
    policy: options?.maxRevisions ? { maxRevisionsPerWorkspace: options.maxRevisions } : undefined,
  });
  return { manager, gateway, store, events };
}

describe('revision capture', () => {
  it('captures the first revision with everything added', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'alpha');
    const revision = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
      message: 'initial',
    });
    expect(revision.fileCount).toBe(1);
    expect(revision.change).toEqual({ added: 1, modified: 0, deleted: 0, total: 1 });
    expect(revision.parentRevisionId).toBeNull();
    expect(revision.source).toBe('manual');
    expect(h.events.some((e) => e.type === 'revision_created')).toBe(true);
  });

  it('creates sequential revisions with parent lineage and change counts', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'alpha');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    h.gateway.setFile('a.txt', 'alpha-beta');
    h.gateway.setFile('b.txt', 'bravo');
    const second = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    expect(second.parentRevisionId).toBe(first.id);
    expect(second.change).toEqual({ added: 1, modified: 1, deleted: 0, total: 2 });
    const latest = await h.manager.getLatestRevision('p1', 'w1');
    expect(latest?.id).toBe(second.id);
  });

  it('rejects capture of a workspace with secret-shaped file content (fail closed)', async () => {
    const h = harness();
    h.gateway.setFile('notes.txt', 'sk-abcdefghijklmnopqrstuvwx');
    await expect(
      h.manager.captureRevision({ projectId: 'p1', workspaceId: 'w1', source: 'manual' }),
    ).rejects.toThrow(SecretRejectedVersionError);
    expect(await h.manager.getLatestRevision('p1', 'w1')).toBeNull();
  });

  it('rejects cross-project capture', async () => {
    const h = harness();
    await expect(
      h.manager.captureRevision({ projectId: 'other', workspaceId: 'w1', source: 'manual' }),
    ).rejects.toThrow(ForeignProjectRevisionError);
  });

  it('rejects secret-shaped messages', async () => {
    const h = harness();
    await expect(
      h.manager.captureRevision({
        projectId: 'p1',
        workspaceId: 'w1',
        source: 'manual',
        message: 'sk-abcdefghijklmnopqrstuvwx',
      }),
    ).rejects.toThrow(SecretRejectedVersionError);
  });

  it('reconstructs the tree from a snapshot', async () => {
    const h = harness();
    h.gateway.setDirectory('src');
    h.gateway.setFile('src/main.ts', 'export {};');
    const revision = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    const comparison = await h.manager.getRevisionDiff('p1', 'w1', revision.id);
    // First revision: everything added, directory excluded from line detail.
    expect(comparison.added).toBe(1);
    expect(comparison.files.map((file) => file.path)).toEqual(['src/main.ts']);
  });
});

describe('diff engine via manager', () => {
  it('detects added, modified, deleted, and unchanged files with line detail', async () => {
    const h = harness();
    h.gateway.setFile('keep.txt', 'kept\n');
    h.gateway.setFile('gone.txt', 'goodbye\n');
    h.gateway.setFile('same.txt', 'identical\n');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    h.gateway.delete('gone.txt');
    h.gateway.setFile('keep.txt', 'kept\nchanged\n');
    h.gateway.setFile('new.txt', 'arrived\n');
    const second = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });

    const comparison = await h.manager.compareRevisions('p1', 'w1', first.id, second.id);
    expect(comparison.added).toBe(1);
    expect(comparison.modified).toBe(1);
    expect(comparison.deleted).toBe(1);
    expect(comparison.unchanged).toBe(1);
    const modifiedFile = comparison.files.find((file) => file.path === 'keep.txt');
    expect(modifiedFile?.kind).toBe('modified');
    expect(modifiedFile?.lines.map((line) => `${line.kind}:${line.text}`)).toContain('add:changed');
    expect(modifiedFile?.lines.map((line) => `${line.kind}:${line.text}`)).toContain(
      'context:kept',
    );
  });

  it('detects renames by identical content', async () => {
    const h = harness();
    h.gateway.setFile('old-name.txt', 'same content\n');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    h.gateway.delete('old-name.txt');
    h.gateway.setFile('new-name.txt', 'same content\n');
    const second = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    const comparison = await h.manager.compareRevisions('p1', 'w1', first.id, second.id);
    expect(comparison.renamed).toBe(1);
    const renamed = comparison.files.find((file) => file.kind === 'renamed');
    expect(renamed?.previousPath).toBe('old-name.txt');
  });

  it('never produces line detail for binary-like content', async () => {
    const h = harness();
    h.gateway.setFile('blob.bin', 'ok');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    h.gateway.setFile('blob.bin', 'ok\u0000binary');
    const second = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    const comparison = await h.manager.compareRevisions('p1', 'w1', first.id, second.id);
    const file = comparison.files.find((entry) => entry.path === 'blob.bin');
    expect(file?.binary).toBe(true);
    expect(file?.lines).toHaveLength(0);
  });

  it('truncates very large diffs', async () => {
    const h = harness();
    h.gateway.setFile('big.txt', 'x\n');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    for (let index = 0; index < 300; index += 1) {
      h.gateway.setFile(`file-${index}.txt`, `content ${index}\n`);
    }
    const second = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    const comparison = await h.manager.compareRevisions('p1', 'w1', first.id, second.id);
    expect(comparison.filesTruncated).toBe(true);
    expect(comparison.files.length).toBeLessThanOrEqual(200);
  });

  it('rejects cross-project and cross-workspace diff access', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'a');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    await expect(h.manager.getRevisionDiff('p2', 'w1', first.id)).rejects.toThrow(
      ForeignProjectRevisionError,
    );
    await expect(h.manager.getRevision('p1', 'w1', 'missing')).rejects.toThrow(
      RevisionNotFoundError,
    );
    // Foreign workspace mismatch: same project, different workspace filter.
    await expect(h.manager.getRevision('p1', 'w-other', first.id)).rejects.toThrow(
      ForeignWorkspaceRevisionError,
    );
  });
});

describe('checkpoints', () => {
  it('creates, lists, retrieves, and deletes checkpoints', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'a');
    const checkpoint = await h.manager.createCheckpoint({
      projectId: 'p1',
      workspaceId: 'w1',
      name: 'Stable Version',
      description: 'before refactor',
    });
    expect(checkpoint.name).toBe('Stable Version');
    const listed = await h.manager.listCheckpoints('p1', 'w1');
    expect(listed).toHaveLength(1);
    const fetched = await h.manager.getCheckpoint('p1', 'w1', checkpoint.id);
    expect(fetched.id).toBe(checkpoint.id);
    await h.manager.deleteCheckpoint('p1', 'w1', checkpoint.id);
    expect(await h.manager.listCheckpoints('p1', 'w1')).toHaveLength(0);
  });

  it('pins an existing revision or captures a fresh one', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'a');
    const revision = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    const pinned = await h.manager.createCheckpoint({
      projectId: 'p1',
      workspaceId: 'w1',
      revisionId: revision.id,
      name: 'pin',
    });
    expect(pinned.revisionId).toBe(revision.id);
    const fresh = await h.manager.createCheckpoint({
      projectId: 'p1',
      workspaceId: 'w1',
      name: 'now',
    });
    expect(fresh.revisionId).not.toBe(revision.id);
  });

  it('rejects a checkpoint pinning a revision from another project', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'a');
    const revision = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    await expect(
      h.manager.createCheckpoint({
        projectId: 'p2',
        workspaceId: 'w1',
        revisionId: revision.id,
        name: 'steal',
      }),
    ).rejects.toThrow(ForeignProjectRevisionError);
  });

  it('rejects missing names and secret-shaped names', async () => {
    const h = harness();
    await expect(
      h.manager.createCheckpoint({ projectId: 'p1', workspaceId: 'w1', name: '  ' }),
    ).rejects.toThrow(VersionError);
    await expect(
      h.manager.createCheckpoint({
        projectId: 'p1',
        workspaceId: 'w1',
        name: 'sk-abcdefghijklmnopqrstuvwx',
      }),
    ).rejects.toThrow(SecretRejectedVersionError);
  });
});

describe('rollback', () => {
  async function seeded(h: Harness): Promise<{
    first: string;
    second: string;
    third: string;
  }> {
    h.gateway.setFile('a.txt', 'one');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
      message: 'v1',
    });
    h.gateway.setFile('a.txt', 'two');
    h.gateway.setFile('extra.txt', 'extra');
    const second = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
      message: 'v2',
    });
    h.gateway.setFile('a.txt', 'three');
    const third = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
      message: 'v3',
    });
    return { first: first.id, second: second.id, third: third.id };
  }

  it('rolls back to an earlier revision by creating a NEW revision and keeping history', async () => {
    const h = harness();
    const { first, third } = await seeded(h);
    const currentRevisionBefore = h.gateway.revision;
    const result = await h.manager.executeRollback({
      projectId: 'p1',
      workspaceId: 'w1',
      targetRevisionId: first,
      expectedCurrentRevision: currentRevisionBefore,
      reason: 'undo experiment',
    });
    // The tree matches the FIRST revision's state.
    expect(h.gateway.nodes.get('a.txt')?.content).toBe('one');
    expect(h.gateway.nodes.has('extra.txt')).toBe(false);
    // A NEW revision record was created; old ones remain.
    expect(result.restoredFromRevisionId).toBe(first);
    expect(result.newRevisionId).not.toBe(first);
    const history = await h.manager.listRevisions('p1', 'w1', 50, 0);
    expect(history.total).toBe(4);
    expect(history.revisions[0].source).toBe('rollback');
    expect(history.revisions[0].restoredFromRevisionId).toBe(first);
    // Historical revisions remain retrievable.
    const old = await h.manager.getRevision('p1', 'w1', third);
    expect(old.id).toBe(third);
  });

  it('refuses rollback when the current revision moved (concurrency)', async () => {
    const h = harness();
    const { first } = await seeded(h);
    await expect(
      h.manager.executeRollback({
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: first,
        expectedCurrentRevision: h.gateway.revision + 5,
        reason: null,
      }),
    ).rejects.toThrow(RevisionConflictError);
    expect(h.events.some((event) => event.type === 'revision_conflict')).toBe(true);
  });

  it('refuses rollback to the latest revision (no-op)', async () => {
    const h = harness();
    const { third } = await seeded(h);
    await expect(
      h.manager.validateRollbackTarget({
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: third,
        expectedCurrentRevision: h.gateway.revision,
        reason: null,
      }),
    ).rejects.toThrow(InvalidRollbackTargetError);
  });

  it('refuses rollback when the target snapshot is corrupted (fail closed)', async () => {
    const h = harness();
    const { first } = await seeded(h);
    const snapshot = await h.store.getSnapshot(first);
    if (snapshot === null) throw new Error('snapshot missing');
    // Corrupt the manifest: flip one content hash.
    (snapshot as unknown as { nodes: { contentHash: string }[] }).nodes[0].contentHash = 'deadbeef';
    await expect(
      h.manager.executeRollback({
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: first,
        expectedCurrentRevision: h.gateway.revision,
        reason: null,
      }),
    ).rejects.toThrow(CorruptedSnapshotError);
    expect(h.events.some((event) => event.type === 'integrity_failure')).toBe(true);
  });

  it('fails closed when the restored tree does not match (gateway misbehaves)', async () => {
    const h = harness();
    const { first } = await seeded(h);
    // Sabotage the gateway: apply only part of the restore.
    const original = h.gateway.applyRestore.bind(h.gateway);
    h.gateway.applyRestore = async (workspaceId, steps) => {
      await original(workspaceId, steps.slice(0, 1));
    };
    await expect(
      h.manager.executeRollback({
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: first,
        expectedCurrentRevision: h.gateway.revision,
        reason: null,
      }),
    ).rejects.toThrow(RestoreVerificationError);
  });

  it('rolls back across directories with correct step ordering', async () => {
    const h = harness();
    h.gateway.setDirectory('src');
    h.gateway.setFile('src/app.ts', 'export {}');
    h.gateway.setFile('readme.md', 'hello');
    const first = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    h.gateway.delete('src/app.ts');
    h.gateway.delete('src');
    h.gateway.setFile('stray.txt', 'stray');
    await h.manager.captureRevision({ projectId: 'p1', workspaceId: 'w1', source: 'manual' });
    const result = await h.manager.executeRollback({
      projectId: 'p1',
      workspaceId: 'w1',
      targetRevisionId: first.id,
      expectedCurrentRevision: h.gateway.revision,
      reason: null,
    });
    expect(result.filesChanged).toBeGreaterThan(0);
    expect(h.gateway.nodes.get('src/app.ts')?.content).toBe('export {}');
    expect(h.gateway.nodes.has('stray.txt')).toBe(false);
    // Verify step ordering: directories created before files inside them.
    const steps = h.gateway.applyRestoreCalls[0];
    const dirIndex = steps.findIndex((step) => step.kind === 'create_directory');
    const fileIndex = steps.findIndex(
      (step) => step.kind === 'create_file' && step.path === 'src/app.ts',
    );
    expect(dirIndex).toBeGreaterThanOrEqual(0);
    expect(fileIndex).toBeGreaterThan(dirIndex);
  });

  it('does not restore revisions from another project or workspace', async () => {
    const h = harness();
    const { first } = await seeded(h);
    await expect(
      h.manager.executeRollback({
        projectId: 'p2',
        workspaceId: 'w1',
        targetRevisionId: first,
        expectedCurrentRevision: h.gateway.revision,
        reason: null,
      }),
    ).rejects.toThrow(ForeignProjectRevisionError);
    await expect(h.manager.getRevision('p1', 'w2', first)).rejects.toThrow(
      ForeignWorkspaceRevisionError,
    );
  });
});

describe('rollback operations (state machine)', () => {
  it('registers, approves, completes, and refuses replay', async () => {
    const h = harness();
    const { first } = await (async () => {
      h.gateway.setFile('a.txt', 'one');
      const r1 = await h.manager.captureRevision({
        projectId: 'p1',
        workspaceId: 'w1',
        source: 'manual',
      });
      h.gateway.setFile('a.txt', 'two');
      await h.manager.captureRevision({ projectId: 'p1', workspaceId: 'w1', source: 'manual' });
      return { first: r1.id };
    })();
    const operation = await h.manager.registerOperation(
      {
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: first,
        expectedCurrentRevision: 2,
        reason: 'undo',
      },
      'confirmation-1',
    );
    expect(operation.state).toBe('pending_confirmation');
    const approved = await h.manager.approveOperation(operation.id);
    expect(approved.state).toBe('approved');
    const completed = await h.manager.completeOperation(operation.id, {
      newRevisionId: 'r3',
      newRevisionNumber: 3,
      restoredFromRevisionId: first,
      restoredFromRevisionNumber: 1,
      filesChanged: 1,
    });
    expect(completed.state).toBe('completed');
    expect(completed.result?.newRevisionId).toBe('r3');
    // Replay: rejected.
    await expect(h.manager.approveOperation(operation.id)).rejects.toThrow(
      OperationAlreadyResolvedError,
    );
    await expect(
      h.manager.completeOperation(operation.id, completed.result as never),
    ).rejects.toThrow(OperationAlreadyResolvedError);
  });

  it('rejects a pending operation once and forever', async () => {
    const h = harness();
    const operation = await h.manager.registerOperation(
      {
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: 'x',
        expectedCurrentRevision: 1,
        reason: null,
      },
      null,
    );
    const rejected = await h.manager.rejectOperation(operation.id);
    expect(rejected.state).toBe('rejected');
    await expect(h.manager.rejectOperation(operation.id)).rejects.toThrow(
      OperationAlreadyResolvedError,
    );
    await expect(h.manager.approveOperation(operation.id)).rejects.toThrow(
      OperationAlreadyResolvedError,
    );
  });

  it('records typed failures', async () => {
    const h = harness();
    const operation = await h.manager.registerOperation(
      {
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: 'x',
        expectedCurrentRevision: 1,
        reason: null,
      },
      null,
    );
    const failed = await h.manager.failOperation(
      operation.id,
      'VERSION_REVISION_CONFLICT',
      'conflict',
    );
    expect(failed.state).toBe('failed');
    expect(failed.failureCode).toBe('VERSION_REVISION_CONFLICT');
  });

  it('rejects secret-shaped reasons', async () => {
    const h = harness();
    await expect(
      h.manager.registerOperation(
        {
          projectId: 'p1',
          workspaceId: 'w1',
          targetRevisionId: 'x',
          expectedCurrentRevision: 1,
          reason: 'sk-abcdefghijklmnopqrstuvwx',
        },
        null,
      ),
    ).rejects.toThrow(SecretRejectedVersionError);
  });
});

describe('retention', () => {
  it('evicts the oldest revisions beyond the cap but never checkpointed or latest ones', async () => {
    const h = harness({ maxRevisions: 4 });
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      h.gateway.setFile(`f${index}.txt`, `content ${index}`);
      const revision = await h.manager.captureRevision({
        projectId: 'p1',
        workspaceId: 'w1',
        source: 'manual',
        message: `v${index}`,
      });
      ids.push(revision.id);
      if (index === 0) {
        await h.manager.createCheckpoint({
          projectId: 'p1',
          workspaceId: 'w1',
          revisionId: revision.id,
          name: 'keep-me',
        });
      }
    }
    const page = await h.manager.listRevisions('p1', 'w1', 50, 0);
    expect(page.total).toBe(4);
    // The checkpointed first revision survives; the second was evicted.
    expect((await h.manager.getRevision('p1', 'w1', ids[0])).id).toBe(ids[0]);
    await expect(h.manager.getRevision('p1', 'w1', ids[1])).rejects.toThrow(RevisionNotFoundError);
    // The latest always survives.
    expect((await h.manager.getRevision('p1', 'w1', ids[4])).id).toBe(ids[4]);
  });
});

describe('audit', () => {
  it('never places file contents or secret values into audit events', async () => {
    const h = harness();
    h.gateway.setFile('a.txt', 'REGULAR CONTENT');
    const revision = await h.manager.captureRevision({
      projectId: 'p1',
      workspaceId: 'w1',
      source: 'manual',
    });
    h.gateway.setFile('a.txt', 'CHANGED CONTENT');
    await h.manager.captureRevision({ projectId: 'p1', workspaceId: 'w1', source: 'manual' });
    await h.manager.getRevisionDiff('p1', 'w1', revision.id);
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain('REGULAR CONTENT');
    expect(serialized).not.toContain('CHANGED CONTENT');
  });

  it('scrubs secret-shaped metadata values', async () => {
    const h = harness();
    await h.manager.registerOperation(
      {
        projectId: 'p1',
        workspaceId: 'w1',
        targetRevisionId: 'sk-abcdefghijklmnopqrstuvwx',
        expectedCurrentRevision: 1,
        reason: null,
      },
      null,
    );
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });
});
