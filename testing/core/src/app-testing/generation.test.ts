import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { generateTests } from './generation.js';
import {
  APP_TEST_LIMITS,
  TEST_KINDS,
  type AppInspection,
  type DiscoveredRoute,
  type ExistingTest,
  type GeneratedTestCase,
  type TestRunner,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function route(method: string, path: string, guarded = false, line = 1): DiscoveredRoute {
  return { method, path, guarded, file: 'src/server.ts', line };
}

function page(path: string): DiscoveredRoute {
  return { method: 'PAGE', path, file: 'src/routes/page.tsx', line: 3, guarded: false };
}

function existing(path: string, runner: TestRunner = 'vitest'): ExistingTest {
  return { path, runner };
}

function makeInspection(overrides: Partial<AppInspection> = {}): AppInspection {
  return {
    fileCount: 12,
    truncated: false,
    frontend: 'react',
    backend: 'fastify',
    testRunner: 'vitest',
    databases: ['postgres'],
    entryPoints: ['src/main.tsx', 'src/server.ts'],
    apiRoutes: [route('GET', '/api/users'), route('POST', '/api/users', true)],
    pageRoutes: [page('/'), page('/dashboard')],
    existingTests: [],
    dependencies: ['fastify', 'react'],
    hasAuth: true,
    hasForms: true,
    notes: [],
    ...overrides,
  };
}

const RUNNERS: readonly TestRunner[] = ['vitest', 'jest', 'mocha', 'node-test', 'none'];

function allCases(inspection: AppInspection): readonly GeneratedTestCase[] {
  return generateTests(inspection).cases;
}

/** The JSON literal of the route argument that every HTTP case embeds. */
function routeLiteral(source: string): string | null {
  const match = /joinUrl\(\s*[A-Za-z0-9_]+,\s*("(?:[^"\\]|\\.)*")\)/.exec(source);
  return match?.[1] ?? null;
}

interface ScannedToken {
  readonly kind: ts.SyntaxKind;
  readonly text: string;
}

/** Lex the source with the TypeScript scanner: tokens are code, everything else must be trivia. */
function scanTokens(source: string): readonly ScannedToken[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: ScannedToken[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push({ kind, text: scanner.getTokenText() });
  }
  return tokens;
}

function stringLiteralTokensContaining(source: string, needle: string): readonly string[] {
  const found: string[] = [];
  for (const token of scanTokens(source)) {
    if (!token.text.includes(needle)) continue;
    if (
      token.kind !== ts.SyntaxKind.StringLiteral &&
      token.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      found.push(token.text);
    }
  }
  return found;
}

function syntacticErrors(source: string): readonly ts.Diagnostic[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: 'generated.test.ts',
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  return (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
}

// ---------------------------------------------------------------------------
// Runner selection and syntax
// ---------------------------------------------------------------------------

describe('runner selection', () => {
  it('renders vitest sources with an explicit vitest import', () => {
    const result = generateTests(makeInspection({ testRunner: 'vitest' }));
    expect(result.runner).toBe('vitest');
    expect(result.cases.length).toBeGreaterThan(0);
    for (const testCase of result.cases) {
      expect(testCase.runner).toBe('vitest');
      expect(testCase.source).toContain("import { describe, it, expect } from 'vitest';");
      expect(testCase.source).toContain('expect(');
      expect(testCase.source).not.toContain("from 'node:test'");
    }
  });

  it('renders jest sources against globals without importing a framework', () => {
    const result = generateTests(makeInspection({ testRunner: 'jest' }));
    expect(result.runner).toBe('jest');
    for (const testCase of result.cases) {
      expect(testCase.source).not.toContain("from 'vitest'");
      expect(testCase.source).not.toContain("from 'node:test'");
      expect(testCase.source).toContain('describe(');
      expect(testCase.source).toContain('expect(');
      expect(testCase.source).toContain('globals');
    }
  });

  it('renders mocha sources with node:assert/strict', () => {
    const result = generateTests(makeInspection({ testRunner: 'mocha' }));
    expect(result.runner).toBe('mocha');
    for (const testCase of result.cases) {
      expect(testCase.source).toContain("import assert from 'node:assert/strict';");
      expect(testCase.source).toContain('describe(');
      expect(testCase.source).toContain('assert.');
      expect(testCase.source).not.toContain('expect(');
      expect(testCase.source).not.toContain("from 'node:test'");
    }
  });

  it('renders node-test sources with node:test and node:assert/strict', () => {
    const result = generateTests(makeInspection({ testRunner: 'node-test' }));
    expect(result.runner).toBe('node-test');
    for (const testCase of result.cases) {
      expect(testCase.source).toContain("import { test } from 'node:test';");
      expect(testCase.source).toContain("import assert from 'node:assert/strict';");
      expect(testCase.source).toContain('test(');
      expect(testCase.source).not.toContain('describe(');
      expect(testCase.source).not.toContain('expect(');
    }
  });

  it("falls back to node-test with an honest note when the runner is 'none'", () => {
    const result = generateTests(makeInspection({ testRunner: 'none' }));
    expect(result.runner).toBe('node-test');
    expect(result.cases.every((testCase) => testCase.runner === 'node-test')).toBe(true);
    expect(result.notes.some((note) => note.includes('no test runner'))).toBe(true);
    expect(result.notes.some((note) => note.includes('node:test'))).toBe(true);
    expect(result.notes.some((note) => note.includes('no dependency'))).toBe(true);
    expect(result.cases[0]?.source).toContain("import { test } from 'node:test';");
  });

  it('adds no runner-fallback note for a detected runner', () => {
    const result = generateTests(makeInspection({ testRunner: 'vitest' }));
    expect(result.notes.some((note) => note.includes('no test runner'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// api kind
// ---------------------------------------------------------------------------

describe('api tests', () => {
  it('generates one HTTP smoke test per detected route', () => {
    const inspection = makeInspection({
      apiRoutes: [
        route('GET', '/api/users'),
        route('POST', '/api/orders'),
        route('DELETE', '/api/orders/1'),
      ],
    });
    const cases = allCases(inspection).filter((testCase) => testCase.kind === 'api');
    expect(cases).toHaveLength(3);
    expect(cases.map((testCase) => testCase.target)).toEqual([
      'GET /api/users',
      'POST /api/orders',
      'DELETE /api/orders/1',
    ]);
  });

  it('asserts only that the status is not a server error', () => {
    const cases = allCases(makeInspection({ apiRoutes: [route('GET', '/api/health')] }));
    const api = cases.find((testCase) => testCase.kind === 'api');
    expect(api?.source).toContain('toBeLessThan(500)');
    expect(api?.source).toContain('await fetch(');
    expect(api?.source).toContain('method: "GET",');
  });

  it('skips the body honestly when APP_TEST_BASE_URL is not set, per runner', () => {
    for (const runner of RUNNERS) {
      const cases = allCases(
        makeInspection({ testRunner: runner, apiRoutes: [route('GET', '/api/health')] }),
      );
      const api = cases.find((testCase) => testCase.kind === 'api');
      expect(api).toBeDefined();
      const source = api?.source ?? '';
      expect(source).toContain('process.env.APP_TEST_BASE_URL');
      // 'none' is resolved to node-test before anything is rendered.
      const effective = runner === 'none' ? 'node-test' : runner;
      if (effective === 'vitest') {
        expect(source).toContain('ctx.skip(');
      } else if (effective === 'node-test') {
        expect(source).toContain('{ skip: skipWithoutBaseUrl }');
      } else {
        // jest and mocha both swap in a skipping `it` and warn once per file.
        expect(source).toContain('console.warn(');
        expect(source).toContain("const whenBaseUrlIsSet = BASE_URL === '' ? it.skip : it;");
      }
      expect(source).toContain('skipped rather than passed');
    }
  });

  it('notes that auth is unconfirmed for unguarded mutating routes', () => {
    const cases = allCases(makeInspection({ apiRoutes: [route('POST', '/api/orders', false)] }));
    const api = cases.find((testCase) => testCase.kind === 'api');
    expect(api?.source).toContain('Auth could not be confirmed');
    expect(api?.source).toContain('401 or 403 is an acceptable answer');
  });

  it('does not add the auth note to safe or guarded routes', () => {
    const cases = allCases(
      makeInspection({
        apiRoutes: [route('GET', '/api/items', false), route('POST', '/api/items', true)],
      }),
    );
    for (const api of cases.filter((testCase) => testCase.kind === 'api')) {
      expect(api.source).not.toContain('Auth could not be confirmed');
    }
  });

  it('summarises routes whose auth could not be confirmed in the notes', () => {
    const result = generateTests(makeInspection({ apiRoutes: [route('PUT', '/api/a', false)] }));
    expect(result.notes.some((note) => note.includes('Auth could not be confirmed for 1'))).toBe(
      true,
    );
  });

  it('caps API tests at 20 routes and says so', () => {
    const apiRoutes = Array.from({ length: 30 }, (_unused, index) =>
      route('GET', `/api/items/${index}`),
    );
    const result = generateTests(makeInspection({ apiRoutes, pageRoutes: [], hasAuth: false }));
    const api = result.cases.filter((testCase) => testCase.kind === 'api');
    expect(api).toHaveLength(20);
    expect(result.notes.some((note) => note.includes('first 20 of 30 API routes'))).toBe(true);
  });

  it('normalises the HTTP method of a route and skips non-HTTP methods', () => {
    const result = generateTests(
      makeInspection({ apiRoutes: [route('post', '/api/ping', true), route('PAGE', '/about')] }),
    );
    const api = result.cases.filter((testCase) => testCase.kind === 'api');
    expect(api).toHaveLength(1);
    expect(api[0]?.target).toBe('POST /api/ping');
    expect(api[0]?.source).toContain('method: "POST",');
    expect(result.notes.some((note) => note.includes('whose method was not an HTTP method'))).toBe(
      true,
    );
  });

  it('skips the api kind with a concrete reason when no route exists', () => {
    const result = generateTests(makeInspection({ apiRoutes: [] }));
    expect(result.cases.some((testCase) => testCase.kind === 'api')).toBe(false);
    const skipped = result.skipped.find((entry) => entry.kind === 'api');
    expect(skipped?.reason).toContain('No API routes were detected');
  });
});

// ---------------------------------------------------------------------------
// authentication kind
// ---------------------------------------------------------------------------

describe('authentication tests', () => {
  it('is skipped with a concrete reason when the app has no auth', () => {
    const result = generateTests(makeInspection({ hasAuth: false }));
    expect(result.cases.some((testCase) => testCase.kind === 'authentication')).toBe(false);
    const skipped = result.skipped.find((entry) => entry.kind === 'authentication');
    expect(skipped?.reason).toContain('no authentication handling');
  });

  it('is skipped when auth exists but no route carries a guard', () => {
    const result = generateTests(
      makeInspection({ hasAuth: true, apiRoutes: [route('GET', '/api/open', false)] }),
    );
    expect(result.cases.some((testCase) => testCase.kind === 'authentication')).toBe(false);
    const skipped = result.skipped.find((entry) => entry.kind === 'authentication');
    expect(skipped?.reason).toContain('no route carried a visible auth guard');
  });

  it('generates only for guarded routes and asserts 401 or 403', () => {
    const result = generateTests(
      makeInspection({
        hasAuth: true,
        apiRoutes: [
          route('GET', '/api/private', true),
          route('GET', '/api/public', false),
          route('DELETE', '/api/private/1', true),
        ],
      }),
    );
    const auth = result.cases.filter((testCase) => testCase.kind === 'authentication');
    expect(auth.map((testCase) => testCase.target)).toEqual([
      'GET /api/private',
      'DELETE /api/private/1',
    ]);
    for (const testCase of auth) {
      expect(testCase.source).toContain('[401, 403]');
      expect(testCase.source).toContain('visible auth guard');
    }
  });

  it('emits node:assert assertions for auth under node-test', () => {
    const cases = allCases(
      makeInspection({
        testRunner: 'node-test',
        apiRoutes: [route('GET', '/api/private', true)],
      }),
    );
    const auth = cases.find((testCase) => testCase.kind === 'authentication');
    expect(auth?.source).toContain('assert.ok(response.status === 401 || response.status === 403');
  });
});

// ---------------------------------------------------------------------------
// navigation kind
// ---------------------------------------------------------------------------

describe('navigation tests', () => {
  it('generates one structural check per page route, capped at 20', () => {
    const pageRoutes = Array.from({ length: 25 }, (_unused, index) => page(`/page-${index}`));
    const result = generateTests(makeInspection({ pageRoutes }));
    const navigation = result.cases.filter((testCase) => testCase.kind === 'navigation');
    expect(navigation).toHaveLength(20);
    expect(result.notes.some((note) => note.includes('first 20 of 25 page routes'))).toBe(true);
  });

  it('asserts well-formedness without a browser', () => {
    const cases = allCases(makeInspection({ pageRoutes: [page('/dashboard')] }));
    const navigation = cases.find((testCase) => testCase.kind === 'navigation');
    const source = navigation?.source ?? '';
    expect(source).toContain("expect(pagePath.charAt(0)).toBe('/')");
    expect(source).toContain("expect(pagePath.indexOf('//')).toBe(-1)");
    expect(source).toContain('PAGE_PATHS.filter');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('APP_TEST_BASE_URL');
  });

  it('would fail on a duplicate page path because the emitted list keeps duplicates', () => {
    const cases = allCases(makeInspection({ pageRoutes: [page('/dup'), page('/dup')] }));
    const navigation = cases.filter((testCase) => testCase.kind === 'navigation');
    expect(navigation).toHaveLength(2);
    const declared = /const PAGE_PATHS: string\[\] = (\[.*?\]);/.exec(navigation[0]?.source ?? '');
    expect(declared).not.toBeNull();
    const paths = JSON.parse(declared?.[1] ?? '[]') as string[];
    expect(paths.filter((candidate) => candidate === '/dup')).toHaveLength(2);
  });

  it('is skipped with a reason when the app has no page routes', () => {
    const result = generateTests(makeInspection({ pageRoutes: [] }));
    expect(result.cases.some((testCase) => testCase.kind === 'navigation')).toBe(false);
    const skipped = result.skipped.find((entry) => entry.kind === 'navigation');
    expect(skipped?.reason).toContain('No page routes were detected');
  });
});

// ---------------------------------------------------------------------------
// error-handling kind
// ---------------------------------------------------------------------------

describe('error-handling tests', () => {
  it('probes a path that cannot exist and requires 404', () => {
    const cases = allCases(makeInspection({}));
    const probe = cases.find((testCase) => testCase.kind === 'error-handling');
    expect(probe).toBeDefined();
    expect(probe?.target).toBe('/__veltravia_nonexistent__');
    expect(probe?.source).toContain('method: "GET",');
    expect(probe?.source).toContain('toBe(404)');
    expect(probe?.source).toContain('toBeLessThan(500)');
  });

  it('emits the 404 probe with node:assert under node-test', () => {
    const cases = allCases(makeInspection({ testRunner: 'node-test' }));
    const probe = cases.find((testCase) => testCase.kind === 'error-handling');
    expect(probe?.source).toContain('assert.equal(response.status, 404');
  });

  it('is skipped when there is no API to probe', () => {
    const result = generateTests(makeInspection({ apiRoutes: [] }));
    expect(result.cases.some((testCase) => testCase.kind === 'error-handling')).toBe(false);
    const skipped = result.skipped.find((entry) => entry.kind === 'error-handling');
    expect(skipped?.reason).toContain('No API routes were detected');
  });
});

// ---------------------------------------------------------------------------
// Kinds that must honestly skip
// ---------------------------------------------------------------------------

describe('skipped kinds', () => {
  it('always skips regression with the exact reason', () => {
    for (const runner of RUNNERS) {
      const result = generateTests(makeInspection({ testRunner: runner }));
      expect(result.cases.some((testCase) => testCase.kind === 'regression')).toBe(false);
      const skipped = result.skipped.find((entry) => entry.kind === 'regression');
      expect(skipped?.reason).toBe(
        'Regression is verified by re-running earlier results after a repair',
      );
    }
  });

  it('skips browser-bound kinds rather than faking coverage', () => {
    const result = generateTests(makeInspection({ hasForms: true }));
    for (const kind of ['component', 'user-flow', 'form-validation'] as const) {
      expect(result.cases.some((testCase) => testCase.kind === kind)).toBe(false);
      const skipped = result.skipped.find((entry) => entry.kind === kind);
      expect(skipped?.reason).toBe(
        'Needs a browser or component runtime that is not available in this build',
      );
    }
  });

  it('skips unit and integration with precise reasons', () => {
    const result = generateTests(makeInspection({}));
    expect(result.skipped.find((entry) => entry.kind === 'unit')?.reason).toContain(
      'no unit seam could be exercised',
    );
    expect(result.skipped.find((entry) => entry.kind === 'integration')?.reason).toContain(
      'No cross-module seam',
    );
  });

  it('reports every kind exactly once as either generated or skipped', () => {
    const result = generateTests(makeInspection({}));
    const skippedKinds = result.skipped.map((entry) => entry.kind);
    expect(new Set(skippedKinds).size).toBe(skippedKinds.length);
    const produced = new Set(result.cases.map((testCase) => testCase.kind));
    for (const kind of TEST_KINDS) {
      expect(produced.has(kind) || skippedKinds.includes(kind)).toBe(true);
      expect(produced.has(kind) && skippedKinds.includes(kind)).toBe(false);
    }
  });

  it('keeps every skip reason concrete and non-empty', () => {
    const result = generateTests(
      makeInspection({ testRunner: 'none', apiRoutes: [], pageRoutes: [] }),
    );
    expect(result.skipped.length).toBeGreaterThan(0);
    for (const entry of result.skipped) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// Paths, ids, caps
// ---------------------------------------------------------------------------

describe('paths and ids', () => {
  it('keeps every path unique and under generated-tests/', () => {
    const apiRoutes = Array.from({ length: 15 }, (_unused, index) =>
      route('GET', `/api/items/${index % 3}`, index % 2 === 0),
    );
    const result = generateTests(
      makeInspection({ apiRoutes, pageRoutes: [page('/a'), page('/a/b')] }),
    );
    const paths = result.cases.map((testCase) => testCase.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith('generated-tests/')).toBe(true);
      expect(path.endsWith('.test.ts')).toBe(true);
    }
  });

  it('uses lowercase [a-z0-9-] slugs derived from the target', () => {
    const cases = allCases(makeInspection({ apiRoutes: [route('GET', '/API/Users/:ID')] }));
    const api = cases.find((testCase) => testCase.kind === 'api');
    expect(api?.path).toBe('generated-tests/api/get-api-users-id.test.ts');
    for (const testCase of cases) {
      const slug = testCase.path
        .split('/')
        .slice(2)
        .join('/')
        .replace(/\.test\.ts$/, '');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('adds a numeric suffix when a generated path collides with an existing test', () => {
    const result = generateTests(
      makeInspection({
        apiRoutes: [route('GET', '/api/users')],
        existingTests: [existing('./generated-tests/api/get-api-users.test.ts')],
      }),
    );
    const api = result.cases.find((testCase) => testCase.kind === 'api');
    expect(api?.path).toBe('generated-tests/api/get-api-users-2.test.ts');
  });

  it('allocates distinct suffixed paths for repeated slugs within one run', () => {
    const result = generateTests(
      makeInspection({ apiRoutes: [route('GET', '/api/x'), route('GET', '/api/x')] }),
    );
    const paths = result.cases
      .filter((testCase) => testCase.kind === 'api')
      .map((testCase) => testCase.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths[1]).toBe('generated-tests/api/get-api-x-2.test.ts');
  });

  it('produces deterministic tc-<kind>-<n> ids', () => {
    const result = generateTests(makeInspection({}));
    const ids = result.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of result.cases) {
      expect(testCase.id).toMatch(
        /^tc-(unit|integration|api|component|user-flow|authentication|form-validation|navigation|error-handling|regression)-\d+$/,
      );
      expect(testCase.id.startsWith(`tc-${testCase.kind}-`)).toBe(true);
    }
    expect(ids).toContain('tc-api-1');
  });

  it('gives every case a title that names its target', () => {
    const result = generateTests(makeInspection({}));
    for (const testCase of result.cases) {
      expect(testCase.title.length).toBeGreaterThan(10);
      expect(testCase.title.includes(testCase.target)).toBe(true);
    }
  });
});

describe('caps', () => {
  it('caps the total number of cases at APP_TEST_LIMITS.maxTests with a note', () => {
    const apiRoutes = Array.from({ length: 20 }, (_unused, index) =>
      route('GET', `/api/r${index}`, true),
    );
    const pageRoutes = Array.from({ length: 20 }, (_unused, index) => page(`/p${index}`));
    const result = generateTests(makeInspection({ apiRoutes, pageRoutes, hasAuth: true }));
    expect(result.cases.length).toBe(APP_TEST_LIMITS.maxTests);
    expect(result.notes.some((note) => note.includes('APP_TEST_LIMITS.maxTests'))).toBe(true);
    // Highest-value kinds survive the cut: the 404 probe outranks navigation.
    expect(result.cases.some((testCase) => testCase.kind === 'error-handling')).toBe(true);
    expect(result.cases.filter((testCase) => testCase.kind === 'navigation')).toHaveLength(19);
  });

  it('keeps every generated source under maxGeneratedFileBytes', () => {
    for (const runner of RUNNERS) {
      const result = generateTests(makeInspection({ testRunner: runner }));
      for (const testCase of result.cases) {
        expect(Buffer.byteLength(testCase.source, 'utf8')).toBeLessThanOrEqual(
          APP_TEST_LIMITS.maxGeneratedFileBytes,
        );
      }
    }
  });

  it('drops an oversized source instead of truncating it and records a note', () => {
    const hugePath = `/api/${'a'.repeat(APP_TEST_LIMITS.maxGeneratedFileBytes + 5_000)}`;
    const result = generateTests(
      makeInspection({ apiRoutes: [route('GET', hugePath), route('GET', '/api/small')] }),
    );
    const api = result.cases.filter((testCase) => testCase.kind === 'api');
    expect(api).toHaveLength(1);
    expect(api[0]?.target).toBe('GET /api/small');
    expect(result.notes.some((note) => note.includes('byte limit for one generated file'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism, honesty, safety
// ---------------------------------------------------------------------------

describe('determinism and honesty', () => {
  it('returns deep-equal output for the same input twice', () => {
    const first = generateTests(makeInspection({ testRunner: 'jest' }));
    const second = generateTests(makeInspection({ testRunner: 'jest' }));
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('does not mutate the inspection it was given', () => {
    const inspection = makeInspection({});
    const snapshot = JSON.stringify(inspection);
    generateTests(inspection);
    expect(JSON.stringify(inspection)).toBe(snapshot);
  });

  it('emits nothing for an empty project and says so', () => {
    const result = generateTests(
      makeInspection({
        testRunner: 'none',
        apiRoutes: [],
        pageRoutes: [],
        entryPoints: [],
        existingTests: [],
        hasAuth: false,
        hasForms: false,
        fileCount: 0,
      }),
    );
    expect(result.cases).toHaveLength(0);
    expect(result.skipped.map((entry) => entry.kind).sort()).toEqual([...TEST_KINDS].sort());
    expect(result.notes.some((note) => note.includes('nothing runnable was emitted'))).toBe(true);
  });

  it('passes on the truncation caveat when the inspection was truncated', () => {
    const result = generateTests(makeInspection({ truncated: true }));
    expect(result.notes.some((note) => note.includes('inspection was truncated'))).toBe(true);
  });

  it('never emits a tautology, in any runner', () => {
    for (const runner of RUNNERS) {
      const result = generateTests(makeInspection({ testRunner: runner }));
      expect(result.cases.length).toBeGreaterThan(0);
      for (const testCase of result.cases) {
        expect(testCase.source).not.toMatch(/expect\(true\)\.toBe\(true\)/);
        expect(testCase.source).not.toMatch(/assert\.ok\(true\)/);
        expect(testCase.source).not.toMatch(/assert\(\s*true\s*\)/);
        expect(testCase.source).not.toMatch(/expect\(\s*1\s*\)\.toBe\(\s*1\s*\)/);
      }
    }
  });

  it('reads no host environment beyond APP_TEST_BASE_URL and spawns nothing', () => {
    for (const runner of RUNNERS) {
      const result = generateTests(makeInspection({ testRunner: runner }));
      for (const testCase of result.cases) {
        const envReads = testCase.source.match(/process\.env\.[A-Za-z0-9_]+/g) ?? [];
        for (const envRead of envReads) {
          expect(envRead).toBe('process.env.APP_TEST_BASE_URL');
        }
        expect(testCase.source).not.toMatch(/child_process/);
        expect(testCase.source).not.toMatch(/require\(/);
        expect(testCase.source).not.toMatch(/\bfs\./);
        expect(testCase.source).not.toMatch(/node:fs/);
        expect(testCase.source).not.toMatch(/exec\(/);
        expect(testCase.source).not.toMatch(/process\.exit/);
        expect(testCase.source).not.toMatch(/eval\(/);
        expect(testCase.source).not.toMatch(/new Function/);
      }
    }
  });

  it('contains no obvious credential material', () => {
    const result = generateTests(makeInspection({}));
    for (const testCase of result.cases) {
      expect(testCase.source).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
      expect(testCase.source).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(testCase.source).not.toMatch(/password\s*[:=]\s*['"][^'"]+['"]/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Injection safety and syntactic validity
// ---------------------------------------------------------------------------

const HOSTILE_PATH = "/x'); process.exit(1); ('";

describe('injection safety', () => {
  it('embeds a hostile route path only as a JSON string literal, for every runner', () => {
    const literal = JSON.stringify(HOSTILE_PATH);
    for (const runner of RUNNERS) {
      const cases = allCases(
        makeInspection({ testRunner: runner, apiRoutes: [route('GET', HOSTILE_PATH)] }),
      );
      const api = cases.find((testCase) => testCase.kind === 'api');
      expect(api).toBeDefined();
      const source = api?.source ?? '';

      // The route is embedded exactly once, as a JSON literal that round-trips.
      expect(routeLiteral(source)).toBe(literal);
      expect(JSON.parse(routeLiteral(source) ?? '""')).toBe(HOSTILE_PATH);

      // Lexically: no token that mentions the payload is code; each is a string.
      expect(stringLiteralTokensContaining(source, 'process.exit')).toEqual([]);

      // The only identifier tokens that could come from the payload are ones
      // the generator itself emits: `process` (for process.env) and the local
      // `skipWithoutBaseUrl`/`baseUrl` names. `exit` must never appear as code.
      const payloadIdentifiers = scanTokens(source).filter(
        (token) =>
          token.kind === ts.SyntaxKind.Identifier &&
          ['exit', 'alert', 'eval', 'Function'].includes(token.text),
      );
      expect(payloadIdentifiers).toEqual([]);

      // The title is a quoted literal, so the payload cannot break out of it.
      const titleLines = source
        .split('\n')
        .filter((line) => line.includes('answers without a server error'));
      expect(titleLines).toHaveLength(1);
      expect(titleLines[0]).toContain(`GET ${HOSTILE_PATH} answers`);
    }
  });

  it('keeps hostile page paths inert as well', () => {
    const hostilePage = "'/); alert(1); ('";
    const cases = allCases(makeInspection({ pageRoutes: [page(hostilePage)] }));
    const navigation = cases.find((testCase) => testCase.kind === 'navigation');
    const source = navigation?.source ?? '';
    expect(source).toContain(JSON.stringify(hostilePage));
    expect(stringLiteralTokensContaining(source, 'alert')).toEqual([]);
    expect(
      scanTokens(source).filter(
        (token) => token.kind === ts.SyntaxKind.Identifier && token.text === 'alert',
      ),
    ).toEqual([]);
    expect(syntacticErrors(source)).toHaveLength(0);
  });

  it('keeps newline and quote injection inert in titles and paths', () => {
    const nasty = '/a"\n*/ it("x", () => { process.exit(1); }); /*';
    const cases = allCases(makeInspection({ apiRoutes: [route('GET', nasty)] }));
    const api = cases.find((testCase) => testCase.kind === 'api');
    const source = api?.source ?? '';
    expect(source).toContain(JSON.stringify(nasty));
    expect(stringLiteralTokensContaining(source, 'process.exit')).toEqual([]);
    expect(
      scanTokens(source).filter(
        (token) => token.kind === ts.SyntaxKind.Identifier && token.text === 'exit',
      ),
    ).toEqual([]);
    expect(syntacticErrors(source)).toHaveLength(0);
  });

  it('produces syntactically valid TypeScript for every case of every runner', () => {
    const inspection = makeInspection({
      apiRoutes: [
        route('GET', '/api/users'),
        route('POST', '/api/users', false),
        route('DELETE', '/api/users/:id', true),
        route('PATCH', HOSTILE_PATH, true),
      ],
      pageRoutes: [page('/'), page('/dash"board'), page('/a//b')],
      existingTests: [existing('generated-tests/api/get-api-users.test.ts')],
    });
    let checked = 0;
    for (const runner of RUNNERS) {
      const result = generateTests({ ...inspection, testRunner: runner });
      expect(result.cases.length).toBeGreaterThan(0);
      for (const testCase of result.cases) {
        const errors = syntacticErrors(testCase.source);
        expect(
          errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
        ).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
