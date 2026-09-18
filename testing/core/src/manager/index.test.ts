import { describe, expect, it } from 'vitest';

import { createCodingFixtureEnvironment } from '@veltravia/coding-agent-mock';
import type { CodingRunView } from '@veltravia/coding-agent-core';
import { createDecliningDebugAgent, createMockDebugAgent } from '@veltravia/testing-mock';

import { TestingError } from '../errors/index.js';
import type { TestAuditEvent, CodingRepairRunner } from './index.js';
import { TestingManager } from './index.js';
import type { TestRunLimits, TestRunView } from '../types/index.js';

const NOW = () => new Date('2026-09-18T07:00:00.000Z');

function manifest(scripts: Record<string, string>, deps: Record<string, string> = {}): string {
  return `${JSON.stringify({ name: 'fixture-app', scripts, dependencies: deps }, null, 2)}\n`;
}

interface SetupOptions {
  readonly manifest?: string;
  readonly limits?: Partial<TestRunLimits>;
  readonly declining?: boolean;
  readonly codingRepairRunner?: CodingRepairRunner;
}

interface Setup {
  readonly manager: TestingManager;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly readManifest: () => Promise<string | null>;
  readonly audits: TestAuditEvent[];
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const environment = await createCodingFixtureEnvironment({ now: NOW });
  if (options.manifest !== undefined) {
    await environment.projectEngine.files.createFile(environment.workspaceId, {
      path: 'package.json',
      content: options.manifest,
    });
  }
  const audits: TestAuditEvent[] = [];
  const manager = new TestingManager({
    tools: environment.tools,
    debugAgent: options.declining === true ? createDecliningDebugAgent() : createMockDebugAgent(),
    ...(options.codingRepairRunner !== undefined
      ? { codingRepairRunner: options.codingRepairRunner }
      : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    now: NOW,
    generateRunId: () => 'testrun_1',
    onAudit: (event) => audits.push(event),
  });
  return {
    manager,
    workspaceId: environment.workspaceId,
    projectId: environment.projectId,
    audits,
    readManifest: async () => {
      try {
        const file = await environment.projectEngine.files.readFile(
          environment.workspaceId,
          'package.json',
        );
        return file.content;
      } catch {
        return null;
      }
    },
  };
}

/** Approves every pending decision until the run reaches a terminal state. */
async function approveAll(
  manager: TestingManager,
  runId: string,
  maxApprovals = 10,
): Promise<TestRunView> {
  let view = await manager.submitApproval(runId, 'approve');
  let approvals = 1;
  while (view.pendingApproval !== null && approvals < maxApprovals) {
    view = await manager.submitApproval(runId, 'approve');
    approvals += 1;
  }
  return view;
}

// ---------------------------------------------------------------------------
// A - passing project
// ---------------------------------------------------------------------------

describe('TestingManager - passing project', () => {
  it('plans, pauses for plan approval, and completes a passing run', async () => {
    const { manager, workspaceId, projectId, audits } = await setup({
      manifest: manifest({ test: 'node --version' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    expect(started.state).toBe('awaiting_approval');
    expect(started.pendingApproval).toEqual({ kind: 'plan_approval' });
    expect(started.projectType).toBe('web');
    expect(started.plan?.commands).toHaveLength(1);
    expect(started.plan?.commands[0]?.executable).toBe('node');

    const final = await approveAll(manager, started.runId);
    expect(final.state).toBe('completed');
    expect(final.results?.success).toBe(true);
    expect(final.results?.executed).toBe(true);
    expect(final.results?.results[0]?.exitCode).toBe(0);
    expect(final.repairAttempts).toBe(0);
    expect(final.failure).toBeNull();
    expect(audits.some((event) => event.type === 'testing_plan_approved')).toBe(true);
    expect(audits.some((event) => event.type === 'testing_run_completed')).toBe(true);
  });

  it('completes honestly with a note when no commands were derivable', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({}),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    const final = await approveAll(manager, started.runId);
    expect(final.state).toBe('completed');
    expect(final.results?.executed).toBe(false);
    expect(final.notes.join(' ')).toMatch(/no test commands were planned/);
  });
});

// ---------------------------------------------------------------------------
// B-G - failure, diagnosis, repair approval, repair, retest
// ---------------------------------------------------------------------------

describe('TestingManager - failing project with repair', () => {
  it('diagnoses the failure and applies an approved repair through the Coding Agent', async () => {
    const { manager, workspaceId, projectId, readManifest, audits } = await setup({
      manifest: manifest({ test: 'node --version fail' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    expect(started.pendingApproval).toEqual({ kind: 'plan_approval' });

    let view = await manager.submitApproval(started.runId, 'approve');
    // First forced sandbox.execute confirmation
    expect(view.state).toBe('awaiting_approval');
    expect(view.pendingApproval?.kind).toBe('tool_confirmation');
    view = await manager.submitApproval(started.runId, 'approve');

    // The command failed: analysis produces a diagnosis + repair proposal,
    // and the coding run pauses at its OWN plan approval = the repair gate.
    expect(view.state).toBe('awaiting_repair_approval');
    expect(view.pendingApproval?.kind).toBe('repair_approval');
    expect(view.diagnosis).not.toBeNull();
    const statements = view.diagnosis?.statements ?? [];
    expect(statements.some((statement) => statement.kind === 'fact')).toBe(true);
    expect(statements.some((statement) => statement.kind === 'inference')).toBe(true);
    expect(statements.some((statement) => statement.kind === 'recommendation')).toBe(true);
    if (view.pendingApproval?.kind !== 'repair_approval') throw new Error('unreachable');
    expect(view.pendingApproval.repairPlan.changes[0]?.path).toBe('package.json');
    expect(view.pendingApproval.repairPlan.changes[0]?.mode).toBe('update');
    expect(view.repairPlan).not.toBeNull();
    expect(view.codingRunId).not.toBeNull();

    view = await manager.submitApproval(started.runId, 'approve'); // approve the repair
    // The coding agent applied the change to the real project engine, then the
    // retest starts and pauses at its OWN forced sandbox.execute confirmation.
    expect(view.state).toBe('awaiting_approval');
    expect(view.pendingApproval?.kind).toBe('tool_confirmation');
    expect(await readManifest()).toMatch(/"test": "node --version"/);

    // Retest: re-derived from the CURRENT (repaired) manifest value
    view = await manager.submitApproval(started.runId, 'approve'); // forced confirmation
    expect(view.state).toBe('completed');
    expect(view.retestResults?.success).toBe(true);
    expect(view.repairAttempts).toBe(1);
    expect(view.failure).toBeNull();
    expect(audits.some((event) => event.type === 'testing_repair_applied')).toBe(true);
    expect(audits.some((event) => event.type === 'testing_repair_approved')).toBe(true);
    expect(audits.some((event) => event.type === 'testing_retest_started')).toBe(true);
  });

  it('fails honestly when the debug agent declines to propose a repair', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version fail' }, { react: '*' }),
      declining: true,
    });
    const started = await manager.startRun({ projectId, workspaceId });
    const final = await approveAll(manager, started.runId);
    expect(final.state).toBe('failed');
    expect(final.failure?.code).toBe('TESTING_TEST_FAILED');
    expect(final.notes.join(' ')).toMatch(/repair declined/);
    expect(final.diagnosis).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// H - bounded repair loop
// ---------------------------------------------------------------------------

describe('TestingManager - bounded repair loop', () => {
  it('stops at the repair limit instead of looping forever', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version fail fail' }, { react: '*' }),
      limits: { maxRepairAttempts: 1 },
    });
    const started = await manager.startRun({ projectId, workspaceId });
    const final = await approveAll(manager, started.runId, 12);
    expect(final.state).toBe('failed');
    expect(final.failure?.code).toBe('TESTING_REPAIR_LIMIT');
    expect(final.repairAttempts).toBe(1);
    expect(final.retestResults?.success).toBe(false);
    // The first repair DID apply (one marker removed) - bounded, not faked.
    expect(final.retestResults?.results[0]?.command.arguments).toEqual(['--version', 'fail']);
  });
});

// ---------------------------------------------------------------------------
// I - human rejects the repair
// ---------------------------------------------------------------------------

describe('TestingManager - rejected repair', () => {
  it('fails with TESTING_REPAIR_REJECTED and mutates nothing', async () => {
    const { manager, workspaceId, projectId, readManifest } = await setup({
      manifest: manifest({ test: 'node --version fail' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    let view = await approveAll(manager, started.runId, 2); // plan + execute
    expect(view.state).toBe('awaiting_repair_approval');
    const before = await readManifest();
    view = await manager.submitApproval(started.runId, 'reject');
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('TESTING_REPAIR_REJECTED');
    expect(await readManifest()).toBe(before);
    expect(view.repairAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// J - cancellation
// ---------------------------------------------------------------------------

describe('TestingManager - cancellation', () => {
  it('cancels from awaiting_approval and stays terminal', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    const cancelled = manager.cancelRun(started.runId);
    expect(cancelled.state).toBe('cancelled');
    await expect(manager.submitApproval(started.runId, 'approve')).rejects.toThrowError(
      /already terminal/,
    );
    expect(() => manager.cancelRun(started.runId)).toThrowError(TestingError);
    expect(manager.getRun(started.runId).state).toBe('cancelled');
  });

  it('cancels from awaiting_repair_approval and cancels the coding run', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version fail' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    let view = await approveAll(manager, started.runId, 2);
    expect(view.state).toBe('awaiting_repair_approval');
    view = manager.cancelRun(started.runId);
    expect(view.state).toBe('cancelled');
    expect(manager.getRun(started.runId).state).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// K - revision conflicts surface structured, no blind retry
// ---------------------------------------------------------------------------

describe('TestingManager - revision conflict', () => {
  it('maps a coding revision failure to a structured conflict result without retrying', async () => {
    let approvals = 0;
    const stubRunner: CodingRepairRunner = () => ({
      async start(): Promise<CodingRunView> {
        return {
          runId: 'coding_conflict',
          projectId: 'proj_1',
          workspaceId: 'ws_1',
          state: 'awaiting_approval',
          summary: null,
          changedFiles: [],
          validationResults: [],
          iterations: 0,
          toolCalls: 0,
          startedAt: NOW().toISOString(),
          updatedAt: NOW().toISOString(),
          pendingApproval: { kind: 'plan_approval' },
          failure: null,
        };
      },
      getRun(): CodingRunView {
        throw new Error('not needed');
      },
      async submitApproval(): Promise<CodingRunView> {
        approvals += 1;
        return {
          runId: 'coding_conflict',
          projectId: 'proj_1',
          workspaceId: 'ws_1',
          state: 'failed',
          summary: null,
          changedFiles: [],
          validationResults: [],
          iterations: 1,
          toolCalls: 1,
          startedAt: NOW().toISOString(),
          updatedAt: NOW().toISOString(),
          pendingApproval: null,
          failure: {
            code: 'CODING_STALE_REVISION',
            message: 'update_file requires the file to be read or created by this run first',
          },
        };
      },
      cancel(): CodingRunView {
        throw new Error('not needed');
      },
    });
    const { manager, workspaceId, projectId, readManifest } = await setup({
      manifest: manifest({ test: 'node --version fail' }, { react: '*' }),
      codingRepairRunner: stubRunner,
    });
    const started = await manager.startRun({ projectId, workspaceId });
    let view = await approveAll(manager, started.runId, 2);
    expect(view.state).toBe('awaiting_repair_approval');
    view = await manager.submitApproval(started.runId, 'approve');
    expect(approvals).toBe(1);
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('TESTING_REVISION_CONFLICT');
    expect(view.revisionConflict).not.toBeNull();
    expect(view.repairAttempts).toBe(0);
    // No file was overwritten and no retry happened
    expect(await readManifest()).toMatch(/node --version fail/);
    await expect(manager.submitApproval(started.runId, 'approve')).rejects.toThrowError(
      /already terminal/,
    );
  });
});

// ---------------------------------------------------------------------------
// L - sandbox confirmation pause + resume (and rejection)
// ---------------------------------------------------------------------------

describe('TestingManager - forced tool confirmations', () => {
  it('pauses before sandbox.execute and resumes with the stored input exactly once', async () => {
    const { manager, workspaceId, projectId, audits } = await setup({
      manifest: manifest({ test: 'node --version' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    let view = await manager.submitApproval(started.runId, 'approve'); // plan
    expect(view.state).toBe('awaiting_approval');
    expect(view.pendingApproval?.kind).toBe('tool_confirmation');
    expect(view.commandsExecuted).toBe(0);
    view = await manager.submitApproval(started.runId, 'approve'); // execute
    expect(view.state).toBe('completed');
    expect(view.commandsExecuted).toBe(1);
    expect(view.results?.results).toHaveLength(1);
    expect(audits.filter((event) => event.type === 'testing_command_executed')).toHaveLength(1);
  });

  it('fails honestly when a human rejects the pending confirmation', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    await manager.submitApproval(started.runId, 'approve'); // plan
    const view = await manager.submitApproval(started.runId, 'reject'); // reject execute
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('TESTING_TEST_FAILED');
    expect(view.commandsExecuted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// limits + plan rejection + unsupported projects
// ---------------------------------------------------------------------------

describe('TestingManager - limits, rejections, unsupported projects', () => {
  it('enforces the hard command limit', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version', build: 'node --version' }, { react: '*' }),
      limits: { maxCommands: 1 },
    });
    const started = await manager.startRun({ projectId, workspaceId });
    expect(started.plan?.commands).toHaveLength(2);
    const final = await approveAll(manager, started.runId, 6);
    expect(final.state).toBe('failed');
    expect(final.failure?.code).toBe('TESTING_COMMAND_LIMIT');
  });

  it('fails the run when the human rejects the test plan', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version' }, { react: '*' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    const view = await manager.submitApproval(started.runId, 'reject');
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('TESTING_PLAN_REJECTED');
  });

  it('fails honestly for an undetectable project', async () => {
    const { manager, workspaceId, projectId } = await setup();
    const view = await manager.startRun({ projectId, workspaceId });
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('TESTING_UNSUPPORTED_PROJECT');
  });

  it('rejects invalid requests and duplicate run ids', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version' }),
    });
    await expect(manager.startRun({ projectId: '', workspaceId })).rejects.toThrowError(
      TestingError,
    );
    await manager.startRun({ runId: 'dup', projectId, workspaceId });
    await expect(manager.startRun({ runId: 'dup', projectId, workspaceId })).rejects.toThrowError(
      /already exists/,
    );
  });

  it('throws typed errors for unknown runs and premature plan reads', async () => {
    const { manager } = await setup();
    expect(() => manager.getRun('nope')).toThrowError(/no test run/);
    await expect(manager.submitApproval('nope', 'approve')).rejects.toThrowError(TestingError);
  });

  it('plans honestly (no commands) for a non-derivable test script', async () => {
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'bash run.sh' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    expect(started.plan?.commands).toHaveLength(0);
    expect(started.notes.join(' ')).toMatch(/not a derivable bare command/);
    const final = await approveAll(manager, started.runId);
    expect(final.state).toBe('completed');
  });

  it('never reaches the sandbox with secret-shaped script material', async () => {
    // parseScriptCommand rejects secret-shaped arguments BEFORE any execution
    // (covered at unit level); a secret inside the manifest makes the content
    // unparseable through the Tool System, so the run stays validation-only.
    const { manager, workspaceId, projectId } = await setup({
      manifest: manifest({ test: 'node --version ghp_abcdefghijklmnopqrst' }),
    });
    const started = await manager.startRun({ projectId, workspaceId });
    expect(started.plan?.commands).toHaveLength(0);
    expect(started.state).toBe('awaiting_approval');
    const final = await approveAll(manager, started.runId);
    expect(final.state).toBe('completed');
    expect(final.commandsExecuted).toBe(0);
  });
});
