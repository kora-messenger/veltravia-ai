import { describe, expect, it } from 'vitest';

import { SyncError } from './errors.js';
import { SyncManager } from './manager.js';
import { FakeLocalPort, FakeRemotePort } from './testing-fakes.js';

// A credential shaped like a GitHub token, built at runtime so no real-looking
// key sits in the repository.
const FAKE_KEY = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3'}`;

const ALICE = 'owner-alice';
const BOB = 'owner-bob';

function setup() {
  const local = new FakeLocalPort();
  const remote = new FakeRemotePort();
  local.addProject({ projectId: 'prj-1', ownerRef: ALICE, name: 'Notes API' });
  const manager = new SyncManager({
    local,
    remote,
    now: () => new Date('2026-11-06T09:00:00Z'),
  });
  return { local, remote, manager };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SyncError) return error.code;
    return `not-a-SyncError: ${String(error)}`;
  }
  return 'no-error';
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SyncError) return error.code;
    return `not-a-SyncError: ${String(error)}`;
  }
  return 'no-error';
}

describe('connecting a project to a repository', () => {
  it('lists only the repositories the connector is allowed to touch', async () => {
    const { manager } = setup();
    const repos = await manager.listRepositories();
    expect(repos.map((r) => `${r.owner}/${r.repository}`)).toEqual(['acme/notes', 'acme/site']);
  });

  it('lists the branches of a repository, marking the default', async () => {
    const { manager } = setup();
    const branches = await manager.listBranches(ALICE, { owner: 'acme', repository: 'notes' });
    expect(branches.map((b) => b.name)).toEqual(['main', 'feature']);
    expect(branches.find((b) => b.name === 'main')?.isDefault).toBe(true);
  });

  it('connects an owned project to an allowed repository and branch', async () => {
    const { manager } = setup();
    const connection = await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    expect(connection).toMatchObject({
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
      lastSyncedCommit: null,
    });
    expect(manager.status(ALICE, 'prj-1').connected).toBe(true);
  });

  it('refuses a project that belongs to somebody else, without saying it exists', async () => {
    const { manager } = setup();
    const result = await codeOf(() =>
      manager.connect(BOB, {
        projectId: 'prj-1',
        owner: 'acme',
        repository: 'notes',
        branch: 'main',
      }),
    );
    expect(result).toBe('SYNC_NOT_FOUND');
  });

  it('refuses a repository outside the connector authority', async () => {
    const { manager } = setup();
    const result = await codeOf(() =>
      manager.connect(ALICE, {
        projectId: 'prj-1',
        owner: 'someone-else',
        repository: 'theirs',
        branch: 'main',
      }),
    );
    expect(result).toBe('SYNC_REPOSITORY_NOT_ALLOWED');
  });

  it('refuses a branch that does not exist on the remote', async () => {
    const { manager } = setup();
    const result = await codeOf(() =>
      manager.connect(ALICE, {
        projectId: 'prj-1',
        owner: 'acme',
        repository: 'notes',
        branch: 'no-such-branch',
      }),
    );
    expect(result).toBe('SYNC_BRANCH_NOT_FOUND');
  });

  it('refuses a second connection to the same project', async () => {
    const { manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    const result = await codeOf(() =>
      manager.connect(ALICE, {
        projectId: 'prj-1',
        owner: 'acme',
        repository: 'site',
        branch: 'main',
      }),
    );
    expect(result).toBe('SYNC_ALREADY_CONNECTED');
  });

  it('disconnects without touching the remote or the project files', async () => {
    const { manager, local, remote } = setup();
    local.write('prj-1', 'index.ts', 'x');
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    manager.disconnect(ALICE, 'prj-1');
    expect(manager.status(ALICE, 'prj-1').connected).toBe(false);
    expect(local.paths('prj-1')).toEqual(['index.ts']);
    expect(remote.branchCount()).toBe(3);
  });

  it('refuses to disconnect a project that is not connected', () => {
    const { manager } = setup();
    expect(code(() => manager.disconnect(ALICE, 'prj-1'))).toBe('SYNC_NOT_CONNECTED');
  });

  it('cannot connect to another user’s project even with a valid repository', async () => {
    const { manager } = setup();
    const result = await codeOf(() =>
      manager.connect(BOB, {
        projectId: 'prj-1',
        owner: 'acme',
        repository: 'notes',
        branch: 'main',
      }),
    );
    expect(result).toBe('SYNC_NOT_FOUND');
    expect(manager.status(BOB, 'prj-1').connected).toBe(false);
  });
});

describe('planning', () => {
  async function connected() {
    const context = setup();
    await context.manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    return context;
  }

  it('says in-sync when both sides hold the same files', async () => {
    const { local, remote, manager } = await connected();
    local.write('prj-1', 'a.ts', 'same');
    remote.seed('acme', 'notes', 'main', 'a.ts', 'same');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.status).toBe('in-sync');
    expect(plan.push).toEqual([]);
    expect(plan.pull).toEqual([]);
  });

  it('plans a new local file as an add', async () => {
    const { local, manager } = await connected();
    local.write('prj-1', 'src/app.ts', 'export {}');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.push).toEqual([expect.objectContaining({ path: 'src/app.ts', kind: 'add' })]);
    // A first sync writes to a repository for the first time: a person approves it.
    expect(plan.status).toBe('needs-approval');
    expect(plan.approvalReasons).toContain('first-sync');
    expect(plan.approvalReasons).toContain('default-branch');
  });

  it('plans a modified local file as an update', async () => {
    const { local, remote, manager } = await connected();
    remote.seed('acme', 'notes', 'main', 'a.ts', 'old');
    local.write('prj-1', 'a.ts', 'old');
    // Agree a base first, so a later change is a modification rather than an add.
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(first.status).toBe('in-sync');
    await manager.apply(ALICE, first.planId);
    local.write('prj-1', 'a.ts', 'new');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.push).toEqual([expect.objectContaining({ path: 'a.ts', kind: 'modify' })]);
  });

  it('plans a local deletion as a delete, and asks for approval', async () => {
    const { local, remote, manager } = await connected();
    local.write('prj-1', 'gone.ts', 'x');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(remote.files('acme', 'notes', 'main')).toContain('gone.ts');
    local.remove('prj-1', 'gone.ts');
    const next = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(next.push).toEqual([expect.objectContaining({ path: 'gone.ts', kind: 'delete' })]);
    expect(next.approvalReasons).toContain('deletes-remote-files');
    expect(next.status).toBe('needs-approval');
  });

  it('brings a new remote file in when nothing changed locally', async () => {
    const { manager, remote } = await connected();
    remote.seed('acme', 'notes', 'main', 'remote.ts', 'from remote');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.pull).toEqual([expect.objectContaining({ path: 'remote.ts', kind: 'add' })]);
  });

  it('does not plan anything for an unconnected project', async () => {
    const { manager } = setup();
    const result = await codeOf(() => manager.plan(ALICE, { projectId: 'prj-1' }));
    expect(result).toBe('SYNC_NOT_CONNECTED');
  });

  it('refuses when the repository is too large to compare completely', async () => {
    const { manager, remote } = await connected();
    remote.truncated = true;
    const result = await codeOf(() => manager.plan(ALICE, { projectId: 'prj-1' }));
    expect(result).toBe('SYNC_REMOTE_TRUNCATED');
  });

  it('never plans a conflict on the read-only side without both versions', async () => {
    const { local, remote, manager } = await connected();
    local.write('prj-1', 'a.ts', 'base');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    local.write('prj-1', 'a.ts', 'local edit');
    remote.seed('acme', 'notes', 'main', 'a.ts', 'remote edit');
    const conflicted = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(conflicted.status).toBe('conflicts');
    const view = manager.viewConflict(ALICE, conflicted.planId, conflicted.conflicts[0]!.id);
    expect(view.local).toBe('local edit');
    expect(view.remote).toBe('remote edit');
  });

  it('keeps only one live plan per project', async () => {
    const { local, manager } = await connected();
    local.write('prj-1', 'a.ts', 'x');
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    const second = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(code(() => manager.getPlan(ALICE, first.planId))).toBe('SYNC_NOT_FOUND');
    expect(manager.getPlan(ALICE, second.planId).planId).toBe(second.planId);
  });
});

describe('approval and applying', () => {
  async function connected() {
    const context = setup();
    await context.manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    return context;
  }

  it('publishes an approved plan as ONE commit holding every change', async () => {
    const { local, manager, remote } = await connected();
    local.write('prj-1', 'one.ts', '1');
    local.write('prj-1', 'two.ts', '2');
    local.write('prj-1', 'src/three.ts', '3');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    const result = await manager.apply(ALICE, plan.planId);
    expect(remote.publishCalls).toHaveLength(1);
    expect(remote.publishCalls[0]!.changes.map((c) => c.path).sort()).toEqual([
      'one.ts',
      'src/three.ts',
      'two.ts',
    ]);
    expect(result.commitSha).toBeTruthy();
    expect(remote.files('acme', 'notes', 'main')).toEqual(['one.ts', 'src/three.ts', 'two.ts']);
  });

  it('refuses to apply without approval when the sync needs one', async () => {
    const { local, manager, remote } = await connected();
    // Seed a remote file, then delete it locally: a destructive sync.
    local.write('prj-1', 'keep.ts', 'x');
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, first.planId);
    await manager.apply(ALICE, first.planId);
    local.remove('prj-1', 'keep.ts');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.status).toBe('needs-approval');
    const result = await codeOf(() => manager.apply(ALICE, plan.planId));
    expect(result).toBe('SYNC_APPROVAL_REQUIRED');
    expect(remote.publishCalls).toHaveLength(1); // only the first, approved sync
    expect(remote.files('acme', 'notes', 'main')).toContain('keep.ts');
  });

  it('applies without approval when nothing is destructive', async () => {
    // A feature branch, already synchronised once: adding a file destroys nothing.
    const { local, manager } = setup();
    local.write('prj-1', 'base.ts', 'x');
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'feature',
    });
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(first.approvalReasons).toEqual(['first-sync']);
    await manager.approve(ALICE, first.planId);
    await manager.apply(ALICE, first.planId);

    local.write('prj-1', 'new.ts', 'x');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.status).toBe('ready');
    expect(plan.approvalReasons).toEqual([]);
    const result = await manager.apply(ALICE, plan.planId);
    expect(result.commitSha).toBeTruthy();
  });

  it('refuses a plan whose project changed after it was made', async () => {
    const { local, manager } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    local.write('prj-1', 'b.ts', '2'); // somebody edited during approval
    const result = await codeOf(() => manager.apply(ALICE, plan.planId));
    expect(result).toBe('SYNC_PLAN_STALE');
  });

  it('does not overwrite a branch that moved after the plan was made', async () => {
    const { local, manager, remote } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    remote.moveHead('acme', 'notes', 'main');
    const result = await codeOf(() => manager.apply(ALICE, plan.planId));
    expect(result).not.toBe('no-error');
    expect(remote.files('acme', 'notes', 'main')).toEqual([]);
    expect(manager.getPlan(ALICE, plan.planId).status).toBe('failed');
  });

  it('applies against the head the plan was made from, not an older sync', async () => {
    const { local, manager, remote } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, first.planId);
    await manager.apply(ALICE, first.planId);

    // Somebody else pushes, and the next plan is made against THAT head.
    remote.seed('acme', 'notes', 'main', 'theirs.ts', 'from a colleague');
    remote.moveHead('acme', 'notes', 'main');
    local.write('prj-1', 'b.ts', '2');
    const second = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(second.remoteHead).toBe(
      (await remote.listBranches('acme', 'notes')).find((b) => b.name === 'main')?.headSha,
    );
    // Syncing onto files a colleague pushed is a decision, so it needs approval.
    expect(second.approvalReasons.length).toBeGreaterThan(0);
    await manager.approve(ALICE, second.planId);
    const result = await manager.apply(ALICE, second.planId);
    expect(result.commitSha).toBeTruthy();
    expect(remote.files('acme', 'notes', 'main')).toContain('theirs.ts');
  });

  it('records a failure when GitHub errors, and writes nothing locally', async () => {
    const { local, manager, remote } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    remote.failPublish = 'api-error';
    await codeOf(() => manager.apply(ALICE, plan.planId));
    const entry = manager.history(ALICE, 'prj-1')[0]!;
    expect(entry.outcome).toBe('failure');
    expect(entry.failureCode).toBeTruthy();
  });

  it('cancels a plan, and then refuses to apply it', async () => {
    const { local, manager, remote } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    const cancelled = manager.cancel(ALICE, plan.planId);
    expect(cancelled.status).toBe('cancelled');
    const result = await codeOf(() => manager.apply(ALICE, plan.planId));
    expect(result).toBe('SYNC_PLAN_NOT_ACTIVE');
    expect(remote.publishCalls).toHaveLength(0);
  });

  it('refuses to cancel an applied plan', async () => {
    const { local, manager } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(code(() => manager.cancel(ALICE, plan.planId))).toBe('SYNC_PLAN_NOT_ACTIVE');
  });

  it('cannot apply somebody else’s plan', async () => {
    const { local, manager } = await connected();
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(code(() => manager.getPlan(BOB, plan.planId))).toBe('SYNC_NOT_FOUND');
    const result = await codeOf(() => manager.apply(BOB, plan.planId));
    expect(result).toBe('SYNC_NOT_FOUND');
  });

  it('brings remote files into the project after a successful apply', async () => {
    const { local, manager, remote } = await connected();
    remote.seed('acme', 'notes', 'main', 'remote.ts', 'from remote');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.apply(ALICE, plan.planId);
    expect(local.read('prj-1', 'remote.ts')).toBe('from remote');
  });
});

describe('conflicts', () => {
  async function diverged() {
    const context = setup();
    const { local, remote, manager } = context;
    local.write('prj-1', 'a.ts', 'base');
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, first.planId);
    await manager.apply(ALICE, first.planId);
    local.write('prj-1', 'a.ts', 'local edit');
    remote.seed('acme', 'notes', 'main', 'a.ts', 'remote edit');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    return { ...context, plan };
  }

  it('reports a simultaneous change as a conflict, not a silent winner', async () => {
    const { plan } = await diverged();
    expect(plan.status).toBe('conflicts');
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.kind).toBe('both-modified');
    expect(plan.push.some((c) => c.path === 'a.ts')).toBe(false);
    expect(plan.pull.some((c) => c.path === 'a.ts')).toBe(false);
  });

  it('refuses to apply while a conflict is unresolved', async () => {
    const { manager, plan, remote } = await diverged();
    const result = await codeOf(() => manager.apply(ALICE, plan.planId));
    expect(result).toBe('SYNC_CONFLICTS_UNRESOLVED');
    expect(remote.content('acme', 'notes', 'main', 'a.ts')).toBe('remote edit');
  });

  it('refuses to approve while a conflict is unresolved', async () => {
    const { manager, plan } = await diverged();
    expect(code(() => manager.approve(ALICE, plan.planId))).toBe('SYNC_CONFLICTS_UNRESOLVED');
  });

  it('keeps the local version everywhere and publishes it', async () => {
    const { manager, plan, remote, local } = await diverged();
    manager.resolveConflict(ALICE, plan.planId, plan.conflicts[0]!.id, {
      resolution: 'keep-local',
    });
    manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(remote.content('acme', 'notes', 'main', 'a.ts')).toBe('local edit');
    expect(local.read('prj-1', 'a.ts')).toBe('local edit');
  });

  it('keeps the remote version everywhere, and asks for approval first', async () => {
    const { manager, plan, remote, local } = await diverged();
    manager.resolveConflict(ALICE, plan.planId, plan.conflicts[0]!.id, {
      resolution: 'keep-remote',
    });
    // Taking the remote text overwrites local work: a person must approve.
    expect(code(() => manager.approve(ALICE, plan.planId))).toBe('no-error');
    const approved = manager.getPlan(ALICE, plan.planId);
    expect(approved.approvalReasons.length).toBeGreaterThan(0);
    await manager.apply(ALICE, plan.planId);
    expect(local.read('prj-1', 'a.ts')).toBe('remote edit');
    expect(remote.content('acme', 'notes', 'main', 'a.ts')).toBe('remote edit');
  });

  it('uses merged text for a manual resolution, on both sides', async () => {
    const { manager, plan, remote, local } = await diverged();
    manager.resolveConflict(ALICE, plan.planId, plan.conflicts[0]!.id, {
      resolution: 'manual',
      manualContent: 'merged',
    });
    manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(local.read('prj-1', 'a.ts')).toBe('merged');
    expect(remote.content('acme', 'notes', 'main', 'a.ts')).toBe('merged');
  });

  it('refuses merged text that contains a credential', async () => {
    const { manager, plan } = await diverged();
    const result = code(() =>
      manager.resolveConflict(ALICE, plan.planId, plan.conflicts[0]!.id, {
        resolution: 'manual',
        manualContent: `const key = '${FAKE_KEY}';`,
      }),
    );
    // Refused on CONTENT, not shape: its own state, mapped to 422 by the API.
    expect(result).toBe('SYNC_SECRET_REJECTED');
  });

  it('reports a file deleted locally but modified remotely', async () => {
    const { local, remote, manager } = await diverged();
    const fresh = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(fresh.status).toBe('conflicts');
    local.remove('prj-1', 'a.ts');
    remote.seed('acme', 'notes', 'main', 'a.ts', 'remote again');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.conflicts.map((c) => c.kind)).toContain('local-deleted-remote-modified');
  });

  it('reports a file modified locally but deleted remotely', async () => {
    const { local, remote, manager } = await diverged();
    await manager.plan(ALICE, { projectId: 'prj-1' });
    local.write('prj-1', 'a.ts', 'local again');
    const repo = remote.repos.get('acme/notes')!;
    repo.branches.get('main')!.files.delete('a.ts');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.conflicts.map((c) => c.kind)).toContain('remote-deleted-local-modified');
  });

  it('detects a rename rather than a delete plus an add', async () => {
    const { local, manager, remote } = setup();
    local.write('prj-1', 'old-name.ts', 'the same text');
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    const first = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, first.planId);
    await manager.apply(ALICE, first.planId);

    local.remove('prj-1', 'old-name.ts');
    local.write('prj-1', 'new-name.ts', 'the same text');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    expect(plan.push).toEqual([
      expect.objectContaining({ path: 'new-name.ts', kind: 'rename', fromPath: 'old-name.ts' }),
    ]);
    expect(plan.approvalReasons).toContain('deletes-remote-files');
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(remote.files('acme', 'notes', 'main')).toEqual(['new-name.ts']);
  });
});

describe('secrets never cross', () => {
  it('does not push a credential file', async () => {
    const { local, remote, manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    local.write('prj-1', '.env', 'SECRET=1');
    local.write('prj-1', 'ok.ts', 'x');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(remote.files('acme', 'notes', 'main')).toEqual(['ok.ts']);
    expect(plan.skipped.some((s) => s.path === '.env')).toBe(true);
  });

  it('does not push a file whose text holds a key', async () => {
    const { local, remote, manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    local.write('prj-1', 'config.ts', `export const t = '${FAKE_KEY}';`);
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(remote.files('acme', 'notes', 'main')).toEqual([]);
  });

  it('does not bring a credential file in from the remote', async () => {
    const { local, manager, remote } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    remote.seed('acme', 'notes', 'main', '.env', 'SECRET=1');
    remote.seed('acme', 'notes', 'main', 'ok.ts', 'x');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.apply(ALICE, plan.planId);
    expect(local.paths('prj-1')).toEqual(['ok.ts']);
  });

  it('does not bring in remote text that holds a key', async () => {
    const { local, manager, remote } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    remote.seed('acme', 'notes', 'main', 'leaked.ts', `const k = '${FAKE_KEY}';`);
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.apply(ALICE, plan.planId);
    expect(local.paths('prj-1')).toEqual([]);
  });

  it('never puts a secret in the history or an error message', async () => {
    const { local, remote, manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    local.write('prj-1', 'leak.ts', `const k = '${FAKE_KEY}';`);
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.apply(ALICE, plan.planId);
    const serialised = JSON.stringify([manager.history(ALICE, 'prj-1'), plan]);
    expect(serialised).not.toContain(FAKE_KEY);
    expect(remote.publishCalls).toHaveLength(0);
  });
});

describe('history', () => {
  it('records a successful sync with its commit, counts and outcome', async () => {
    const { local, manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    const [entry] = manager.history(ALICE, 'prj-1');
    expect(entry).toMatchObject({
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
      outcome: 'success',
      approval: 'approved',
      added: ['a.ts'],
      modified: [],
      deleted: [],
      pulled: 0,
      conflicts: 0,
      failureCode: null,
    });
    expect(entry!.commitSha).toBeTruthy();
    expect(entry!.message).toBeTruthy();
  });

  it('keeps history private to its owner', async () => {
    const { local, manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    await manager.approve(ALICE, plan.planId);
    await manager.apply(ALICE, plan.planId);
    expect(manager.history(BOB, 'prj-1')).toEqual([]);
  });

  it('records a cancellation', async () => {
    const { local, manager } = setup();
    await manager.connect(ALICE, {
      projectId: 'prj-1',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
    });
    local.write('prj-1', 'a.ts', '1');
    const plan = await manager.plan(ALICE, { projectId: 'prj-1' });
    manager.cancel(ALICE, plan.planId);
    expect(manager.history(ALICE, 'prj-1')[0]!.outcome).toBe('cancelled');
  });
});
