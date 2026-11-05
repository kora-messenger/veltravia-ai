/**
 * Application-testing report: status rules, bug classification and regression
 * comparison.
 *
 * Pure functions over already-bounded data. The rules here exist so a report
 * can never say more than the run proved:
 *
 *  - PASSED needs real code to have run, nothing skipped, and (after a repair)
 *    a regression check that ran. Anything less is PARTIALLY_PASSED.
 *  - A run on a runtime that executes no host code can never be PASSED.
 *  - A failed test always wins over everything except a cancellation.
 */

import {
  APP_TEST_LIMITS,
  type AppTestReport,
  type AppTestResult,
  type AppTestStatus,
  type Bug,
  type BugCategory,
  type BugSeverity,
  type ExecutionEnvironment,
  type RegressionResult,
  type SecurityFinding,
  type TestKind,
} from './types.js';

const SEVERITY_ORDER: readonly BugSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function bound(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusInput {
  readonly cancelled: boolean;
  /** Set when the run could not start or could not run anything at all. */
  readonly blockedReason: string | null;
  readonly tests: readonly AppTestResult[];
  readonly environment: ExecutionEnvironment;
  /** True when a repair was applied and the earlier results should be re-checked. */
  readonly repairApplied: boolean;
  readonly regression: RegressionResult;
}

export interface StatusDecision {
  readonly status: AppTestStatus;
  readonly reason: string;
  readonly fullyTested: boolean;
}

/** Decides the overall status and says why, in plain words. */
export function decideStatus(input: StatusInput): StatusDecision {
  if (input.cancelled) {
    return {
      status: 'CANCELLED',
      reason: 'The run was cancelled before it finished.',
      fullyTested: false,
    };
  }
  if (input.blockedReason !== null) {
    return { status: 'BLOCKED', reason: bound(input.blockedReason, 300), fullyTested: false };
  }

  const executed = input.tests.filter((test) => test.outcome !== 'skipped');
  const failed = input.tests.filter((test) => test.outcome === 'failed');
  const skipped = input.tests.filter((test) => test.outcome === 'skipped');

  if (input.tests.length === 0) {
    return {
      status: 'BLOCKED',
      reason: 'There were no tests to run, so nothing could be checked.',
      fullyTested: false,
    };
  }
  if (executed.length === 0) {
    return {
      status: 'BLOCKED',
      reason: 'Every test was skipped, so nothing was checked.',
      fullyTested: false,
    };
  }
  if (failed.length > 0) {
    const regressed = input.regression.regressed.length;
    return {
      status: 'FAILED',
      reason:
        regressed > 0
          ? `${failed.length} test${failed.length === 1 ? '' : 's'} failed, ${regressed} of them passed before the repair.`
          : `${failed.length} test${failed.length === 1 ? '' : 's'} failed.`,
      fullyTested: false,
    };
  }

  // Nothing failed. Work out whether that is a full pass or only a partial one.
  const caveats: string[] = [];
  if (skipped.length > 0) {
    caveats.push(`${skipped.length} test${skipped.length === 1 ? ' was' : 's were'} skipped`);
  }
  if (!input.environment.executedRealCode) {
    caveats.push(
      `the commands ran on the "${input.environment.runtimeId}" runtime, which executes no real code`,
    );
  }
  if (input.repairApplied && !input.regression.ran) {
    caveats.push('no regression check ran after the repair');
  }
  if (caveats.length > 0) {
    return {
      status: 'PARTIALLY_PASSED',
      reason: `No test failed, but ${caveats.join(' and ')}.`,
      fullyTested: false,
    };
  }
  return {
    status: 'PASSED',
    reason: `All ${executed.length} test${executed.length === 1 ? '' : 's'} passed.`,
    fullyTested: true,
  };
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

/**
 * Compares results from before and after a repair, matched by test id.
 * `ran` is false when there was no earlier result to compare against, and the
 * note says so, so an empty comparison is never read as "nothing regressed".
 */
export function compareRegression(
  before: readonly AppTestResult[],
  after: readonly AppTestResult[],
): RegressionResult {
  if (before.length === 0) {
    return {
      ran: false,
      total: 0,
      passed: 0,
      failed: 0,
      regressed: [],
      fixed: [],
      note: 'There were no earlier results to compare against.',
    };
  }
  const earlier = new Map(before.map((test) => [test.id, test.outcome]));
  const regressed: string[] = [];
  const fixed: string[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  for (const test of after) {
    const was = earlier.get(test.id);
    if (was === undefined || test.outcome === 'skipped') continue;
    total += 1;
    if (test.outcome === 'passed') passed += 1;
    else failed += 1;
    if (was === 'passed' && test.outcome === 'failed') regressed.push(test.id);
    if (was === 'failed' && test.outcome === 'passed') fixed.push(test.id);
  }
  regressed.sort();
  fixed.sort();
  if (total === 0) {
    return {
      ran: false,
      total: 0,
      passed: 0,
      failed: 0,
      regressed: [],
      fixed: [],
      note: 'No test appeared in both runs, so nothing could be compared.',
    };
  }
  return {
    ran: true,
    total,
    passed,
    failed,
    regressed,
    fixed,
    note:
      regressed.length === 0
        ? `${total} earlier test${total === 1 ? '' : 's'} re-checked; none regressed.`
        : `${regressed.length} test${regressed.length === 1 ? '' : 's'} passed before and fail now.`,
  };
}

// ---------------------------------------------------------------------------
// Bug classification
// ---------------------------------------------------------------------------

const KIND_CATEGORY: Readonly<Record<TestKind, BugCategory>> = {
  unit: 'functional',
  integration: 'functional',
  api: 'api',
  component: 'ui',
  'user-flow': 'functional',
  authentication: 'authentication',
  'form-validation': 'ui',
  navigation: 'ui',
  'error-handling': 'api',
  regression: 'functional',
};

/** Output patterns that point somewhere more specific than the test kind. */
const OUTPUT_HINTS: readonly { readonly pattern: RegExp; readonly category: BugCategory }[] = [
  {
    pattern:
      /\b(ECONNREFUSED|SQLITE_|ER_[A-Z_]+|relation ".*" does not exist|PrismaClient|duplicate key)\b/i,
    category: 'database',
  },
  {
    pattern: /\b(401|403|unauthori[sz]ed|forbidden|invalid token|jwt)\b/i,
    category: 'authentication',
  },
  {
    pattern: /\b(timed? ?out|exceeded .*(ms|timeout)|ETIMEDOUT|too slow)\b/i,
    category: 'performance',
  },
  {
    pattern:
      /\b(ENOENT|missing (env|environment)|is not defined in (env|config)|Cannot find module)\b/i,
    category: 'configuration',
  },
];

function severityFor(category: BugCategory, kind: TestKind): BugSeverity {
  if (category === 'security') return 'high';
  if (category === 'authentication' || category === 'database') return 'high';
  if (kind === 'regression') return 'high';
  if (category === 'api' || category === 'functional') return 'medium';
  return 'medium';
}

/**
 * Turns a failed test into a CONFIRMED bug. The category comes from the test
 * kind, refined by what the (untrusted) error text literally mentions. The
 * error text is only matched against patterns; it is never interpreted.
 */
export function bugFromFailedTest(
  test: AppTestResult,
  affectedFiles: readonly string[],
  index: number,
): Bug {
  let category = KIND_CATEGORY[test.kind];
  const error = test.error ?? '';
  for (const hint of OUTPUT_HINTS) {
    if (hint.pattern.test(error)) {
      category = hint.category;
      break;
    }
  }
  return {
    id: `bug-${index + 1}`,
    category,
    severity: severityFor(category, test.kind),
    certainty: 'confirmed',
    title: bound(`Test failed: ${test.title}`, 120),
    summary: bound(error.length > 0 ? error : 'The test failed without an error message.', 300),
    affectedFiles: affectedFiles.slice(0, 10),
    evidence: bound(error, APP_TEST_LIMITS.maxEvidenceChars),
    recommendation: recommendationFor(category),
    source: test.id,
  };
}

/** Turns a static security finding into a SUSPECTED bug. Nothing failed. */
export function bugFromFinding(finding: SecurityFinding, index: number): Bug {
  const category: BugCategory =
    finding.rule === 'unguarded-mutating-route' ? 'authentication' : 'security';
  return {
    id: `bug-s${index + 1}`,
    category,
    severity: finding.severity,
    certainty: 'suspected',
    title: bound(finding.title, 120),
    summary: bound(
      `Static analysis flagged this in ${finding.file}:${finding.line}. No test failed; it has not been confirmed.`,
      300,
    ),
    affectedFiles: [finding.file],
    evidence: bound(finding.evidence, APP_TEST_LIMITS.maxEvidenceChars),
    recommendation: bound(finding.recommendation, 300),
    source: finding.id,
  };
}

function recommendationFor(category: BugCategory): string {
  switch (category) {
    case 'database':
      return 'Check the database connection settings and that migrations have been applied.';
    case 'authentication':
      return 'Check how the request is authenticated and that the guard is attached to this route.';
    case 'performance':
      return 'Look for a slow or unbounded operation, or raise the timeout only if the work is legitimate.';
    case 'configuration':
      return 'Check that the required files, environment variable names and dependencies exist.';
    case 'ui':
      return 'Check the component or form against the behaviour the test expects.';
    case 'api':
      return 'Check the route handler and the status code it returns for this request.';
    case 'security':
      return 'Review the flagged code and remove or restrict it.';
    default:
      return 'Read the failing assertion and compare the result with what the code should return.';
  }
}

/** Orders bugs most severe first, confirmed before suspected, then by id. */
export function sortBugs(bugs: readonly Bug[]): readonly Bug[] {
  return [...bugs]
    .sort((a, b) => {
      const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      if (bySeverity !== 0) return bySeverity;
      if (a.certainty !== b.certainty) return a.certainty === 'confirmed' ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, APP_TEST_LIMITS.maxBugs);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReportInput extends StatusInput {
  readonly projectId: string;
  readonly runId: string;
  readonly bugs: readonly Bug[];
  readonly findings: readonly SecurityFinding[];
  readonly generatedAt: string;
}

/** Builds the report. Counts are derived from the tests, never passed in. */
export function buildReport(input: ReportInput): AppTestReport {
  const decision = decideStatus(input);
  const passed = input.tests.filter((test) => test.outcome === 'passed').length;
  const failed = input.tests.filter((test) => test.outcome === 'failed').length;
  const skipped = input.tests.filter((test) => test.outcome === 'skipped').length;
  return {
    projectId: input.projectId,
    runId: input.runId,
    environment: input.environment,
    status: decision.status,
    statusReason: decision.reason,
    executed: passed + failed,
    passed,
    failed,
    skipped,
    tests: input.tests.slice(0, APP_TEST_LIMITS.maxTests * 2),
    bugs: sortBugs(input.bugs),
    findings: input.findings.slice(0, APP_TEST_LIMITS.maxFindings),
    regression: input.regression,
    fullyTested: decision.fullyTested,
    generatedAt: input.generatedAt,
  };
}
