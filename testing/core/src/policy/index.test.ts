import { describe, expect, it } from 'vitest';

import { TestingError, isSecretShaped } from '../errors/index.js';
import {
  resolveTestRunLimits,
  validateDiagnosis,
  validateRepairPlan,
  validateTestCommand,
  validateTestRunRequest,
} from './index.js';
import type { Diagnosis, RepairPlan, TestCommand, TestRunLimits } from '../types/index.js';

const COMMAND: TestCommand = {
  executable: 'node',
  arguments: ['--version'],
  purpose: 'test',
  label: 'runtime check',
};

function makeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    category: 'test_failure',
    summary: 'The test command failed',
    statements: [
      { kind: 'fact', text: 'The command exited with code 1' },
      {
        kind: 'inference',
        text: 'The script contains a marker argument',
        confidence: 'high',
      },
      { kind: 'recommendation', text: 'Remove the marker and retest' },
    ],
    affectedPaths: ['package.json'],
    confidence: 'high',
    recommendedAction: 'Approve the repair',
    ...overrides,
  };
}

function makeRepairPlan(overrides: Partial<RepairPlan> = {}): RepairPlan {
  return {
    diagnosis: makeDiagnosis(),
    changes: [
      {
        path: 'package.json',
        mode: 'update',
        content: '{}\n',
        reason: 'Fix the test script',
        expectedEffect: 'The command succeeds',
      },
    ],
    risk: 'low',
    scope: 'single-file',
    verificationPlan: 'Rerun the test script',
    testsToRerun: ['runtime check'],
    ...overrides,
  };
}

describe('validateTestRunRequest', () => {
  it('accepts a valid request and optional run id', () => {
    expect(validateTestRunRequest({ projectId: 'proj_1', workspaceId: 'ws_1' })).toEqual({
      projectId: 'proj_1',
      workspaceId: 'ws_1',
    });
    expect(
      validateTestRunRequest({ runId: 'run_1', projectId: 'proj_1', workspaceId: 'ws_1' }),
    ).toEqual({ runId: 'run_1', projectId: 'proj_1', workspaceId: 'ws_1' });
  });

  it('rejects missing or malformed ids', () => {
    expect(() => validateTestRunRequest({ projectId: '', workspaceId: 'ws_1' })).toThrowError(
      TestingError,
    );
    expect(() =>
      validateTestRunRequest({ projectId: '../escape', workspaceId: 'ws_1' }),
    ).toThrowError(/valid ids/);
  });
});

describe('validateTestCommand', () => {
  it('accepts a structural command', () => {
    expect(validateTestCommand(COMMAND)).toBe(COMMAND);
  });

  it('rejects shell-shaped arguments and path executables', () => {
    expect(() => validateTestCommand({ ...COMMAND, executable: '/bin/sh' })).toThrowError(
      /bare allowlisted-style/,
    );
    expect(() => validateTestCommand({ ...COMMAND, arguments: ['a; rm -rf /'] })).toThrowError(
      /shell-shaped/,
    );
    expect(() => validateTestCommand({ ...COMMAND, arguments: ['x && y'] })).toThrowError(
      TestingError,
    );
  });

  it('rejects secret-shaped command material', () => {
    expect(() =>
      validateTestCommand({ ...COMMAND, arguments: ['ghp_abcdefghijklmnopqrst'] }),
    ).toThrowError(/secret-shaped/);
  });
});

describe('resolveTestRunLimits', () => {
  it('clamps every limit to its hard ceiling', () => {
    const limits = resolveTestRunLimits({
      maxRepairAttempts: 999,
      maxCommands: 9999,
      maxDebugFiles: 999,
      maxCommandTimeoutMs: 999_999,
    } satisfies Partial<TestRunLimits>);
    expect(limits).toEqual({
      maxRepairAttempts: 10,
      maxCommands: 64,
      maxDebugFiles: 8,
      maxCommandTimeoutMs: 120_000,
    });
  });

  it('rejects non-positive values', () => {
    expect(() => resolveTestRunLimits({ maxRepairAttempts: 0 })).toThrowError(TestingError);
    expect(() => resolveTestRunLimits({ maxCommands: -1 as unknown as number })).toThrowError(
      TestingError,
    );
  });
});

describe('validateDiagnosis', () => {
  it('accepts a well-formed diagnosis', () => {
    expect(validateDiagnosis(makeDiagnosis())).toBeInstanceOf(Object);
  });

  it('requires confidence on inference statements', () => {
    const diagnosis = makeDiagnosis({
      statements: [{ kind: 'inference', text: 'a guess' }],
    });
    expect(() => validateDiagnosis(diagnosis)).toThrowError(/must carry a confidence/);
  });

  it('rejects unknown categories and empty statement lists', () => {
    expect(() =>
      validateDiagnosis(makeDiagnosis({ category: 'cosmic_rays' as never })),
    ).toThrowError(/unknown failure category/);
    expect(() => validateDiagnosis(makeDiagnosis({ statements: [] }))).toThrowError(
      /at least one statement/,
    );
  });

  it('rejects secret-shaped diagnosis text', () => {
    const diagnosis = makeDiagnosis({
      statements: [{ kind: 'fact', text: 'found key ghp_abcdefghijklmnopqrst in output' }],
    });
    expect(() => validateDiagnosis(diagnosis)).toThrowError(/secret-shaped/);
  });
});

describe('validateRepairPlan', () => {
  it('accepts a well-formed plan', () => {
    expect(validateRepairPlan(makeRepairPlan())).toBeInstanceOf(Object);
  });

  it('requires at least one bounded change', () => {
    expect(() => validateRepairPlan(makeRepairPlan({ changes: [] }))).toThrowError(
      /at least one change/,
    );
    const tooMany = Array.from({ length: 9 }, (_, index) =>
      makeRepairPlan().changes[0] !== undefined
        ? { ...makeRepairPlan().changes[0]!, path: `file-${index}.json` }
        : undefined,
    );
    expect(() => validateRepairPlan(makeRepairPlan({ changes: tooMany as never }))).toThrowError(
      /too many repair changes/,
    );
  });

  it('rejects duplicate paths and unknown modes', () => {
    const change = makeRepairPlan().changes[0] as NonNullable<RepairPlan['changes'][number]>;
    expect(() => validateRepairPlan(makeRepairPlan({ changes: [change, change] }))).toThrowError(
      /duplicate change path/,
    );
    expect(() =>
      validateRepairPlan(
        makeRepairPlan({
          changes: [{ ...change, mode: 'delete' as never }],
        }),
      ),
    ).toThrowError(/unknown change mode/);
  });

  it('rejects secret-shaped repair content', () => {
    const change = makeRepairPlan().changes[0] as NonNullable<RepairPlan['changes'][number]>;
    expect(() =>
      validateRepairPlan(
        makeRepairPlan({
          changes: [{ ...change, content: 'const k = "ghp_abcdefghijklmnopqrst";\n' }],
        }),
      ),
    ).toThrowError(/secret-shaped/);
  });
});

describe('secret detection', () => {
  it('recognizes the documented secret shapes', () => {
    expect(isSecretShaped('ghp_abcdefghijklmnopqrst')).toBe(true);
    expect(isSecretShaped('sk-abcdefghijklmnopqrstuv')).toBe(true);
    expect(isSecretShaped('plain node --version')).toBe(false);
  });
});
