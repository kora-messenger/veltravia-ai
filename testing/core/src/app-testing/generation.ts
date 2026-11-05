/**
 * Deterministic test-source generation for the AI application-testing agent
 * (Step 39).
 *
 * Given an `AppInspection` this module produces runnable test SOURCE for the
 * project's own runner. It is pure: no filesystem, no clock, no randomness, no
 * network, and it never reads the host environment. Everything it returns is
 * text for a human to approve before a single byte is written.
 *
 * Three rules drive every decision below:
 *  - never invent a target: a kind is generated only when the inspection gives
 *    a real basis for it, otherwise it is reported as skipped with a reason;
 *  - every emitted assertion can fail: no tautologies, no placeholder checks,
 *    no test that would pass on an empty project;
 *  - project data is untrusted: route paths, page paths and titles are only
 *    ever embedded as JSON string literals, never concatenated into source.
 *
 * Output files always live under `generated-tests/`, so a generated path can
 * never overwrite a real source file.
 */

import {
  APP_TEST_LIMITS,
  TEST_KINDS,
  type AppInspection,
  type DiscoveredRoute,
  type GeneratedTestCase,
  type TestGenerationResult,
  type TestKind,
  type TestRunner,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A runner that can actually be targeted: 'none' is resolved before rendering. */
type EffectiveRunner = Exclude<TestRunner, 'none'>;

const FALLBACK_RUNNER: EffectiveRunner = 'node-test';

/** The only host variable a generated test may read. */
const BASE_URL_ENV = 'APP_TEST_BASE_URL';

/** The one skip message every environment-dependent test carries. */
const SKIP_NOTE = 'APP_TEST_BASE_URL is not set: the HTTP test was skipped rather than passed.';

/** A path no real API can serve; used by the 404 probe. */
const MISSING_PATH = '/__veltravia_nonexistent__';

const HTTP_METHODS: readonly string[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

const API_ROUTE_CAP = 20;
const PAGE_ROUTE_CAP = 20;

/**
 * Generation priority: lower runs first when the test budget is exceeded, so
 * the tests that can catch the most damage survive the cut.
 */
const KIND_PRIORITY: Readonly<Record<TestKind, number>> = {
  authentication: 0,
  api: 1,
  'error-handling': 2,
  navigation: 3,
  unit: 4,
  integration: 5,
  component: 6,
  'user-flow': 7,
  'form-validation': 8,
  regression: 9,
};

/** Why a kind is skipped when the inspection gives no basis at all. */
const STRUCTURAL_SKIP_REASONS: Readonly<Partial<Record<TestKind, string>>> = {
  unit: 'Unit tests need a target module and an exported function; the inspection records paths, routes and dependencies only, so no unit seam could be exercised.',
  integration:
    'No cross-module seam (database, queue, external service) was identified from the inspection; a combined test would only repeat the generated API smoke checks.',
  component: 'Needs a browser or component runtime that is not available in this build',
  'user-flow': 'Needs a browser or component runtime that is not available in this build',
  'form-validation': 'Needs a browser or component runtime that is not available in this build',
  regression: 'Regression is verified by re-running earlier results after a repair',
};

const GENERATED_ROOT = 'generated-tests';

const MAX_SLUG_LENGTH = 48;

// ---------------------------------------------------------------------------
// Plans: what a generated file should contain, independent of the runner
// ---------------------------------------------------------------------------

type Payload =
  | { readonly type: 'http-smoke'; readonly method: string; readonly path: string }
  | { readonly type: 'http-auth'; readonly method: string; readonly path: string }
  | { readonly type: 'http-missing'; readonly path: string }
  | { readonly type: 'page-path'; readonly path: string; readonly pagePaths: readonly string[] };

interface Candidate {
  readonly kind: TestKind;
  readonly target: string;
  readonly slugSource: string;
  readonly suite: string;
  readonly title: string;
  readonly payload: Payload;
  readonly comment: string | null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function clip(text: string): string {
  const limit = APP_TEST_LIMITS.maxTextChars;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** A JSON string literal: the only way untrusted text enters generated source. */
function json(value: string): string {
  return JSON.stringify(value);
}

function hashSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Lowercase [a-z0-9-] only, deterministic, bounded, never empty. */
function slugify(value: string): string {
  const collapsed = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (collapsed === '') return 'root';
  if (collapsed.length <= MAX_SLUG_LENGTH) return collapsed;
  const head = collapsed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  return `${head}-${hashSuffix(value)}`;
}

function normalizeExistingPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function summarizeList(values: readonly string[]): string {
  const head = values.slice(0, 5).join(', ');
  if (values.length <= 5) return head;
  return `${head} and ${values.length - 5} more`;
}

function httpMethodOf(route: DiscoveredRoute): string | null {
  const method = route.method.trim().toUpperCase();
  return HTTP_METHODS.includes(method) ? method : null;
}

function isMutating(method: string): boolean {
  return MUTATING_METHODS.includes(method);
}

function pushCandidate(candidates: Candidate[], candidate: Candidate): void {
  candidates.push({
    ...candidate,
    title: clip(candidate.title),
    target: clip(candidate.target),
    suite: clip(candidate.suite),
  });
}

// ---------------------------------------------------------------------------
// Candidate collection: only what the inspection really shows
// ---------------------------------------------------------------------------

interface Collection {
  readonly candidates: Candidate[];
  readonly notes: string[];
  readonly reasons: Map<TestKind, string>;
}

function collectApi(inspection: AppInspection, collection: Collection): void {
  const routes = inspection.apiRoutes;
  if (routes.length === 0) {
    collection.reasons.set(
      'api',
      'No API routes were detected in the inspection, so there was no endpoint to call.',
    );
    return;
  }
  if (routes.length > API_ROUTE_CAP) {
    collection.notes.push(
      clip(
        `Only the first ${API_ROUTE_CAP} of ${routes.length} API routes were used for HTTP smoke tests.`,
      ),
    );
  }

  const used = routes.slice(0, API_ROUTE_CAP);
  const unconfirmed: string[] = [];
  const rejected: string[] = [];
  let built = 0;

  for (const route of used) {
    const method = httpMethodOf(route);
    if (method === null) {
      rejected.push(`${clip(route.method)} ${clip(route.path)}`);
      continue;
    }
    const mutating = isMutating(method);
    const authUnknown = mutating && !route.guarded;
    if (authUnknown) unconfirmed.push(`${method} ${clip(route.path)}`);
    pushCandidate(collection.candidates, {
      kind: 'api',
      target: `${method} ${route.path}`,
      slugSource: `${method} ${route.path}`,
      suite: `${method} ${route.path}`,
      title: `${method} ${route.path} answers without a server error`,
      payload: { type: 'http-smoke', method, path: route.path },
      comment: authUnknown
        ? 'Auth could not be confirmed for this mutating route: the request below sends no credentials, so a 401 or 403 is an acceptable answer.'
        : null,
    });
    built += 1;
  }

  if (rejected.length > 0) {
    collection.notes.push(
      clip(
        `Skipped ${rejected.length} API route(s) whose method was not an HTTP method: ${summarizeList(rejected)}.`,
      ),
    );
  }
  if (built === 0) {
    collection.reasons.set(
      'api',
      'Every detected API route used a non-HTTP method, so no request could be built.',
    );
  }
  if (unconfirmed.length > 0) {
    collection.notes.push(
      clip(
        `Auth could not be confirmed for ${unconfirmed.length} mutating route(s) (${summarizeList(unconfirmed)}); those smoke tests only assert the answer is not a server error.`,
      ),
    );
  }
}

function collectAuthentication(inspection: AppInspection, collection: Collection): void {
  if (!inspection.hasAuth) {
    collection.reasons.set(
      'authentication',
      'The inspection found no authentication handling, so there is no guarded route to reject an unauthenticated request.',
    );
    return;
  }
  const guarded = inspection.apiRoutes.filter((route) => route.guarded);
  if (guarded.length === 0) {
    collection.reasons.set(
      'authentication',
      'Authentication was detected but no route carried a visible auth guard, so no unauthenticated rejection could be asserted.',
    );
    return;
  }
  if (guarded.length > API_ROUTE_CAP) {
    collection.notes.push(
      clip(
        `Only the first ${API_ROUTE_CAP} of ${guarded.length} guarded routes were used for authentication tests.`,
      ),
    );
  }

  const rejected: string[] = [];
  for (const route of guarded.slice(0, API_ROUTE_CAP)) {
    const method = httpMethodOf(route);
    if (method === null) {
      rejected.push(`${clip(route.method)} ${clip(route.path)}`);
      continue;
    }
    pushCandidate(collection.candidates, {
      kind: 'authentication',
      target: `${method} ${route.path}`,
      slugSource: `auth ${method} ${route.path}`,
      suite: `${method} ${route.path}`,
      title: `${method} ${route.path} rejects an unauthenticated request with 401 or 403`,
      payload: { type: 'http-auth', method, path: route.path },
      comment:
        'This route carries a visible auth guard, so an unauthenticated request must be refused.',
    });
  }
  if (rejected.length > 0) {
    collection.notes.push(
      clip(
        `Skipped ${rejected.length} guarded route(s) whose method was not an HTTP method: ${summarizeList(rejected)}.`,
      ),
    );
  }
}

function collectNavigation(inspection: AppInspection, collection: Collection): void {
  const pages = inspection.pageRoutes;
  if (pages.length === 0) {
    collection.reasons.set(
      'navigation',
      'No page routes were detected in the inspection, so there was no path to check.',
    );
    return;
  }
  if (pages.length > PAGE_ROUTE_CAP) {
    collection.notes.push(
      clip(`Only the first ${PAGE_ROUTE_CAP} of ${pages.length} page routes were checked.`),
    );
  }

  const used = pages.slice(0, PAGE_ROUTE_CAP);
  const allPaths = used.map((page) => page.path);
  for (const page of used) {
    pushCandidate(collection.candidates, {
      kind: 'navigation',
      target: page.path,
      slugSource: `page ${page.path}`,
      suite: `page route ${page.path}`,
      title: `${page.path} is a well-formed absolute page path that appears once`,
      payload: { type: 'page-path', path: page.path, pagePaths: allPaths },
      comment: 'Static structural check: it needs no browser and no server.',
    });
  }
}

function collectErrorHandling(inspection: AppInspection, collection: Collection): void {
  if (inspection.apiRoutes.length === 0) {
    collection.reasons.set(
      'error-handling',
      'No API routes were detected in the inspection, so no server target existed to ask for an unknown path.',
    );
    return;
  }
  pushCandidate(collection.candidates, {
    kind: 'error-handling',
    target: MISSING_PATH,
    slugSource: 'unknown path',
    suite: 'unknown path',
    title: `GET ${MISSING_PATH} answers 404 and not a server error`,
    payload: { type: 'http-missing', path: MISSING_PATH },
    comment: 'A path that cannot exist must be reported as 404, never as a 5xx crash.',
  });
}

// ---------------------------------------------------------------------------
// Selection: deterministic, value-ordered, bounded
// ---------------------------------------------------------------------------

function selectCandidates(candidates: readonly Candidate[], notes: string[]): readonly Candidate[] {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        KIND_PRIORITY[left.candidate.kind] - KIND_PRIORITY[right.candidate.kind] ||
        left.index - right.index,
    )
    .map((entry) => entry.candidate);

  if (ordered.length <= APP_TEST_LIMITS.maxTests) return ordered;
  notes.push(
    clip(
      `Only the ${APP_TEST_LIMITS.maxTests} highest-value of ${ordered.length} candidate tests were generated (APP_TEST_LIMITS.maxTests).`,
    ),
  );
  return ordered.slice(0, APP_TEST_LIMITS.maxTests);
}

function sortByKind(candidates: readonly Candidate[]): readonly Candidate[] {
  const order = new Map<TestKind, number>(TEST_KINDS.map((kind, index) => [kind, index]));
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        (order.get(left.candidate.kind) ?? TEST_KINDS.length) -
          (order.get(right.candidate.kind) ?? TEST_KINDS.length) || left.index - right.index,
    )
    .map((entry) => entry.candidate);
}

function allocatePath(used: Set<string>, kind: TestKind, slug: string): string {
  const directory = `${GENERATED_ROOT}/${kind}`;
  let candidate = `${directory}/${slug}.test.ts`;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${directory}/${slug}-${suffix}.test.ts`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function headerLines(runner: EffectiveRunner): readonly string[] {
  const banner = [
    '/**',
    ' * Generated by the Veltravia AI application-testing agent.',
    ` * Runner: ${runner}.`,
    ' * Do not edit by hand: regenerate from a fresh inspection instead.',
    ' */',
  ];
  switch (runner) {
    case 'vitest':
      return [...banner, "import { describe, it, expect } from 'vitest';"];
    case 'jest':
      return [...banner, '// Jest provides describe/it/expect as globals, so nothing is imported.'];
    case 'mocha':
      return [
        ...banner,
        "import assert from 'node:assert/strict';",
        '// Mocha provides describe/it as globals; assertions use node:assert/strict.',
      ];
    case 'node-test':
      return [
        ...banner,
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
      ];
  }
}

const JOIN_URL_LINES: readonly string[] = [
  'function joinUrl(baseUrl: string, routePath: string): string {',
  "  const trimmed = baseUrl.replace(/\\/+$/, '');",
  "  return trimmed + (routePath.charAt(0) === '/' ? routePath : '/' + routePath);",
  '}',
];

function baseUrlPrelude(runner: EffectiveRunner): readonly string[] {
  switch (runner) {
    case 'vitest':
      return [
        'function readBaseUrl(ctx: { skip: (note: string) => never }): string {',
        `  const baseUrl = process.env.${BASE_URL_ENV};`,
        "  if (baseUrl === undefined || baseUrl === '') {",
        `    ctx.skip(${json(SKIP_NOTE)});`,
        '  }',
        '  return baseUrl;',
        '}',
        '',
        ...JOIN_URL_LINES,
      ];
    case 'jest':
    case 'mocha':
      return [
        `const BASE_URL = process.env.${BASE_URL_ENV} ?? '';`,
        '',
        "if (BASE_URL === '') {",
        `  console.warn(${json(SKIP_NOTE)});`,
        '}',
        '',
        "const whenBaseUrlIsSet = BASE_URL === '' ? it.skip : it;",
        '',
        ...JOIN_URL_LINES,
      ];
    case 'node-test':
      return [
        `const BASE_URL = process.env.${BASE_URL_ENV} ?? '';`,
        `const skipWithoutBaseUrl: string | false =`,
        `  BASE_URL === '' ? ${json(SKIP_NOTE)} : false;`,
        '',
        ...JOIN_URL_LINES,
      ];
  }
}

function preludeLines(runner: EffectiveRunner, payload: Payload): readonly string[] {
  if (payload.type === 'page-path') {
    return [`const PAGE_PATHS: string[] = ${JSON.stringify(payload.pagePaths)};`];
  }
  return baseUrlPrelude(runner);
}

function usesExpect(runner: EffectiveRunner): boolean {
  return runner === 'vitest' || runner === 'jest';
}

function requestLines(runner: EffectiveRunner, method: string, path: string): readonly string[] {
  const baseUrl = runner === 'vitest' ? 'readBaseUrl(ctx)' : 'BASE_URL';
  return [
    `const baseUrl = ${baseUrl};`,
    `const response = await fetch(joinUrl(baseUrl, ${json(path)}), {`,
    `  method: ${json(method)},`,
    "  redirect: 'manual',",
    '});',
  ];
}

function bodyLines(runner: EffectiveRunner, payload: Payload): readonly string[] {
  const expectStyle = usesExpect(runner);

  switch (payload.type) {
    case 'http-smoke':
      return [
        ...requestLines(runner, payload.method, payload.path),
        expectStyle
          ? 'expect(response.status).toBeLessThan(500);'
          : "assert.ok(response.status < 500, 'the route answered with a server error');",
      ];
    case 'http-auth':
      return [
        ...requestLines(runner, payload.method, payload.path),
        expectStyle
          ? 'expect([401, 403]).toContain(response.status);'
          : "assert.ok(response.status === 401 || response.status === 403, 'the guarded route did not reject an unauthenticated request');",
      ];
    case 'http-missing':
      return [
        ...requestLines(runner, 'GET', payload.path),
        expectStyle
          ? 'expect(response.status).toBeLessThan(500);'
          : "assert.ok(response.status < 500, 'an unknown path answered with a server error');",
        expectStyle
          ? 'expect(response.status).toBe(404);'
          : "assert.equal(response.status, 404, 'an unknown path must answer 404');",
      ];
    case 'page-path':
      return expectStyle
        ? [
            `const pagePath = ${json(payload.path)};`,
            "expect(pagePath.charAt(0)).toBe('/');",
            "expect(pagePath.indexOf('//')).toBe(-1);",
            'expect(pagePath).toBe(pagePath.trim());',
            'expect(PAGE_PATHS.filter((candidate) => candidate === pagePath)).toHaveLength(1);',
          ]
        : [
            `const pagePath = ${json(payload.path)};`,
            "assert.equal(pagePath.charAt(0), '/', 'a page route must be an absolute path');",
            "assert.equal(pagePath.indexOf('//'), -1, 'a page route must not contain an empty segment');",
            "assert.equal(pagePath, pagePath.trim(), 'a page route must not carry surrounding whitespace');",
            "assert.equal(PAGE_PATHS.filter((candidate) => candidate === pagePath).length, 1, 'a page route must be listed exactly once');",
          ];
  }
}

function pushBlock(target: string[], block: readonly string[], indent: string): void {
  for (const line of block) {
    target.push(line === '' ? '' : `${indent}${line}`);
  }
}

function renderSource(runner: EffectiveRunner, candidate: Candidate): string {
  const needsBaseUrl = candidate.payload.type !== 'page-path';
  const lines: string[] = [...headerLines(runner), ''];
  pushBlock(lines, preludeLines(runner, candidate.payload), '');
  lines.push('');

  if (candidate.comment !== null) {
    lines.push(`// ${candidate.comment}`);
  }

  const body = bodyLines(runner, candidate.payload);

  if (runner === 'node-test') {
    const options = needsBaseUrl ? '{ skip: skipWithoutBaseUrl }' : '{}';
    lines.push(`test(${json(candidate.title)}, ${options}, async () => {`);
    pushBlock(lines, body, '  ');
    lines.push('});');
  } else {
    lines.push(`describe(${json(candidate.suite)}, () => {`);
    const callee = runner === 'vitest' || !needsBaseUrl ? 'it' : 'whenBaseUrlIsSet';
    const params = runner === 'vitest' && needsBaseUrl ? '(ctx)' : '()';
    lines.push(`  ${callee}(${json(candidate.title)}, async ${params} => {`);
    pushBlock(lines, body, '    ');
    lines.push('  });');
    lines.push('});');
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function resolveRunner(detected: TestRunner, notes: string[]): EffectiveRunner {
  if (detected !== 'none') return detected;
  notes.push(
    clip(
      'The inspection found no test runner, so tests were generated for node:test with node:assert/strict: both are built into Node, so the generated tests need no dependency. Add a test runner to the project and regenerate to target it instead.',
    ),
  );
  return FALLBACK_RUNNER;
}

export function generateTests(inspection: AppInspection): TestGenerationResult {
  const notes: string[] = [];
  const runner = resolveRunner(inspection.testRunner, notes);
  const collection: Collection = {
    candidates: [],
    notes,
    reasons: new Map<TestKind, string>(),
  };

  if (inspection.truncated) {
    notes.push(
      clip(
        'The inspection was truncated: only the files, routes and dependencies it listed were considered.',
      ),
    );
  }

  collectApi(inspection, collection);
  collectAuthentication(inspection, collection);
  collectNavigation(inspection, collection);
  collectErrorHandling(inspection, collection);

  const selected = sortByKind(selectCandidates(collection.candidates, notes));

  const usedPaths = new Set(
    inspection.existingTests.map((existing) => normalizeExistingPath(existing.path)),
  );
  const cases: GeneratedTestCase[] = [];
  const counters = new Map<TestKind, number>();

  for (const candidate of selected) {
    const source = renderSource(runner, candidate);
    const size = byteLength(source);
    if (size > APP_TEST_LIMITS.maxGeneratedFileBytes) {
      notes.push(
        clip(
          `Source over the ${APP_TEST_LIMITS.maxGeneratedFileBytes} byte limit for one generated file (${size} bytes), so ${clip(candidate.target)} was not generated.`,
        ),
      );
      if (!collection.reasons.has(candidate.kind)) {
        collection.reasons.set(
          candidate.kind,
          `Every source generated for this kind was larger than the ${APP_TEST_LIMITS.maxGeneratedFileBytes} byte limit for one generated file.`,
        );
      }
      continue;
    }

    const path = allocatePath(usedPaths, candidate.kind, slugify(candidate.slugSource));
    const ordinal = (counters.get(candidate.kind) ?? 0) + 1;
    counters.set(candidate.kind, ordinal);

    cases.push({
      id: `tc-${candidate.kind}-${ordinal}`,
      kind: candidate.kind,
      title: candidate.title,
      target: candidate.target,
      path,
      runner,
      source,
    });
  }

  const produced = new Set<TestKind>(cases.map((generated) => generated.kind));
  const skipped: { kind: TestKind; reason: string }[] = [];
  for (const kind of TEST_KINDS) {
    if (produced.has(kind)) continue;
    const reason =
      collection.reasons.get(kind) ??
      STRUCTURAL_SKIP_REASONS[kind] ??
      'The inspection gave no basis for this kind of test';
    skipped.push({ kind, reason });
  }

  if (cases.length === 0) {
    notes.push(
      clip(
        'No test could be generated from this inspection: nothing runnable was emitted rather than emitting a test that cannot fail.',
      ),
    );
  }

  return { runner, cases, skipped, notes };
}
