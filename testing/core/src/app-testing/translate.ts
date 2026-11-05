/**
 * Turns a finished (or stopped) Step 14 testing run into an application-testing
 * report.
 *
 * This is a TRANSLATOR, not a runner. It never executes anything, never calls
 * the sandbox and never moves a run forward: the Step 14 TestingManager stays
 * the only thing that runs commands and the only thing that applies repairs.
 * Keeping it a pure function over plain data is what makes "no second
 * execution path" true by construction.
 *
 * Mapping rules, stated once:
 *  - A command that ran and whose output a runner parser recognised yields one
 *    result per test the output really contains.
 *  - A command that ran but whose output cannot be read yields ONE whole-command
 *    result (passed or failed by exit code). Tests are never invented.
 *  - A command that did not run is SKIPPED, with the reason.
 *  - Validation and build commands count as results too; a failing type check
 *    is a real failure.
 */

import type {
  TestCommandResult,
  TestPassResult,
  TestRunView,
  TestRunState,
} from '../types/index.js';
import { analyseFailure } from './failure-analysis.js';
import { parseTestOutput } from './output-parser.js';
import { bugFromFailedTest, bugFromFinding, buildReport, compareRegression } from './report.js';
import {
  APP_TEST_LIMITS,
  type AppInspection,
  type AppTestReport,
  type AppTestResult,
  type Bug,
  type ExecutionEnvironment,
  type RegressionResult,
  type SecurityFinding,
  type TestKind,
  type TestRunner,
} from './types.js';

export interface TranslateInput {
  readonly run: TestRunView;
  readonly inspection: AppInspection;
  readonly findings: readonly SecurityFinding[];
  readonly environment: ExecutionEnvironment;
  /** Project file paths, used to tell project frames from library frames. */
  readonly knownFiles: readonly string[];
  readonly generatedAt: string;
}

const NEVER_STARTED: ReadonlySet<TestRunState> = new Set([
  'created',
  'planning',
  'awaiting_approval',
  'approved',
]);

function kindFor(result: TestCommandResult): TestKind {
  return result.purpose === 'test' ? 'unit' : 'integration';
}

function boundedOutput(result: TestCommandResult): string {
  return [result.stdoutSummary, result.stderrSummary].filter((part) => part.length > 0).join('\n');
}

/** One command result as application-test results. */
export function resultsFromCommand(
  result: TestCommandResult,
  runner: TestRunner,
  prefix: string,
): readonly AppTestResult[] {
  if (!result.executed) {
    return [
      {
        id: `${prefix}-c${result.index}`,
        kind: kindFor(result),
        title: result.label,
        outcome: 'skipped',
        skipReason: 'The command did not run.',
        error: null,
        durationMs: null,
      },
    ];
  }

  // Only the project's test command is read as per-test output. A build or
  // validation command is one result: it either succeeded or it did not.
  if (result.purpose === 'test') {
    const parsed = parseTestOutput(runner, boundedOutput(result));
    if (parsed.recognised && parsed.tests.length > 0) {
      // Keep each parsed test as read; only the id changes, so it stays unique
      // across commands and lines up between the first run and a retest.
      return parsed.tests.map((test) => ({
        ...test,
        id: `${prefix}-c${result.index}-${test.id}`,
        skipReason:
          test.outcome === 'skipped' ? (test.skipReason ?? 'Skipped by the runner.') : null,
      }));
    }
  }

  const failedHard = result.timedOut || result.terminated || !result.success;
  const error = result.timedOut
    ? 'The command timed out.'
    : result.terminated
      ? 'The command was stopped before it finished.'
      : !result.success
        ? `The command exited with code ${result.exitCode ?? 'unknown'}.${
            boundedOutput(result).length > 0 ? ` ${boundedOutput(result)}` : ''
          }`
        : null;
  return [
    {
      id: `${prefix}-c${result.index}`,
      kind: kindFor(result),
      title: `${result.label} (whole command)`,
      outcome: failedHard ? 'failed' : 'passed',
      skipReason: null,
      error: error === null ? null : error.slice(0, 600),
      durationMs: null,
    },
  ];
}

export function resultsFromPass(
  pass: TestPassResult | null,
  runner: TestRunner,
  prefix: string,
): readonly AppTestResult[] {
  if (pass === null) return [];
  return pass.results
    .flatMap((result) => resultsFromCommand(result, runner, prefix))
    .slice(0, APP_TEST_LIMITS.maxTests * 2);
}

function blockedReason(run: TestRunView, tests: readonly AppTestResult[]): string | null {
  if (run.state === 'failed' && run.results === null) {
    return run.failure?.message
      ? `The run stopped before any command ran: ${run.failure.message}`
      : 'The run stopped before any command ran.';
  }
  if (NEVER_STARTED.has(run.state)) {
    return run.state === 'awaiting_approval'
      ? 'The test plan is waiting for a person to approve it, so nothing has run yet.'
      : 'The run has not started executing commands yet.';
  }
  if (run.state === 'completed' && tests.length === 0) {
    return 'The run finished without running any command.';
  }
  return null;
}

/**
 * Builds the report for a run. The first pass is "before", the retest (after an
 * approved repair) is "after", and the regression comparison is made between
 * them; it only counts as having run when both exist.
 */
export function translateRun(input: TranslateInput): AppTestReport {
  const { run, inspection } = input;
  const runner: TestRunner = inspection.testRunner;
  const before = resultsFromPass(run.results, runner, 'a');
  const after = resultsFromPass(run.retestResults, runner, 'a');
  const repairApplied = run.retestResults !== null;
  // The latest results are the retest when there is one.
  const tests = repairApplied ? after : before;

  const regression: RegressionResult = repairApplied
    ? compareRegression(before, after)
    : {
        ran: false,
        total: 0,
        passed: 0,
        failed: 0,
        regressed: [],
        fixed: [],
        note: 'No repair has been applied, so there was nothing to re-check.',
      };

  const bugs: Bug[] = [];
  tests
    .filter((test) => test.outcome === 'failed')
    .forEach((test, index) => {
      const analysis = analyseFailure(test, input.knownFiles);
      const bug = bugFromFailedTest(test, analysis.affectedFiles, index);
      bugs.push({
        ...bug,
        summary: analysis.likelyCause.length > 0 ? analysis.likelyCause : bug.summary,
        recommendation:
          analysis.recommendation.length > 0 ? analysis.recommendation : bug.recommendation,
      });
    });
  input.findings.forEach((finding, index) => bugs.push(bugFromFinding(finding, index)));

  return buildReport({
    projectId: run.projectId,
    runId: run.runId,
    cancelled: run.state === 'cancelled',
    blockedReason: run.state === 'cancelled' ? null : blockedReason(run, tests),
    tests,
    environment: input.environment,
    repairApplied,
    regression,
    bugs,
    findings: input.findings,
    generatedAt: input.generatedAt,
  });
}
