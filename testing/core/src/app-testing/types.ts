/**
 * Application-testing agent (Step 39): the shared vocabulary.
 *
 * Everything here is data. Project files, test output and stack traces are
 * UNTRUSTED: they are read, bounded and classified, and never become
 * instructions. Nothing in this module executes anything; execution is the
 * existing Tool System + Sandbox, reached only through the Step 14 manager.
 */

/** Hard ceilings so no input can make a result unbounded. */
export const APP_TEST_LIMITS = {
  maxFiles: 400,
  maxFileBytes: 200_000,
  maxRoutes: 200,
  maxEndpoints: 200,
  maxTests: 60,
  maxFindings: 100,
  maxBugs: 100,
  maxTextChars: 400,
  maxEvidenceChars: 240,
  maxGeneratedFileBytes: 24_000,
} as const;

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** One project file as the inspector sees it: a path and (maybe) bounded text. */
export interface InspectableFile {
  readonly path: string;
  /** Bounded text of the file, or null when it was not read. UNTRUSTED. */
  readonly text: string | null;
}

export const FRONTEND_FRAMEWORKS = ['react', 'vue', 'svelte', 'angular', 'next', 'none'] as const;
export type FrontendFramework = (typeof FRONTEND_FRAMEWORKS)[number];

export const BACKEND_FRAMEWORKS = [
  'fastify',
  'express',
  'koa',
  'nest',
  'next-api',
  'none',
] as const;
export type BackendFramework = (typeof BACKEND_FRAMEWORKS)[number];

export const TEST_RUNNERS = ['vitest', 'jest', 'mocha', 'node-test', 'none'] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];

export const DATABASE_KINDS = [
  'postgres',
  'mysql',
  'sqlite',
  'mongodb',
  'redis',
  'prisma',
  'none',
] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export interface DiscoveredRoute {
  /** `GET`, `POST`, ... or `PAGE` for a frontend route. */
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
  /** True only when an auth guard is visibly attached. False is NOT "public". */
  readonly guarded: boolean;
}

export interface ExistingTest {
  readonly path: string;
  readonly runner: TestRunner;
}

export interface AppInspection {
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly frontend: FrontendFramework;
  readonly backend: BackendFramework;
  readonly testRunner: TestRunner;
  readonly databases: readonly DatabaseKind[];
  readonly entryPoints: readonly string[];
  readonly apiRoutes: readonly DiscoveredRoute[];
  readonly pageRoutes: readonly DiscoveredRoute[];
  readonly existingTests: readonly ExistingTest[];
  /** Dependency NAMES only, never versions or values. */
  readonly dependencies: readonly string[];
  readonly hasAuth: boolean;
  readonly hasForms: boolean;
  /** Honest notes about what could not be determined. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Test generation
// ---------------------------------------------------------------------------

export const TEST_KINDS = [
  'unit',
  'integration',
  'api',
  'component',
  'user-flow',
  'authentication',
  'form-validation',
  'navigation',
  'error-handling',
  'regression',
] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export interface GeneratedTestCase {
  readonly id: string;
  readonly kind: TestKind;
  readonly title: string;
  /** What in the application this covers (a route, a file, a form). */
  readonly target: string;
  /** Where the generated source would live. Never an existing file. */
  readonly path: string;
  readonly runner: TestRunner;
  /** Runnable source for the detected runner. Written only after approval. */
  readonly source: string;
}

export interface TestGenerationResult {
  readonly runner: TestRunner;
  readonly cases: readonly GeneratedTestCase[];
  /** Kinds the application gave no basis for, with the reason. */
  readonly skipped: readonly { readonly kind: TestKind; readonly reason: string }[];
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Security findings and bugs
// ---------------------------------------------------------------------------

export const BUG_CATEGORIES = [
  'functional',
  'ui',
  'api',
  'database',
  'authentication',
  'performance',
  'security',
  'configuration',
] as const;
export type BugCategory = (typeof BUG_CATEGORIES)[number];

export const BUG_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

/**
 * confirmed: a test or run really failed.
 * suspected: static analysis or reasoning points at it; nothing failed.
 */
export const BUG_CERTAINTIES = ['confirmed', 'suspected'] as const;
export type BugCertainty = (typeof BUG_CERTAINTIES)[number];

export interface SecurityFinding {
  readonly id: string;
  readonly rule: string;
  readonly severity: BugSeverity;
  readonly title: string;
  readonly file: string;
  readonly line: number;
  /** A short, redacted excerpt. Never a secret value. */
  readonly evidence: string;
  readonly recommendation: string;
}

export interface Bug {
  readonly id: string;
  readonly category: BugCategory;
  readonly severity: BugSeverity;
  readonly certainty: BugCertainty;
  readonly title: string;
  readonly summary: string;
  readonly affectedFiles: readonly string[];
  readonly evidence: string;
  readonly recommendation: string;
  /** The test or finding this came from. */
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Execution results and the report
// ---------------------------------------------------------------------------

export const APP_TEST_OUTCOMES = ['passed', 'failed', 'skipped'] as const;
export type AppTestOutcome = (typeof APP_TEST_OUTCOMES)[number];

export interface AppTestResult {
  readonly id: string;
  readonly kind: TestKind;
  readonly title: string;
  readonly outcome: AppTestOutcome;
  /** Why it was skipped, when it was. */
  readonly skipReason: string | null;
  /** Bounded, scrubbed failure output. UNTRUSTED. */
  readonly error: string | null;
  readonly durationMs: number | null;
}

/** What actually ran the commands. Derived from the runtime, never assumed. */
export interface ExecutionEnvironment {
  readonly runtimeId: string;
  /** True only when the runtime genuinely isolates at the OS level. */
  readonly osIsolation: boolean;
  /** True only when the commands really executed code. */
  readonly executedRealCode: boolean;
  readonly networkPolicy: 'disabled' | 'allowlist' | 'unknown';
}

export const APP_TEST_STATUSES = [
  'PASSED',
  'FAILED',
  'PARTIALLY_PASSED',
  'CANCELLED',
  'BLOCKED',
] as const;
export type AppTestStatus = (typeof APP_TEST_STATUSES)[number];

export interface RegressionResult {
  readonly ran: boolean;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Tests that passed before a repair and fail after it. */
  readonly regressed: readonly string[];
  /** Tests that failed before a repair and pass after it. */
  readonly fixed: readonly string[];
  readonly note: string;
}

export interface AppTestReport {
  readonly projectId: string;
  readonly runId: string;
  readonly environment: ExecutionEnvironment;
  readonly status: AppTestStatus;
  /** Plain-words reason for the status, always present. */
  readonly statusReason: string;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly tests: readonly AppTestResult[];
  readonly bugs: readonly Bug[];
  readonly findings: readonly SecurityFinding[];
  readonly regression: RegressionResult;
  /** True only when nothing important was skipped, blocked or simulated. */
  readonly fullyTested: boolean;
  readonly generatedAt: string;
}
