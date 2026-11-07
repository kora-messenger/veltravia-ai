/**
 * Output interpretation - Step 45.
 *
 * Test runners and compilers each print their own summary. These parsers read
 * the last summary line they can find and return numbers only when the line is
 * unambiguous; otherwise the counts stay null and the exit code decides the
 * status. A parser never upgrades a failure into a pass.
 */

import type { BuildStatus, OperationStatus, TestCounts } from './types.js';

export const EMPTY_COUNTS: TestCounts = {
  discovered: null,
  passed: null,
  failed: null,
  skipped: null,
};

function number(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

/** Reads the tail of the output; summaries live at the end. */
function tail(output: string, limit = 4_000): string {
  return output.length <= limit ? output : output.slice(output.length - limit);
}

/** Vitest: "Tests  2 failed | 12 passed (14)" or "Tests  14 passed (14)". */
function parseVitest(text: string): TestCounts | null {
  const match = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(?:(\d+)\s+passed\s*)?\((\d+)\)/.exec(text);
  if (match === null) return null;
  const failed = number(match[1]) ?? 0;
  const passed = number(match[2]) ?? 0;
  return { discovered: number(match[3]), passed, failed, skipped: null };
}

/** Jest: "Tests:       1 failed, 2 passed, 3 total". */
function parseJest(text: string): TestCounts | null {
  const line = /Tests:\s+([^\n]+)/.exec(text);
  if (line === null) return null;
  const body = line[1] ?? '';
  const failed = number(/(\d+)\s+failed/.exec(body)?.[1]);
  const passed = number(/(\d+)\s+passed/.exec(body)?.[1]);
  const skipped = number(/(\d+)\s+skipped/.exec(body)?.[1]);
  const total = number(/(\d+)\s+total/.exec(body)?.[1]);
  if (failed === null && passed === null && total === null) return null;
  return { discovered: total, passed: passed ?? 0, failed: failed ?? 0, skipped };
}

/** Playwright: "  2 failed" / "  5 passed (12.3s)" listed separately. */
function parsePlaywright(text: string): TestCounts | null {
  const passed = number(
    /(\d+)\s+passed\b(?!\s*\()/.exec(text)?.[1] ?? /(\d+)\s+passed/.exec(text)?.[1],
  );
  const failed = number(/(\d+)\s+failed/.exec(text)?.[1]);
  const skipped = number(/(\d+)\s+skipped/.exec(text)?.[1]);
  const didNotRun = number(/(\d+)\s+did not run/.exec(text)?.[1]);
  if (passed === null && failed === null) return null;
  const discovered =
    passed === null && failed === null
      ? null
      : (passed ?? 0) + (failed ?? 0) + (skipped ?? 0) + (didNotRun ?? 0);
  return { discovered, passed: passed ?? 0, failed: failed ?? 0, skipped };
}

/** Node's built-in runner: "# pass 3" / "# fail 1". */
function parseNodeTest(text: string): TestCounts | null {
  const passed = number(/#\s*pass\s+(\d+)/.exec(text)?.[1]);
  const failed = number(/#\s*fail\s+(\d+)/.exec(text)?.[1]);
  const skipped = number(/#\s*skipped\s+(\d+)/.exec(text)?.[1]);
  if (passed === null && failed === null) return null;
  const total = number(/#\s*tests\s+(\d+)/.exec(text)?.[1]);
  return { discovered: total, passed: passed ?? 0, failed: failed ?? 0, skipped };
}

export function parseTestCounts(output: string): TestCounts {
  const text = tail(output);
  return (
    parseVitest(text) ??
    parseJest(text) ??
    parseNodeTest(text) ??
    parsePlaywright(text) ??
    EMPTY_COUNTS
  );
}

export function isTestOperation(operation: OperationStatus | string): boolean {
  return operation === 'unit' || operation === 'integration' || operation === 'e2e';
}

/** TypeScript: "Found 3 errors in 2 files." Compiler diagnostics: "error TS2322". */
export function parseTypeScriptErrors(output: string): number | null {
  const explicit = /Found (\d+) errors?/.exec(tail(output));
  if (explicit !== null) return number(explicit[1]);
  const matches = tail(output, 20_000).match(/error TS\d+/g);
  return matches === null ? null : matches.length;
}

/** ESLint: "✖ 4 problems (3 errors, 1 warning)". */
export function parseLintProblems(output: string): { errors: number; warnings: number } | null {
  const match = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(tail(output));
  if (match === null) return null;
  return { errors: number(match[2]) ?? 0, warnings: number(match[3]) ?? 0 };
}

/**
 * The one-line reason a reader needs. Taken from the first error-shaped line,
 * bounded, never the whole log.
 */
export function extractErrorSummary(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const signal = /(error|failed|FAIL|✖|✗|Cannot find|not found|ELIFECYCLE)/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || !signal.test(trimmed)) continue;
    return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
  }
  return null;
}

export interface InterpretedOutcome {
  readonly status: OperationStatus;
  readonly counts: TestCounts;
  readonly buildStatus: BuildStatus;
  readonly errorSummary: string | null;
}

/**
 * Turns an exit code and output into a status.
 *
 * Exit code decides pass/fail. Counts only refine the numbers. Build status is
 * reported for build-ish operations and `not_applicable` elsewhere; it is
 * `unknown` when a build printed nothing that says either way.
 */
export function interpretOutcome(input: {
  readonly operation: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}): InterpretedOutcome {
  const combined = `${input.stdout}\n${input.stderr}`;
  const counts = parseTestCounts(combined);
  const failedCounts = counts.failed !== null && counts.failed > 0;

  let status: OperationStatus;
  if (input.timedOut) status = 'timed_out';
  else if (input.exitCode === null) status = 'incomplete';
  else if (input.exitCode === 0 && !failedCounts) status = 'passed';
  else status = 'failed';

  const buildStatus: BuildStatus =
    input.operation === 'build' || input.operation === 'typecheck'
      ? status === 'passed'
        ? 'passed'
        : status === 'failed'
          ? 'failed'
          : 'unknown'
      : 'not_applicable';

  return {
    status,
    counts,
    buildStatus,
    errorSummary: status === 'passed' ? null : extractErrorSummary(combined),
  };
}
