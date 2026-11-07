import { describe, expect, it } from 'vitest';

import { buildDiagnosis, compareRuns, repairBudget } from './compare.js';
import { detectPackageManager, detectVerificationProfile } from './discovery.js';
import { interpretOutcome, parseTestCounts, parseTypeScriptErrors } from './parsers.js';
import { planVerification, validatePathFilter, validateVerificationCommand } from './policy.js';
import { VerificationRunner } from './runner.js';
import { boundedTail, scrubSecrets } from './sanitize.js';
import { InMemoryVerificationStore } from './store.js';
import type {
  OperationResult,
  ProjectFile,
  RawExecution,
  VerificationCommand,
  VerificationExecutor,
  VerificationRunRecord,
  VerificationSession,
} from './types.js';

const file = (path: string, content: unknown): ProjectFile => ({
  path,
  content: typeof content === 'string' ? content : JSON.stringify(content),
});

const npmProject: ProjectFile[] = [
  file('package.json', {
    name: 'demo',
    scripts: {
      test: 'vitest run',
      lint: 'eslint .',
      build: 'next build',
      'test:e2e': 'playwright test',
    },
    devDependencies: { vitest: '^3.0.0', eslint: '^9.0.0', typescript: '^5.0.0', next: '^15.0.0' },
  }),
  file('package-lock.json', '{}'),
  file('tsconfig.json', '{}'),
  file('vitest.config.ts', 'export default {}'),
];

function executorWith(
  runs: Readonly<Record<string, Partial<RawExecution>>>,
): VerificationExecutor & { readonly calls: { command: string; args: readonly string[] }[] } {
  const calls: { command: string; args: readonly string[] }[] = [];
  const sessions: VerificationSession[] = [];
  return {
    calls,
    async prepare() {
      const session: VerificationSession = {
        handle: {},
        runtimeId: 'fake-runtime',
        providesOsIsolation: false,
        unenforced: ['network', 'memory'],
        dispose: async () => undefined,
      };
      sessions.push(session);
      return session;
    },
    async execute(_session, command) {
      calls.push({ command: command.command, args: [...command.args] });
      const key = `${command.command} ${command.args.join(' ')}`;
      const scripted = runs[key] ?? { exitCode: 0, stdout: 'ok', stderr: '' };
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 12,
        enforceableTimeout: true,
        runtimeId: 'fake-runtime',
        providesOsIsolation: false,
        unenforced: ['network', 'memory'],
        ...scripted,
      };
    },
  };
}

describe('test discovery', () => {
  it('reads declared scripts and detects the framework', () => {
    const profile = detectVerificationProfile(npmProject);
    expect(profile.packageManager).toBe('npm');
    expect(profile.framework).toBe('next');
    expect(profile.testFrameworks).toContain('vitest');
    expect(profile.confidence).toBe('high');
    const unit = profile.commands.find((command) => command.operation === 'unit');
    expect(unit).toMatchObject({
      command: 'npm',
      args: ['run', 'test', '--silent'],
      source: 'script',
    });
    expect(profile.commands.map((command) => command.operation)).toEqual([
      'unit',
      'e2e',
      'typecheck',
      'lint',
      'build',
      'deps',
    ]);
  });

  it('detects pnpm and yarn from lockfiles, and honours packageManager', () => {
    expect(detectPackageManager([file('pnpm-lock.yaml', '')], null).packageManager).toBe('pnpm');
    expect(detectPackageManager([file('yarn.lock', '')], null).packageManager).toBe('yarn');
    expect(
      detectPackageManager([file('package.json', {})], { packageManager: 'bun@1.1.0' })
        .packageManager,
    ).toBe('bun');
  });

  it('never invents a test command for a project without tests', () => {
    const profile = detectVerificationProfile([
      file('package.json', { name: 'empty', scripts: {} }),
      file('tsconfig.json', '{}'),
    ]);
    expect(profile.commands.map((command) => command.operation)).not.toContain('unit');
    const unit = profile.unsupported.find((entry) => entry.operation === 'unit');
    expect(unit?.reason).toContain('no test framework');
    expect(profile.confidence).toBe('medium');
  });

  it('reports no profile for a project with no package.json', () => {
    const profile = detectVerificationProfile([file('README.md', '# hi')]);
    expect(profile.confidence).toBe('none');
    expect(profile.commands).toHaveLength(0);
    expect(profile.missing).toContain('package.json');
  });

  it('offers tsc only when TypeScript is a dependency and tsconfig exists', () => {
    const withTs = detectVerificationProfile([
      file('package.json', { scripts: {}, devDependencies: { typescript: '^5' } }),
      file('tsconfig.json', '{}'),
    ]);
    expect(withTs.commands.find((command) => command.operation === 'typecheck')).toMatchObject({
      command: 'npx',
      args: ['tsc', '--noEmit', '--pretty', 'false'],
    });
    const withoutTs = detectVerificationProfile([
      file('package.json', { scripts: {} }),
      file('tsconfig.json', '{}'),
    ]);
    expect(withoutTs.unsupported.map((entry) => entry.operation)).toContain('typecheck');
  });

  it('does not offer e2e for a monolithic test script', () => {
    const profile = detectVerificationProfile([
      file('package.json', { scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }),
    ]);
    expect(profile.testFrameworks).toContain('jest');
    expect(profile.unsupported.map((entry) => entry.operation)).toContain('e2e');
  });
});

const command = (over: Partial<VerificationCommand> = {}): VerificationCommand => ({
  id: 'npm:test',
  operation: 'unit',
  command: 'npm',
  args: ['run', 'test', '--silent'],
  source: 'script',
  label: 'npm run test',
  confidence: 'high',
  acceptsPath: false,
  ...over,
});

describe('command policy', () => {
  it('accepts an allowlisted, shell-free command', () => {
    expect(validateVerificationCommand(command()).ok).toBe(true);
  });

  it('refuses shell interpreters and unlisted executables', () => {
    const shell = validateVerificationCommand(command({ command: 'bash' }));
    expect(shell.ok).toBe(false);
    if (!shell.ok) expect(shell.refusal.code).toBe('COMMAND_DENIED');
    const unknown = validateVerificationCommand(command({ command: 'nc' }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.refusal.code).toBe('COMMAND_DENIED');
  });

  it('refuses an executable given as a path', () => {
    const result = validateVerificationCommand(command({ command: './node_modules/.bin/vitest' }));
    expect(result.ok).toBe(false);
  });

  it('refuses injected arguments and absolute paths', () => {
    const injected = validateVerificationCommand(command({ args: ['run', 'test', '&&', 'curl'] }));
    expect(injected.ok).toBe(false);
    if (!injected.ok) expect(injected.refusal.code).toBe('ARGUMENT_INVALID');

    const substitution = validateVerificationCommand(command({ args: ['run', '$(whoami)'] }));
    expect(substitution.ok).toBe(false);

    const absolute = validateVerificationCommand(command({ args: ['run', '/etc/passwd'] }));
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) expect(absolute.refusal.code).toBe('PATH_INVALID');
  });

  it('refuses path filters that leave the project', () => {
    expect(validatePathFilter('src/app.test.ts').ok).toBe(true);
    expect(validatePathFilter('../etc/passwd').ok).toBe(false);
    expect(validatePathFilter('/etc/passwd').ok).toBe(false);
    expect(validatePathFilter('src/*.ts').ok).toBe(false);
  });

  it('keeps unauthorized operations out of the plan', () => {
    const profile = detectVerificationProfile(npmProject);
    const plan = planVerification({
      profile,
      requested: ['unit', 'build'],
      authorized: ['unit'],
      limits: { maxOperations: 4 },
    });
    expect(plan.commands.map((entry) => entry.operation)).toEqual(['unit']);
    expect(plan.blocked[0]).toMatchObject({ operation: 'build', reason: 'not_authorized' });
  });

  it('refuses unknown operations and unknown project capabilities by name', () => {
    const profile = detectVerificationProfile(npmProject);
    const plan = planVerification({
      profile,
      requested: ['shell', 'deploy', 'format'],
      authorized: null,
      limits: { maxOperations: 4 },
    });
    expect(plan.commands).toHaveLength(0);
    const reasons = plan.blocked.map((entry) => `${entry.operation}:${entry.reason}`);
    expect(reasons).toContain('shell:not_in_profile');
    expect(reasons).toContain('deploy:not_in_profile');
    expect(plan.blocked.find((entry) => entry.operation === 'format')?.detail).toContain(
      'not configured',
    );
  });

  it('enforces the operation limit', () => {
    const profile = detectVerificationProfile(npmProject);
    const plan = planVerification({
      profile,
      requested: ['unit', 'lint', 'build'],
      authorized: null,
      limits: { maxOperations: 2 },
    });
    expect(plan.commands).toHaveLength(2);
    expect(plan.blocked[0]).toMatchObject({ operation: 'build', reason: 'limit_reached' });
  });

  it('appends a validated path filter only where the command accepts one', () => {
    const profile = detectVerificationProfile(npmProject);
    const plan = planVerification({
      profile,
      requested: ['unit', 'lint'],
      authorized: null,
      limits: { maxOperations: 4 },
      path: 'src/app.test.ts',
    });
    expect(plan.commands[0]?.args).toEqual(['run', 'test', '--silent', '--', 'src/app.test.ts']);
    expect(plan.commands[1]?.args).toEqual(['run', 'lint', '--silent']);
  });
});

describe('output interpretation', () => {
  it('reads vitest, jest, playwright and node summaries', () => {
    expect(parseTestCounts('Tests  2 failed | 12 passed (14)')).toMatchObject({
      passed: 12,
      failed: 2,
      discovered: 14,
    });
    expect(parseTestCounts('Tests:       1 failed, 2 passed, 3 total')).toMatchObject({
      passed: 2,
      failed: 1,
      discovered: 3,
    });
    expect(parseTestCounts('  5 passed (12.3s)\n  1 failed')).toMatchObject({
      passed: 5,
      failed: 1,
      discovered: 6,
    });
    expect(parseTestCounts('# pass 3\n# fail 1\n# tests 4')).toMatchObject({
      passed: 3,
      failed: 1,
      discovered: 4,
    });
  });

  it('never turns a failure into a pass because of a summary line', () => {
    const outcome = interpretOutcome({
      operation: 'unit',
      exitCode: 1,
      stdout: 'Tests  14 passed (14)',
      stderr: '',
      timedOut: false,
      truncated: false,
    });
    expect(outcome.status).toBe('failed');
  });

  it('reports timed out and incomplete outcomes without claiming a result', () => {
    expect(
      interpretOutcome({
        operation: 'unit',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        truncated: false,
      }).status,
    ).toBe('timed_out');
    expect(
      interpretOutcome({
        operation: 'unit',
        exitCode: null,
        stdout: '',
        stderr: 'spawn failed',
        timedOut: false,
        truncated: false,
      }).status,
    ).toBe('incomplete');
  });

  it('counts TypeScript errors', () => {
    expect(parseTypeScriptErrors('Found 3 errors in 2 files.')).toBe(3);
    expect(parseTypeScriptErrors('src/a.ts(1,2): error TS2322: bad')).toBe(1);
  });

  it('scrubs secrets and bounds output', () => {
    const scrubbed = scrubSecrets('token sk-abcdefghijklmnop and Bearer abcdefghijklmnop');
    expect(scrubbed.text).not.toContain('sk-abcdefghijklmnop');
    expect(scrubbed.text).not.toContain('abcdefghijklmnop');
    expect(scrubbed.removed).toBeGreaterThan(0);
    const tail = boundedTail('a\nb\nc', 3);
    expect(tail.truncated).toBe(true);
  });
});

describe('verification runner', () => {
  const store = (): InMemoryVerificationStore => new InMemoryVerificationStore();
  const files = {
    async read() {
      return { files: npmProject, revision: 'rev-1' };
    },
  };

  it('records a passing run as evidence with real counts', async () => {
    const executor = executorWith({
      'npm run test --silent': { exitCode: 0, stdout: 'Tests  3 passed (3)', stderr: '' },
      'npm run lint --silent': { exitCode: 0, stdout: '', stderr: '' },
    });
    const runner = new VerificationRunner({ executor, files, store: store() });
    const record = await runner.run({
      ownerRef: 'owner-1',
      projectId: 'project-1',
      operations: ['unit', 'lint'],
    });
    expect(record.status).toBe('passed');
    expect(record.revision).toBe('rev-1');
    expect(record.evidence).toMatchObject({ executed: true, executedCount: 2, passedCount: 2 });
    expect(record.results[0]?.counts).toMatchObject({ passed: 3, discovered: 3 });
    expect(executor.calls).toHaveLength(2);
  });

  it('records a failing run with the parsed failure and a diagnosis brief', async () => {
    const executor = executorWith({
      'npm run test --silent': {
        exitCode: 1,
        stdout: 'FAIL src/app.test.ts\nTests  1 failed | 2 passed (3)',
        stderr: '',
      },
    });
    const runner = new VerificationRunner({ executor, files, store: store() });
    const record = await runner.run({
      ownerRef: 'owner-1',
      projectId: 'project-1',
      operations: ['unit'],
    });
    expect(record.status).toBe('failed');
    expect(record.results[0]?.counts).toMatchObject({ failed: 1, passed: 2 });
    const diagnosis = buildDiagnosis(record);
    expect(diagnosis.repairable).toBe(true);
    expect(diagnosis.failures[0]?.files).toContain('src/app.test.ts');
    expect(diagnosis.brief).toContain('failed');
  });

  it('reports blocked when nothing could run, and never executes', async () => {
    const executor = executorWith({});
    const runner = new VerificationRunner({ executor, files, store: store() });
    const record = await runner.run({
      ownerRef: 'owner-1',
      projectId: 'project-1',
      operations: ['format'],
    });
    expect(record.status).toBe('blocked');
    expect(record.evidence).toMatchObject({ executed: false, executedCount: 0 });
    expect(executor.calls).toHaveLength(0);
  });

  it('marks a timed-out command and the run', async () => {
    const executor = executorWith({
      'npm run test --silent': { exitCode: null, timedOut: true, stdout: '', stderr: '' },
    });
    const runner = new VerificationRunner({ executor, files, store: store() });
    const record = await runner.run({
      ownerRef: 'owner-1',
      projectId: 'project-1',
      operations: ['unit'],
    });
    expect(record.results[0]?.status).toBe('timed_out');
    expect(record.status).toBe('timed_out');
  });

  it('records partial work when one operation passes and another never runs', async () => {
    const executor = executorWith({
      'npm run test --silent': { exitCode: 0, stdout: 'Tests  1 passed (1)', stderr: '' },
    });
    const runner = new VerificationRunner({ executor, files, store: store() });
    const record = await runner.run({
      ownerRef: 'owner-1',
      projectId: 'project-1',
      operations: ['unit', 'format'],
    });
    expect(record.status).toBe('incomplete');
    expect(record.results.map((result) => result.status)).toEqual(['passed']);
    expect(record.blocked[0]?.operation).toBe('format');
  });

  it('clamps requested limits to the hard ceilings', async () => {
    const executor = executorWith({});
    const runner = new VerificationRunner({ executor, files, store: store() });
    const record = await runner.run({
      ownerRef: 'owner-1',
      projectId: 'project-1',
      operations: ['unit'],
      limits: { maxOperations: 99, timeoutMsPerOperation: 10_000_000, maxRepairAttempts: 99 },
    });
    expect(record.limits).toMatchObject({
      maxOperations: 8,
      timeoutMsPerOperation: 900_000,
      maxRepairAttempts: 3,
    });
  });

  it('keeps every owner separated', async () => {
    const shared = store();
    const executor = executorWith({});
    const runner = new VerificationRunner({ executor, files, store: shared });
    const record = await runner.run({ ownerRef: 'owner-1', projectId: 'p', operations: ['unit'] });
    expect(await runner.cancel('owner-2', record.id)).toBeNull();
    expect(await shared.list('owner-2')).toHaveLength(0);
  });
});

const result = (over: Partial<OperationResult>): OperationResult => ({
  operation: 'unit',
  commandId: 'npm:test',
  label: 'npm run test',
  argv: ['npm', 'run', 'test'],
  status: 'failed',
  exitCode: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1000,
  counts: { discovered: 1, passed: 0, failed: 1, skipped: null },
  buildStatus: 'not_applicable',
  errorSummary: 'FAIL src/app.test.ts',
  outputTail: 'FAIL src/app.test.ts',
  outputBytes: 40,
  truncated: false,
  reason: null,
  runtimeId: 'fake-runtime',
  providesOsIsolation: false,
  unenforced: [],
  ...over,
});

const run = (over: Partial<VerificationRunRecord> = {}): VerificationRunRecord => ({
  id: 'run-1',
  ownerRef: 'owner-1',
  projectId: 'project-1',
  taskId: null,
  workerId: null,
  revision: 'rev-1',
  status: 'failed',
  requestedOperations: ['unit'],
  blocked: [],
  results: [result({})],
  evidence: null,
  repairsRunId: null,
  attempt: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  limits: {
    maxOperations: 6,
    timeoutMsPerOperation: 1000,
    maxOutputBytes: 1000,
    maxRepairAttempts: 2,
  },
  version: 1,
  ...over,
});

describe('repair comparison', () => {
  it('reports a resolved failure', () => {
    const comparison = compareRuns(
      run({ id: 'a' }),
      run({
        id: 'b',
        status: 'passed',
        results: [result({ status: 'passed', exitCode: 0, errorSummary: null })],
      }),
    );
    expect(comparison.resolved).toEqual(['unit']);
    expect(comparison.improved).toBe(true);
  });

  it('never hides a regression behind an unrelated pass', () => {
    const previous = run({
      id: 'a',
      results: [
        result({ operation: 'unit' }),
        result({ operation: 'build', status: 'passed', exitCode: 0, errorSummary: null }),
      ],
    });
    const current = run({
      id: 'b',
      results: [
        result({ operation: 'unit', status: 'passed', exitCode: 0, errorSummary: null }),
        result({ operation: 'build', status: 'failed', errorSummary: 'build broke' }),
      ],
    });
    const comparison = compareRuns(previous, current);
    expect(comparison.resolved).toEqual(['unit']);
    expect(comparison.regressed).toEqual(['build']);
    expect(comparison.improved).toBe(false);
  });

  it('bounds repair attempts', () => {
    expect(repairBudget(run({ attempt: 0 })).allowed).toBe(true);
    expect(repairBudget(run({ attempt: 2 }))).toMatchObject({ allowed: false, remaining: 0 });
    expect(repairBudget(run({ status: 'passed' })).allowed).toBe(false);
  });
});
