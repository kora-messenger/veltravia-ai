import { describe, expect, it } from 'vitest';

import { changedLineRange } from './conflicts.js';
import { IntegrationError } from './errors.js';
import { contentHash } from './hash.js';
import {
  InMemoryApprovalStore,
  InMemoryChangeArtifacts,
  InMemoryChangeSetStore,
  InMemoryIntegrationLocks,
  InMemoryIntegrationStore,
} from './memory.js';
import { IntegrationManager } from './manager.js';
import { normalizeChangePath } from './paths.js';
import { InMemoryIntegrationTree } from './testing.js';
import type { IntegrationVerificationPort } from './types.js';
import { validateChangeSet } from './validation.js';

const OWNER = 'veltravia-dev-user';
const PROJECT = 'prj_1';
const WORKSPACE = 'ws_1';

interface Harness {
  readonly manager: IntegrationManager;
  readonly tree: InMemoryIntegrationTree;
  readonly locks: InMemoryIntegrationLocks;
  readonly integrations: InMemoryIntegrationStore;
  readonly changeSets: InMemoryChangeSetStore;
  readonly artifacts: InMemoryChangeArtifacts;
  readonly verificationCalls: number[];
}

async function harness(
  options: {
    readonly tree?: InMemoryIntegrationTree;
    readonly verification?: IntegrationVerificationPort;
    readonly projects?: 'owner' | 'missing';
  } = {},
): Promise<Harness> {
  const tree = options.tree ?? new InMemoryIntegrationTree({ 'README.md': '# Project' });
  const changeSets = new InMemoryChangeSetStore();
  const approvals = new InMemoryApprovalStore();
  const integrations = new InMemoryIntegrationStore();
  const artifacts = new InMemoryChangeArtifacts();
  const locks = new InMemoryIntegrationLocks();
  const verificationCalls: number[] = [];

  const manager = new IntegrationManager({
    projects: {
      async resolve(input) {
        if (options.projects === 'missing') return null;
        if (input.projectId !== PROJECT) return null;
        // Ownership is part of resolution: another owner gets "not found".
        if (input.ownerRef !== OWNER) return null;
        return { projectId: PROJECT, workspaceId: WORKSPACE };
      },
    },
    tree,
    changeSets,
    approvals,
    integrations,
    artifacts,
    locks,
    ...(options.verification === undefined ? {} : { verification: options.verification }),
    now: () => new Date('2026-11-07T10:00:00.000Z'),
    generateId: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `id_${next}`;
      };
    })(),
  });

  return { manager, tree, locks, integrations, changeSets, artifacts, verificationCalls };
}

const allowed = { allowedPaths: ['src', 'README.md'], allowedTools: ['project.write'] };

async function draft(
  h: Harness,
  input: {
    files: { path: string; op?: 'create' | 'update' | 'delete'; content?: string }[];
    baseRevision?: number;
    workerId?: string;
    authorization?: { allowedPaths: string[]; excludedPaths?: string[]; allowedTools?: string[] };
  },
) {
  const state = await h.tree.snapshot(WORKSPACE);
  const files = [];
  for (const file of input.files) {
    if (file.op === 'delete') {
      const current = state.files.find((entry) => entry.path === file.path);
      files.push({
        path: file.path,
        op: 'delete' as const,
        baseHash: current?.contentHash ?? null,
      });
      continue;
    }
    const current = state.files.find((entry) => entry.path === file.path);
    files.push({
      path: file.path,
      op: file.op ?? (current === undefined ? ('create' as const) : ('update' as const)),
      ...(current === undefined ? {} : { baseHash: current.contentHash }),
      content: file.content ?? '',
    });
  }
  return h.manager.createChangeSet(OWNER, {
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    baseRevision: input.baseRevision ?? state.revision,
    files,
    ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    authorization: {
      allowedPaths: input.authorization?.allowedPaths ?? allowed.allowedPaths,
      excludedPaths: input.authorization?.excludedPaths ?? [],
      allowedTools: input.authorization?.allowedTools ?? allowed.allowedTools,
    },
  });
}

async function approveAndIntegrate(h: Harness, ids: string[], operations?: string[]) {
  const approval = await h.manager.recordApproval({
    ownerRef: OWNER,
    projectId: PROJECT,
    changeSetIds: ids,
    decision: 'approve',
    actor: 'primary-agent',
    rationale: 'Reviewed the proposals and their conflicts.',
  });
  return h.manager.integrate({
    ownerRef: OWNER,
    projectId: PROJECT,
    changeSetIds: ids,
    approvalId: approval.id,
    ...(operations === undefined ? {} : { operations }),
  });
}

describe('change set paths and validation', () => {
  it('refuses traversal, absolute paths and empty segments', () => {
    expect(normalizeChangePath('../etc/passwd')).toBeNull();
    expect(normalizeChangePath('/etc/passwd')).toBeNull();
    expect(normalizeChangePath('src//a.ts')).toBeNull();
    expect(normalizeChangePath('src/./a.ts')).toBeNull();
    expect(normalizeChangePath('src\\a.ts')).toBeNull();
    expect(normalizeChangePath('src/a.ts')).toBe('src/a.ts');
  });

  it('rejects a path outside the assignment scope', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'secrets/key.pem', content: 'x' }] });
    const validation = await h.manager.validate(OWNER, set.id);
    expect(validation.validation.ok).toBe(false);
    expect(validation.validation.problems.map((p) => p.code)).toContain(
      'CHANGE_SET_UNAUTHORIZED_PATH',
    );
  });

  it('rejects excluded paths and credential-shaped content', async () => {
    const h = await harness();
    const excluded = await draft(h, {
      files: [{ path: 'src/key.ts', content: 'export const key = 1;' }],
      authorization: { allowedPaths: ['src'], excludedPaths: ['src/key.ts'] },
    });
    const excludedValidation = await h.manager.validate(OWNER, excluded.id);
    expect(excludedValidation.validation.problems.map((p) => p.code)).toContain(
      'CHANGE_SET_EXCLUDED_PATH',
    );

    const secret = await draft(h, {
      files: [
        {
          path: 'src/config.ts',
          content: 'export const config = { apiKey: "sk-live-abcdefabcdefabcdefabcdef" };',
        },
      ],
    });
    const secretValidation = await h.manager.validate(OWNER, secret.id);
    expect(secretValidation.validation.problems.map((p) => p.code)).toContain(
      'CHANGE_SET_SECRET_REJECTED',
    );
  });

  it('reports a stale set when the file moved underneath it', async () => {
    const h = await harness();
    const set = await draft(h, {
      files: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
    });
    h.tree.set('src/a.ts', 'export const a = 0;');
    const validation = await h.manager.validate(OWNER, set.id);
    expect(validation.validation.stale.map((entry) => entry.path)).toContain('src/a.ts');
  });

  it('proves the hash it stores matches the content it holds', async () => {
    const h = await harness();
    const set = await draft(h, {
      files: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
    });
    expect(set.files[0]?.proposedHash).toBe(contentHash('export const a = 1;'));
    const tampered = {
      ...set,
      files: [{ ...set.files[0]!, proposedHash: contentHash('something else') }],
    };
    const contents = new Map([['src/a.ts', 'export const a = 1;']]);
    const validation = validateChangeSet({
      changeSet: tampered,
      contents,
      current: await h.tree.snapshot(WORKSPACE),
    });
    expect(validation.ok).toBe(false);
    expect(validation.problems.map((p) => p.code)).toContain('CHANGE_SET_HASH_INVALID');
  });
});

describe('conflict detection', () => {
  it('treats two independent files as compatible', async () => {
    const h = await harness();
    const front = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }], workerId: 'w1' });
    const back = await draft(h, { files: [{ path: 'src/b.ts', content: 'b' }], workerId: 'w2' });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [front.id, back.id],
    });
    expect(analysis.conflicts).toHaveLength(0);
    expect(analysis.blocked).toBe(false);
    expect(analysis.reports[0]?.independentPaths).toContain('src/a.ts');
  });

  it('does not call a newer revision a conflict on its own', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    h.tree.set('docs/notes.md', 'unrelated');
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [set.id],
    });
    expect(analysis.conflicts).toHaveLength(0);
    expect(analysis.currentRevision).toBeGreaterThan(set.baseRevision);
  });

  it('detects the same file changed twice with different content', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/a.ts': 'base' }) });
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: 'one' }] });
    const two = await draft(h, { files: [{ path: 'src/a.ts', content: 'two' }] });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id, two.id],
    });
    // One base line, so the two edits necessarily overlap; either diagnosis
    // blocks, and the file is never silently taken from one worker.
    expect(analysis.conflicts.map((entry) => entry.kind)).toContain('overlapping-region');
    expect(analysis.blocked).toBe(true);
  });

  it('detects overlapping line regions in one file', async () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n';
    const left = 'one\nTWO\nthree\nfour\nfive\n';
    const right = 'one\ntwo\nTHREE\nfour\nfive\n';
    expect(changedLineRange(base, left)).toEqual({ start: 1, end: 2 });
    expect(changedLineRange(base, right)).toEqual({ start: 2, end: 3 });

    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/a.ts': base }) });
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: left }] });
    const two = await draft(h, { files: [{ path: 'src/a.ts', content: right }] });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id, two.id],
    });
    expect(analysis.conflicts.map((entry) => entry.kind)).toContain('overlapping-region');
  });

  it('detects a deletion racing an edit', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/old.ts': 'old' }) });
    const deleter = await draft(h, {
      files: [{ path: 'src/old.ts', op: 'delete' }],
      authorization: { allowedPaths: ['src'] },
    });
    const editor = await draft(h, {
      files: [{ path: 'src/old.ts', content: 'new' }],
      authorization: { allowedPaths: ['src'] },
    });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [deleter.id, editor.id],
    });
    expect(analysis.conflicts.map((entry) => entry.kind)).toContain('delete-modify');
  });

  it('detects a rename racing an edit of the old path', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/a.ts': 'a' }) });
    const renamer = await draft(h, {
      files: [
        { path: 'src/a.ts', op: 'delete' },
        { path: 'src/moved/a.ts', op: 'create', content: 'a' },
      ],
      authorization: { allowedPaths: ['src'] },
    });
    const editor = await draft(h, {
      files: [{ path: 'src/a.ts', content: 'a edited' }],
      authorization: { allowedPaths: ['src'] },
    });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [renamer.id, editor.id],
    });
    expect(analysis.conflicts.map((entry) => entry.kind)).toContain('rename-modify');
  });

  it('detects competing schema and dependency changes', async () => {
    const h = await harness({
      tree: new InMemoryIntegrationTree({
        'prisma/schema.prisma': 'model A { id Int @id }\n',
        'package.json': '{"name":"p","dependencies":{"a":"1"}}\n',
      }),
    });
    const one = await draft(h, {
      files: [
        {
          path: 'prisma/schema.prisma',
          content: 'model A { id Int @id }\nmodel B { id Int @id }\n',
        },
        { path: 'package.json', content: '{"name":"p","dependencies":{"a":"2"}}\n' },
      ],
      authorization: { allowedPaths: ['prisma', 'package.json'] },
    });
    const two = await draft(h, {
      files: [
        {
          path: 'prisma/schema.prisma',
          content: 'model A { id Int @id }\nmodel C { id Int @id }\n',
        },
        { path: 'package.json', content: '{"name":"p","dependencies":{"a":"3"}}\n' },
      ],
      authorization: { allowedPaths: ['prisma', 'package.json'] },
    });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id, two.id],
    });
    const kinds = new Set(analysis.conflicts.map((entry) => entry.kind));
    expect(kinds.has('schema')).toBe(true);
    expect(kinds.has('dependency')).toBe(true);
  });

  it('detects a change that invalidates another worker deliverable', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/report.ts': 'r' }) });
    const producer = await h.manager.createChangeSet(OWNER, {
      projectId: PROJECT,
      baseRevision: 1,
      files: [{ path: 'src/other.ts', op: 'create', content: 'x' }],
      deliverables: ['src/report.ts'],
      authorization: { allowedPaths: ['src'], allowedTools: ['project.write'] },
    });
    const remover = await draft(h, {
      files: [{ path: 'src/report.ts', op: 'delete' }],
      authorization: { allowedPaths: ['src'] },
    });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [producer.id, remover.id],
    });
    expect(analysis.conflicts.map((entry) => entry.kind)).toContain('invalidates-deliverable');
  });

  it('marks identical proposals as convergent rather than blocking', async () => {
    const h = await harness();
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: 'same' }] });
    const two = await draft(h, { files: [{ path: 'src/a.ts', content: 'same' }] });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id, two.id],
    });
    expect(analysis.conflicts.every((entry) => entry.convergent)).toBe(true);
    expect(analysis.blocked).toBe(false);
  });
});

describe('integration', () => {
  it('applies independent change sets and records the revision', async () => {
    const h = await harness();
    const front = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const back = await draft(h, { files: [{ path: 'src/b.ts', content: 'b' }] });
    const result = await approveAndIntegrate(h, [front.id, back.id]);
    expect(result.applied).toBe(true);
    expect(result.record.status).toBe('integrated');
    expect(h.tree.dump()['src/a.ts']).toBe('a');
    expect(h.tree.dump()['src/b.ts']).toBe('b');
    expect(result.record.resultRevision).not.toBeNull();
    expect(result.record.rollbackSnapshotId).not.toBeNull();
  });

  it('refuses to integrate without an approval', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    await expect(
      h.manager.integrate({
        ownerRef: OWNER,
        projectId: PROJECT,
        changeSetIds: [set.id],
        approvalId: 'approval_that_does_not_exist',
      }),
    ).rejects.toThrow(IntegrationError);
  });

  it('refuses an approval that covered different sets', async () => {
    const h = await harness();
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const two = await draft(h, { files: [{ path: 'src/b.ts', content: 'b' }] });
    const approval = await h.manager.recordApproval({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id],
      decision: 'approve',
      actor: 'primary-agent',
      rationale: 'ok',
    });
    await expect(
      h.manager.integrate({
        ownerRef: OWNER,
        projectId: PROJECT,
        changeSetIds: [one.id, two.id],
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_APPROVAL_SCOPE_MISMATCH' });
  });

  it('refuses a rejected approval', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const approval = await h.manager.recordApproval({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [set.id],
      decision: 'reject',
      actor: 'primary-agent',
      rationale: 'not wanted',
    });
    await expect(
      h.manager.integrate({
        ownerRef: OWNER,
        projectId: PROJECT,
        changeSetIds: [set.id],
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_APPROVAL_REJECTED' });
    expect(h.tree.dump()['src/a.ts']).toBeUndefined();
  });

  it('blocks a conflicting selection and leaves the project untouched', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/a.ts': 'base' }) });
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: 'one' }] });
    const two = await draft(h, { files: [{ path: 'src/a.ts', content: 'two' }] });
    await expect(approveAndIntegrate(h, [one.id, two.id])).rejects.toMatchObject({
      code: 'INTEGRATION_CHANGE_SET_CONFLICTED',
    });
    expect(h.tree.dump()['src/a.ts']).toBe('base');
  });

  it('refuses a stale change set instead of overwriting newer work', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/a.ts': 'base' }) });
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'mine' }] });
    h.tree.set('src/a.ts', 'someone else');
    await expect(approveAndIntegrate(h, [set.id])).rejects.toMatchObject({
      code: 'INTEGRATION_CHANGE_SET_STALE',
    });
    expect(h.tree.dump()['src/a.ts']).toBe('someone else');
  });

  it('applies nothing twice', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const first = await approveAndIntegrate(h, [set.id]);
    expect(first.applied).toBe(true);
    await expect(approveAndIntegrate(h, [set.id])).rejects.toMatchObject({
      code: 'INTEGRATION_CHANGE_SET_ALREADY_INTEGRATED',
    });
  });

  it('compensates when a write fails part way through', async () => {
    const tree = new InMemoryIntegrationTree({ 'src/a.ts': 'base' }, { failOnPaths: ['src/b.ts'] });
    const h = await harness({ tree });
    const one = await draft(h, {
      files: [{ path: 'src/a.ts', content: 'a2' }],
      authorization: { allowedPaths: ['src'] },
    });
    const two = await draft(h, {
      files: [{ path: 'src/b.ts', content: 'b' }],
      authorization: { allowedPaths: ['src'] },
    });
    await expect(approveAndIntegrate(h, [one.id, two.id])).rejects.toMatchObject({
      code: 'INTEGRATION_APPLY_FAILED',
    });
    expect(h.tree.dump()['src/a.ts']).toBe('base');
    expect(h.tree.dump()['src/b.ts']).toBeUndefined();

    const records = await h.manager.listIntegrations(OWNER, { projectId: PROJECT });
    const failed = records.find((record) => record.failure?.code === 'INTEGRATION_APPLY_FAILED');
    expect(failed?.status).toBe('failed');
    expect(failed?.failure?.message).toContain('restored');
  });

  it('does not let two integrations run at once', async () => {
    const h = await harness();
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const two = await draft(h, { files: [{ path: 'src/b.ts', content: 'b' }] });
    const approval = await h.manager.recordApproval({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id],
      decision: 'approve',
      actor: 'primary-agent',
      rationale: 'ok',
    });
    // Hold the project lock as another integration would.
    expect(await h.locks.acquire(PROJECT, 'other')).toBe(true);
    await expect(
      h.manager.integrate({
        ownerRef: OWNER,
        projectId: PROJECT,
        changeSetIds: [one.id],
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_PROJECT_LOCKED' });
    await h.locks.release(PROJECT, 'other');
    expect(two.id).toBeTruthy();
  });

  it('keeps another owner away from the project', async () => {
    const h = await harness();
    await expect(
      h.manager.createChangeSet('someone-else', {
        projectId: PROJECT,
        baseRevision: 1,
        files: [{ path: 'src/a.ts', op: 'create', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_PROJECT_NOT_FOUND' });
  });
});

describe('verification after integration', () => {
  const verification = (
    status: 'passed' | 'failed' | 'incomplete',
  ): IntegrationVerificationPort => ({
    available: () => true,
    async run() {
      return {
        runId: 'run_1',
        status,
        executed: status !== 'incomplete',
        evidenceStatus: status,
      };
    },
  });

  it('passes when the checks pass', async () => {
    const h = await harness({ verification: verification('passed') });
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const result = await approveAndIntegrate(h, [set.id], ['unit']);
    expect(result.record.status).toBe('integrated');
    expect(result.record.verification?.status).toBe('passed');
    expect(result.record.verification?.operations).toEqual(['unit']);
  });

  it('marks a failed check for review rather than claiming success', async () => {
    const h = await harness({ verification: verification('failed') });
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const result = await approveAndIntegrate(h, [set.id], ['unit']);
    expect(result.record.status).toBe('needs_review');
    expect(result.record.verification?.status).toBe('failed');
  });

  it('records an incomplete run as incomplete, never as a pass', async () => {
    const h = await harness({ verification: verification('incomplete') });
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const result = await approveAndIntegrate(h, [set.id], ['unit']);
    expect(result.record.verification?.status).toBe('incomplete');
    expect(result.record.status).toBe('integrated');
  });

  it('says verification was unavailable when no runtime is configured', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const result = await approveAndIntegrate(h, [set.id]);
    expect(result.record.verification?.status).toBe('unavailable');
  });
});

describe('rollback and recovery', () => {
  it('reverts an accepted integration', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const result = await approveAndIntegrate(h, [set.id]);
    const rolled = await h.manager.rollback({
      ownerRef: OWNER,
      integrationId: result.record.id,
      actor: 'primary-agent',
      reason: 'The change was not wanted after all.',
    });
    expect(rolled.status).toBe('rolled_back');
    expect(h.tree.dump()['src/a.ts']).toBeUndefined();
    const changeSet = await h.manager.getChangeSet(OWNER, set.id);
    expect(changeSet.status).toBe('rolled_back');
  });

  it('refuses a rollback that would erase later work', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const result = await approveAndIntegrate(h, [set.id]);
    h.tree.set('src/a.ts', 'edited after the integration');
    await expect(
      h.manager.rollback({
        ownerRef: OWNER,
        integrationId: result.record.id,
        actor: 'primary-agent',
        reason: 'revert',
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_ROLLBACK_UNSAFE' });
    expect(h.tree.dump()['src/a.ts']).toBe('edited after the integration');
  });

  it('finishes an interrupted integration by restoring its snapshot', async () => {
    const h = await harness();
    const set = await draft(h, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const approval = await h.manager.recordApproval({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [set.id],
      decision: 'approve',
      actor: 'primary-agent',
      rationale: 'ok',
    });
    const snapshot = await h.tree.createSnapshot({
      workspaceId: WORKSPACE,
      label: 'pre',
      note: 'pre',
    });
    const stuck = {
      id: 'int_stuck',
      ownerRef: OWNER,
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      changeSetIds: [set.id],
      approvalId: approval.id,
      baseRevision: 1,
      resultRevision: null,
      status: 'applying' as const,
      applied: [],
      conflicts: [],
      rollbackSnapshotId: snapshot.snapshotId,
      rollback: null,
      verification: null,
      failure: null,
      createdAt: '2026-11-07T09:00:00.000Z',
      updatedAt: '2026-11-07T09:00:00.000Z',
    };
    await h.integrations.insert(stuck);
    h.tree.set('src/a.ts', 'half written');

    const recovered = await h.manager.recoverInterrupted(OWNER);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('interrupted');
    expect(h.tree.dump()['src/a.ts']).toBeUndefined();
  });

  it('detects conflicts without writing, for a resolution proposal', async () => {
    const h = await harness({ tree: new InMemoryIntegrationTree({ 'src/a.ts': 'base' }) });
    const one = await draft(h, { files: [{ path: 'src/a.ts', content: 'one' }] });
    const two = await draft(h, { files: [{ path: 'src/a.ts', content: 'two' }] });
    const analysis = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [one.id, two.id],
    });
    expect(analysis.blocked).toBe(true);
    // A resolution is a new reviewable change set, drafted against current base.
    const resolved = await draft(h, { files: [{ path: 'src/a.ts', content: 'one + two' }] });
    const after = await h.manager.analyze({
      ownerRef: OWNER,
      projectId: PROJECT,
      changeSetIds: [resolved.id],
    });
    expect(after.blocked).toBe(false);
    expect(h.tree.dump()['src/a.ts']).toBe('base');
  });
});
