/**
 * Structural application inspection for the Step 39 AI application-testing
 * agent.
 *
 * PURE: no filesystem, no process, no network, no clock, no randomness, no
 * environment access. The inspector receives file paths plus already-bounded
 * text and returns a structural description of the application.
 *
 * SECURITY: every `text` value is UNTRUSTED PROJECT DATA. It is only ever
 * pattern-matched; nothing is evaluated, imported or executed, and nothing in
 * it is treated as an instruction. A comment that says "IGNORE PREVIOUS
 * INSTRUCTIONS" is just characters and cannot change the result.
 *
 * Every output array is sorted deterministically (path, then line, then method)
 * so the same input always produces byte-identical output.
 */

import {
  APP_TEST_LIMITS,
  DATABASE_KINDS,
  type AppInspection,
  type BackendFramework,
  type DatabaseKind,
  type DiscoveredRoute,
  type ExistingTest,
  type FrontendFramework,
  type InspectableFile,
  type TestRunner,
} from './types.js';

// ---------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------

/** Paths under these directory names are never inspected. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
]);

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
]);

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const;

/** Cap on a captured route path, independent of any per-file cap. */
const MAX_ROUTE_PATH_CHARS = 200;
/** Cap on the statement/options window inspected for a single route. */
const MAX_STATEMENT_CHARS = 2_000;
/** Cap on the block window inspected for a single route handler. */
const MAX_BLOCK_CHARS = 4_000;
const MAX_DEPENDENCY_NAME_CHARS = 214;

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/** Route paths that imply an authentication surface. */
const AUTH_ROUTE_PATH =
  /\/(?:login|signin|sign-in|signup|sign-up|logout|auth|register|session|token)\b/i;

const AUTH_GUARD_IDENTIFIER =
  /\b(?:authenticate|ensureauthenticated|ensureloggedin|requireauth|requiresession|requirelogin|isauth|isauthenticated|verifytoken|verifyjwt|authguard|authmiddleware|checkauth|requireadmin|requireauthenticated|requiresignin)\b/i;
const AUTH_IDENTIFIER_HINT = /\b\w*(?:auth|session|jwt|token|guard)\w*\b/i;
const PRE_HANDLER_IDENTIFIER = /\bprehandler\b/i;
const AUTH_HINT = /(?:auth|jwt|session|token|bearer|guard)/i;

/**
 * Auth-capable dependencies. Presence of one only means "this project has auth
 * machinery", never that any particular route is protected.
 */
const AUTH_DEPENDENCIES: readonly string[] = [
  'passport',
  'passport-local',
  'passport-jwt',
  'passport-google-oauth20',
  'next-auth',
  '@auth/core',
  '@auth/nextjs',
  'jsonwebtoken',
  'jose',
  'express-session',
  'cookie-session',
  'express-jwt',
  'koa-jwt',
  'koa-session',
  '@fastify/jwt',
  'iron-session',
  'lucia',
  '@clerk/nextjs',
  '@supabase/supabase-js',
  'firebase-admin',
];

// Pattern sources (compiled per scan so no `lastIndex` state is shared).
const EXPRESS_ROUTE_CALL =
  /\b(?:app|router|server|api|fastify)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(/i;
const FASTIFY_ROUTE_CALL = /\b(?:fastify|app|server|router|instance)\s*\.\s*route\s*\(\s*\{/i;
const FASTIFY_URL_KEY = /\b(?:url|path)\s*:/i;
const FASTIFY_METHOD_KEY = /\bmethod\s*:/i;
const REACT_ROUTER_ROUTE =
  /<Route\b[^>]{0,400}?\bpath\s*=\s*(?:"([^"]{0,200})"|'([^']{0,200})'|\{\s*["'`]([^"'`]{0,200})["'`]\s*\})/i;
const NEXT_APP_METHOD_EXPORT =
  /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i;
const REQUEST_METHOD_CHECK = /\.method\s*===?\s*(['"])([A-Za-z]+)\1/i;

const VITEST_IMPORT = /from\s+['"]vitest['"]|require\(\s*['"]vitest['"]\s*\)|from\s+['"]@vitest\//i;
const NODE_TEST_IMPORT = /from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/i;
const JEST_IMPORT = /from\s+['"]@jest\/globals['"]|from\s+['"]jest['"]/i;
const MOCHA_IMPORT = /from\s+['"]mocha['"]|require\(\s*['"]mocha['"]\s*\)/i;

const FORM_MARKERS: readonly RegExp[] = [
  /<form[\s>]/i,
  /\bonSubmit\b/,
  /\buseForm\b/,
  /\bFormik\b/,
  /react-hook-form/,
  /\bv-model\b/,
  /\[\(\s*ngModel\s*\)\]/,
  /\bhandleSubmit\b/,
];

const DATABASE_DEPENDENCIES: readonly {
  readonly kind: DatabaseKind;
  readonly names: readonly string[];
}[] = [
  { kind: 'postgres', names: ['pg', 'postgres', 'postgresql'] },
  { kind: 'mysql', names: ['mysql', 'mysql2', 'mariadb'] },
  { kind: 'sqlite', names: ['sqlite3', 'better-sqlite3', 'sql.js', '@libsql/client'] },
  { kind: 'mongodb', names: ['mongodb', 'mongoose'] },
  { kind: 'redis', names: ['redis', 'ioredis'] },
  { kind: 'prisma', names: ['prisma', '@prisma/client'] },
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Normalises a reported path to forward slashes without a leading `./` or `/`. */
function normalizePath(raw: string): string {
  const segments = raw.replace(/\\/g, '/').split('/');
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') continue;
    kept.push(segment);
  }
  return kept.join('/');
}

/** True when any directory component of the path is an ignored build/vendor dir. */
function isIgnoredPath(path: string): boolean {
  const segments = path.split('/');
  const directories = segments.slice(0, Math.max(0, segments.length - 1));
  return directories.some((directory) => IGNORED_DIRECTORIES.has(directory));
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(path));
}

function cleanPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ROUTE_PATH_CHARS) return null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  return trimmed;
}

function routePathOrNull(value: string): string | null {
  const cleaned = cleanPath(value);
  if (cleaned === null) return null;
  if (!cleaned.startsWith('/') && cleaned !== '*') return null;
  return cleaned;
}

/** Reads a JS string literal starting at `from`, or null when there is none. */
function readStringLiteral(text: string, from: number): string | null {
  let index = from;
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
  const quote = text.charAt(index);
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  const start = index + 1;
  index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return text.slice(start, index);
    if (index - start > MAX_ROUTE_PATH_CHARS * 4) return null;
    index += 1;
  }
  return null;
}

function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** 1-based line number of an absolute character offset. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function lineTextAt(text: string, starts: readonly number[], offset: number): string {
  const line = lineOf(starts, offset);
  const from = starts[line - 1] ?? 0;
  let to = text.indexOf('\n', from);
  if (to === -1) to = text.length;
  return text.slice(from, to);
}

/** Cheap comment guard so a commented-out call is not reported as a route. */
function isCommentPrefix(line: string, column: number): boolean {
  const before = line.slice(0, Math.max(0, column)).trimStart();
  if (before.startsWith('//')) return true;
  if (before.startsWith('/*') && !before.includes('*/')) return true;
  return /^\*(?!\/)/.test(before) || /^\*\s/.test(before);
}

/** Runs `visit` over every match without sharing regex `lastIndex` state. */
function forEachMatch(source: RegExp, text: string, visit: (match: RegExpExecArray) => void): void {
  const flags = source.flags.includes('g') ? source.flags : `${source.flags}g`;
  const pattern = new RegExp(source.source, flags);
  let match = pattern.exec(text);
  while (match !== null) {
    visit(match);
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(text);
  }
}

function isOpener(char: string): boolean {
  return char === '(' || char === '[' || char === '{';
}

function isCloser(char: string): boolean {
  return char === ')' || char === ']' || char === '}';
}

/** From an opening bracket, the balanced statement window (bounded). */
function statementWindow(text: string, from: number): string {
  const limit = Math.min(text.length, from + MAX_STATEMENT_CHARS);
  let depth = 0;
  for (let index = from; index < limit; index += 1) {
    const char = text.charAt(index);
    if (isOpener(char)) depth += 1;
    else if (isCloser(char)) {
      depth -= 1;
      if (depth <= 0) return text.slice(from, index + 1);
    }
  }
  return text.slice(from, limit);
}

/**
 * From the start of a declaration, its balanced body block (bounded). The
 * window starts at the first `{`, so a parameter list such as
 * `(request: Request)` is not mistaken for the body.
 */
function blockWindow(text: string, from: number): string {
  const limit = Math.min(text.length, from + MAX_BLOCK_CHARS);
  const bodyStart = text.indexOf('{', from);
  if (bodyStart === -1 || bodyStart >= limit) return text.slice(from, limit);
  let depth = 0;
  for (let index = bodyStart; index < limit; index += 1) {
    const char = text.charAt(index);
    if (isOpener(char)) depth += 1;
    else if (isCloser(char)) {
      depth -= 1;
      if (depth <= 0) return text.slice(from, index + 1);
    }
  }
  return text.slice(from, limit);
}

/** Removes quoted string contents so a route PATH can never look like a guard. */
function stripStringLiterals(window: string): string {
  let out = '';
  let index = 0;
  while (index < window.length) {
    const quote = window.charAt(index);
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      out += quote;
      index += 1;
      continue;
    }
    index += 1;
    while (index < window.length && window.charAt(index) !== quote) {
      if (window.charAt(index) === '\\') index += 1;
      index += 1;
    }
    index += 1;
    out += ' ';
  }
  return out;
}

/**
 * True only when an auth guard identifier is visibly present in the route's
 * statement/options window (route paths are stripped first). A `preHandler`
 * counts only alongside an auth/authorize/jwt/session hint. `false` means "no
 * guard seen", never "public".
 */
function hasAuthGuard(window: string): boolean {
  const code = stripStringLiterals(window);
  if (AUTH_GUARD_IDENTIFIER.test(code)) return true;
  if (AUTH_IDENTIFIER_HINT.test(code)) return true;
  return PRE_HANDLER_IDENTIFIER.test(code) && AUTH_HINT.test(code);
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Prepared input
// ---------------------------------------------------------------------------

interface PreparedFile {
  readonly path: string;
  readonly text: string | null;
  readonly isCode: boolean;
  readonly starts: readonly number[] | null;
}

interface ManifestSummary {
  readonly names: readonly string[];
  readonly main: string | null;
}

function isDependencyName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_DEPENDENCY_NAME_CHARS) return false;
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name);
}

function collectDependencyNames(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) {
      if (isDependencyName(name)) names.add(name);
    }
  }
  return [...names].sort(compareStrings);
}

function readManifestMain(manifest: Record<string, unknown>): string | null {
  const value = manifest['main'];
  if (typeof value !== 'string') return null;
  const cleaned = cleanPath(value.replace(/\\/g, '/'));
  if (cleaned === null) return null;
  if (!/^[A-Za-z0-9._@/-]+$/.test(cleaned)) return null;
  if (cleaned.split('/').includes('..')) return null;
  return cleaned;
}

/** Parses the manifest defensively; returns null on malformed JSON. */
function parseManifest(text: string): ManifestSummary | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return { names: collectDependencyNames(record), main: readManifestMain(record) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

function hasAnyDependency(deps: ReadonlySet<string>, names: readonly string[]): boolean {
  return names.some((name) => deps.has(name));
}

function detectFrontend(
  deps: ReadonlySet<string>,
  files: readonly PreparedFile[],
): FrontendFramework {
  const hasExtension = (extension: string): boolean =>
    files.some((file) => file.path.endsWith(extension));
  if (deps.has('next')) return 'next';
  if (deps.has('vue') || deps.has('nuxt') || hasExtension('.vue')) return 'vue';
  if (deps.has('svelte') || deps.has('@sveltejs/kit') || hasExtension('.svelte')) return 'svelte';
  if (deps.has('@angular/core') || [...deps].some((name) => name.startsWith('@angular/'))) {
    return 'angular';
  }
  if (deps.has('react') || deps.has('react-dom') || hasExtension('.tsx') || hasExtension('.jsx')) {
    return 'react';
  }
  return 'none';
}

function detectBackend(
  deps: ReadonlySet<string>,
  files: readonly PreparedFile[],
): BackendFramework {
  if (deps.has('fastify')) return 'fastify';
  if (hasAnyDependency(deps, ['@nestjs/core', '@nestjs/common'])) return 'nest';
  if (deps.has('express')) return 'express';
  if (hasAnyDependency(deps, ['koa', '@koa/router'])) return 'koa';
  if (isNextProject(deps, files)) {
    if (files.some((file) => isNextApiRouteFile(file.path) || isNextPagesApiFile(file.path))) {
      return 'next-api';
    }
  }
  let sawFastify = false;
  let sawNest = false;
  let sawExpress = false;
  let sawKoa = false;
  for (const file of files) {
    if (!file.isCode || file.text === null) continue;
    if (
      !sawFastify &&
      /from\s+['"]fastify['"]|require\(\s*['"]fastify['"]\s*\)|new\s+Fastify\s*\(/i.test(file.text)
    ) {
      sawFastify = true;
    }
    if (!sawNest && /from\s+['"]@nestjs\/(?:core|common)['"]|NestFactory/i.test(file.text)) {
      sawNest = true;
    }
    if (
      !sawExpress &&
      /from\s+['"]express['"]|require\(\s*['"]express['"]\s*\)|express\.Router\s*\(/i.test(
        file.text,
      )
    ) {
      sawExpress = true;
    }
    if (
      !sawKoa &&
      /from\s+['"]koa['"]|require\(\s*['"]koa['"]\s*\)|new\s+Koa\s*\(|@koa\/router/i.test(file.text)
    ) {
      sawKoa = true;
    }
  }
  if (sawFastify) return 'fastify';
  if (sawNest) return 'nest';
  if (sawExpress) return 'express';
  if (sawKoa) return 'koa';
  return 'none';
}

function detectTestRunner(deps: ReadonlySet<string>, files: readonly PreparedFile[]): TestRunner {
  const hasPath = (pattern: RegExp): boolean =>
    files.some((file) => pattern.test(baseName(file.path)));
  if (deps.has('vitest') || hasPath(/^vitest\.(?:config|workspace)\./i)) return 'vitest';
  if (deps.has('jest') || deps.has('ts-jest') || hasPath(/^jest\.config\./i)) return 'jest';
  if (deps.has('mocha') || hasPath(/^\.mocharc/i)) return 'mocha';
  for (const file of files) {
    if (file.isCode && file.text !== null && NODE_TEST_IMPORT.test(file.text)) return 'node-test';
  }
  return 'none';
}

function detectDatabases(
  deps: ReadonlySet<string>,
  files: readonly PreparedFile[],
): DatabaseKind[] {
  const found = new Set<DatabaseKind>();
  for (const entry of DATABASE_DEPENDENCIES) {
    if (hasAnyDependency(deps, entry.names)) found.add(entry.kind);
  }
  if (files.some((file) => /^(?:.*\/)?prisma\/schema\.prisma$/i.test(file.path))) {
    found.add('prisma');
  }
  return DATABASE_KINDS.filter((kind) => found.has(kind));
}

// ---------------------------------------------------------------------------
// Next.js path helpers
// ---------------------------------------------------------------------------

function dynamicSegment(segment: string): string {
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
  if (optionalCatchAll !== null) return `*${optionalCatchAll[1] ?? 'path'}`;
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll !== null) return `*${catchAll[1] ?? 'path'}`;
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic !== null) return `:${dynamic[1] ?? 'param'}`;
  return segment;
}

function isNextApiRouteFile(path: string): boolean {
  return /^(?:src\/)?app\/(?:[^/]+\/)*route\.(?:ts|tsx|js|jsx|mjs)$/i.test(path);
}

function isNextPageFile(path: string): boolean {
  return /^(?:src\/)?app\/(?:[^/]+\/)*page\.(?:tsx|ts|jsx|js|mdx)$/i.test(path);
}

function isNextPagesApiFile(path: string): boolean {
  return /^(?:src\/)?pages\/api\/.+\.(?:ts|tsx|js|jsx|mjs)$/i.test(path);
}

function isNextPagesPageFile(path: string): boolean {
  return /^(?:src\/)?pages\/(?!api\/).+\.(?:tsx|ts|jsx|js|mdx)$/i.test(path);
}

function appDirectorySegments(path: string): string[] | null {
  const segments = path.split('/');
  const start = segments[0] === 'src' ? 1 : 0;
  if (segments[start] !== 'app') return null;
  return segments.slice(start + 1, -1);
}

function routePathFromSegments(segments: readonly string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment.startsWith('(') || segment.startsWith('@')) continue;
    parts.push(dynamicSegment(segment));
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function withoutCodeExtension(path: string): string {
  return path.replace(/\.(?:tsx|ts|jsx|js|mjs|mdx)$/i, '');
}

function pagesSegments(relative: string): string[] {
  const segments = withoutCodeExtension(relative)
    .split('/')
    .filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (last === 'index') segments.pop();
  return segments;
}

// ---------------------------------------------------------------------------
// Route collection
// ---------------------------------------------------------------------------

interface RouteCollector {
  readonly api: DiscoveredRoute[];
  readonly page: DiscoveredRoute[];
}

function pushRoute(target: DiscoveredRoute[], route: DiscoveredRoute): void {
  target.push(route);
}

function collectCallRoutes(file: PreparedFile, target: DiscoveredRoute[]): void {
  const text = file.text;
  const starts = file.starts;
  if (text === null || starts === null) return;

  forEachMatch(EXPRESS_ROUTE_CALL, text, (match) => {
    const column = match.index - (starts[lineOf(starts, match.index) - 1] ?? 0);
    if (isCommentPrefix(lineTextAt(text, starts, match.index), column)) return;
    const openParen = text.indexOf('(', match.index);
    if (openParen === -1) return;
    const literal = readStringLiteral(text, openParen + 1);
    if (literal === null) return;
    const path = routePathOrNull(literal);
    if (path === null) return;
    const method = (match[1] ?? '').toUpperCase();
    if (!HTTP_METHODS.has(method) && method !== 'ALL') return;
    pushRoute(target, {
      method,
      path,
      file: file.path,
      line: lineOf(starts, match.index),
      guarded: hasAuthGuard(statementWindow(text, openParen)),
    });
  });

  forEachMatch(FASTIFY_ROUTE_CALL, text, (match) => {
    const column = match.index - (starts[lineOf(starts, match.index) - 1] ?? 0);
    if (isCommentPrefix(lineTextAt(text, starts, match.index), column)) return;
    const openParen = text.indexOf('(', match.index);
    if (openParen === -1) return;
    const window = statementWindow(text, openParen);

    const urlKey = FASTIFY_URL_KEY.exec(window);
    if (urlKey === null) return;
    const urlLiteral = readStringLiteral(window, urlKey.index + urlKey[0].length);
    if (urlLiteral === null) return;
    const path = routePathOrNull(urlLiteral);
    if (path === null) return;

    const methodKey = FASTIFY_METHOD_KEY.exec(window);
    if (methodKey === null) return;
    const methodStart = methodKey.index + methodKey[0].length;
    const methods: string[] = [];
    const arrayMatch = /^\s*\[/.exec(window.slice(methodStart));
    if (arrayMatch !== null) {
      forEachMatch(/['"]([A-Za-z]+)['"]/, window.slice(methodStart), (item) => {
        const method = (item[1] ?? '').toUpperCase();
        if (HTTP_METHODS.has(method)) methods.push(method);
      });
    } else {
      const methodLiteral = readStringLiteral(window, methodStart);
      const method = (methodLiteral ?? '').trim().toUpperCase();
      if (HTTP_METHODS.has(method)) methods.push(method);
    }
    const guarded = hasAuthGuard(window);
    for (const method of methods) {
      pushRoute(target, {
        method,
        path,
        file: file.path,
        line: lineOf(starts, match.index),
        guarded,
      });
    }
  });
}

/**
 * The JSX opening tag starting at `from`, honouring nested braces and quoted
 * attributes so `<Route element={<Admin />} loader={requireAuth}>` is one tag.
 */
function jsxTagWindow(text: string, from: number): string {
  const limit = Math.min(text.length, from + 1_000);
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < limit; index += 1) {
    const char = text.charAt(index);
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth <= 0) return text.slice(from, index + 1);
  }
  return text.slice(from, limit);
}

function collectReactRouterRoutes(file: PreparedFile, target: DiscoveredRoute[]): void {
  const text = file.text;
  const starts = file.starts;
  if (text === null || starts === null) return;
  forEachMatch(REACT_ROUTER_ROUTE, text, (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const path = cleanPath(raw);
    if (path === null) return;
    pushRoute(target, {
      method: 'PAGE',
      path,
      file: file.path,
      line: lineOf(starts, match.index),
      guarded: hasAuthGuard(jsxTagWindow(text, match.index)),
    });
  });
}

/**
 * True when the project is structurally a Next.js app. `pages/api` alone is
 * also produced by plain Node servers, so a Next marker must be present too.
 */
function isNextProject(deps: ReadonlySet<string>, files: readonly PreparedFile[]): boolean {
  if (deps.has('next')) return true;
  return files.some((file) => {
    const path = file.path;
    if (/^(?:src\/)?next\.config\.[cm]?[jt]s$/i.test(path)) return true;
    if (/^(?:src\/)?pages\/_(?:app|document)\.[jt]sx?$/i.test(path)) return true;
    if (/^(?:src\/)?app\/(?:[^/]+\/)*(?:page|layout|route)\.[jt]sx?$/i.test(path)) return true;
    return false;
  });
}

function collectNextRoutes(
  file: PreparedFile,
  collector: RouteCollector,
  nextProject: boolean,
): void {
  if (!nextProject) return;
  const text = file.text;
  const starts = file.starts;

  if (isNextApiRouteFile(file.path)) {
    const directories = appDirectorySegments(file.path) ?? [];
    const path = routePathFromSegments(directories);
    if (text === null || starts === null) return;
    const methods: { readonly method: string; readonly offset: number }[] = [];
    forEachMatch(NEXT_APP_METHOD_EXPORT, text, (match) => {
      const method = (match[1] ?? '').toUpperCase();
      if (!HTTP_METHODS.has(method)) return;
      if (methods.some((entry) => entry.method === method)) return;
      methods.push({ method, offset: match.index });
    });
    for (const entry of methods) {
      pushRoute(collector.api, {
        method: entry.method,
        path,
        file: file.path,
        line: lineOf(starts, entry.offset),
        guarded: hasAuthGuard(blockWindow(text, entry.offset)),
      });
    }
    return;
  }

  if (isNextPagesApiFile(file.path)) {
    const relative = file.path.replace(/^(?:src\/)?pages\/api\//i, '');
    const segments = pagesSegments(relative).map(dynamicSegment);
    const path = segments.length === 0 ? '/api' : `/api/${segments.join('/')}`;
    if (text === null || starts === null) return;
    const methods: string[] = [];
    forEachMatch(REQUEST_METHOD_CHECK, text, (match) => {
      const method = (match[2] ?? '').toUpperCase();
      if (HTTP_METHODS.has(method) && !methods.includes(method)) methods.push(method);
    });
    const guarded = hasAuthGuard(text.slice(0, MAX_BLOCK_CHARS));
    if (methods.length === 0) {
      pushRoute(collector.api, { method: 'ALL', path, file: file.path, line: 1, guarded });
      return;
    }
    for (const method of methods) {
      pushRoute(collector.api, { method, path, file: file.path, line: 1, guarded });
    }
    return;
  }

  if (isNextPageFile(file.path)) {
    const directories = appDirectorySegments(file.path) ?? [];
    const path = routePathFromSegments(directories);
    const guarded =
      text !== null && starts !== null ? hasAuthGuard(text.slice(0, MAX_BLOCK_CHARS)) : false;
    pushRoute(collector.page, { method: 'PAGE', path, file: file.path, line: 1, guarded });
    return;
  }

  if (isNextPagesPageFile(file.path)) {
    const relative = file.path.replace(/^(?:src\/)?pages\//i, '');
    const segments = pagesSegments(relative);
    if (segments.some((segment) => segment.startsWith('_'))) return;
    if (segments.length > 0 && baseName(withoutCodeExtension(relative)).startsWith('_')) return;
    const mapped = segments.map(dynamicSegment);
    const path = mapped.length === 0 ? '/' : `/${mapped.join('/')}`;
    const guarded =
      text !== null && starts !== null ? hasAuthGuard(text.slice(0, MAX_BLOCK_CHARS)) : false;
    pushRoute(collector.page, { method: 'PAGE', path, file: file.path, line: 1, guarded });
  }
}

function isNextConventionFile(path: string): boolean {
  return (
    isNextApiRouteFile(path) ||
    isNextPageFile(path) ||
    isNextPagesApiFile(path) ||
    isNextPagesPageFile(path)
  );
}

function compareRoutes(a: DiscoveredRoute, b: DiscoveredRoute): number {
  const byFile = compareStrings(a.file, b.file);
  if (byFile !== 0) return byFile;
  if (a.line !== b.line) return a.line - b.line;
  const byMethod = compareStrings(a.method, b.method);
  if (byMethod !== 0) return byMethod;
  return compareStrings(a.path, b.path);
}

function sortAndDedupeRoutes(routes: readonly DiscoveredRoute[]): DiscoveredRoute[] {
  const seen = new Set<string>();
  const unique: DiscoveredRoute[] = [];
  for (const route of routes) {
    const key = `${route.file}\u0000${route.line}\u0000${route.method}\u0000${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(route);
  }
  return unique.sort(compareRoutes);
}

// ---------------------------------------------------------------------------
// Tests, entry points, auth and forms
// ---------------------------------------------------------------------------

function isTestFile(path: string): boolean {
  if (!isCodeFile(path)) return false;
  const base = baseName(path);
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  const segments = path.split('/');
  return segments.slice(0, -1).includes('__tests__');
}

function runnerForTestFile(file: PreparedFile, fallback: TestRunner): TestRunner {
  const text = file.text;
  if (text !== null) {
    if (VITEST_IMPORT.test(text)) return 'vitest';
    if (NODE_TEST_IMPORT.test(text)) return 'node-test';
    if (JEST_IMPORT.test(text)) return 'jest';
    if (MOCHA_IMPORT.test(text)) return 'mocha';
  }
  return fallback;
}

const ENTRY_POINT_CANDIDATES: readonly string[] = [
  'src/main.ts',
  'src/main.tsx',
  'src/main.js',
  'src/main.jsx',
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.jsx',
  'src/server.ts',
  'src/server.js',
  'src/app.ts',
  'src/app.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.js',
  'index.ts',
  'index.js',
  'index.html',
];

function collectEntryPoints(files: readonly PreparedFile[], manifestMain: string | null): string[] {
  const present = new Set(files.map((file) => file.path));
  const entries = new Set<string>();
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (present.has(candidate)) entries.add(candidate);
  }
  if (manifestMain !== null) entries.add(manifestMain);
  return [...entries].sort(compareStrings);
}

function hasAuthDependency(deps: ReadonlySet<string>): boolean {
  return AUTH_DEPENDENCIES.some((name) => deps.has(name));
}

function hasAuthRoute(routes: readonly DiscoveredRoute[]): boolean {
  return routes.some((route) => AUTH_ROUTE_PATH.test(route.path));
}

function hasFormUsage(files: readonly PreparedFile[]): boolean {
  for (const file of files) {
    const text = file.text;
    if (!file.isCode || text === null) continue;
    if (FORM_MARKERS.some((marker) => marker.test(text))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Inspects an application from its file paths and bounded text.
 *
 * `fileCount` is the number of files actually inspected: paths under
 * node_modules/, dist/, build/, .git/ and coverage/ are excluded, and the
 * sorted list is capped at `APP_TEST_LIMITS.maxFiles`. `truncated` is set
 * whenever that cap, the per-file text cap or the route cap is hit.
 */
export function inspectApplication(files: readonly InspectableFile[]): AppInspection {
  const notes: string[] = [];
  const noteKeys = new Set<string>();
  const addNote = (note: string): void => {
    if (noteKeys.has(note)) return;
    noteKeys.add(note);
    notes.push(note);
  };
  let truncated = false;

  // 1. Normalise, drop vendor/build paths, dedupe and sort by path.
  const seenPaths = new Set<string>();
  const candidates: InspectableFile[] = [];
  let ignoredCount = 0;
  for (const file of files) {
    const path = normalizePath(file.path);
    if (path.length === 0) continue;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    if (isIgnoredPath(path)) {
      ignoredCount += 1;
      continue;
    }
    candidates.push({ path, text: file.text });
  }
  candidates.sort((a, b) => compareStrings(a.path, b.path));

  if (files.length === 0) addNote('No files were provided for inspection.');
  if (ignoredCount > 0) {
    addNote(
      `Ignored ${ignoredCount} file(s) inside node_modules/, dist/, build/, .git/ or coverage/.`,
    );
  }

  // 2. Cap the file count.
  let selected: readonly InspectableFile[] = candidates;
  if (candidates.length > APP_TEST_LIMITS.maxFiles) {
    selected = candidates.slice(0, APP_TEST_LIMITS.maxFiles);
    truncated = true;
    addNote(
      `File list truncated: only the first ${APP_TEST_LIMITS.maxFiles} files were inspected.`,
    );
  }

  // 3. Bound each file's text.
  let oversizedCount = 0;
  let unreadCount = 0;
  const prepared: PreparedFile[] = selected.map((file) => {
    let text = file.text;
    if (text !== null && text.length > APP_TEST_LIMITS.maxFileBytes) {
      text = text.slice(0, APP_TEST_LIMITS.maxFileBytes);
      oversizedCount += 1;
    }
    if (text === null) unreadCount += 1;
    return {
      path: file.path,
      text,
      isCode: isCodeFile(file.path),
      starts: text === null ? null : lineStarts(text),
    };
  });
  if (oversizedCount > 0) {
    truncated = true;
    addNote(
      `${oversizedCount} file(s) were longer than ${APP_TEST_LIMITS.maxFileBytes} characters; the excess text was ignored.`,
    );
  }
  if (unreadCount > 0) {
    addNote(`${unreadCount} file(s) had no text and were inspected by path only.`);
  }

  // 4. Manifest.
  const manifestFile = prepared.find((file) => file.path === 'package.json') ?? null;
  const deps = new Set<string>();
  let manifestMain: string | null = null;
  if (manifestFile === null) {
    addNote('No package.json found; dependency-based detection was skipped.');
  } else if (manifestFile.text === null) {
    addNote('package.json was provided without text; dependency-based detection was skipped.');
  } else {
    const summary = parseManifest(manifestFile.text);
    if (summary === null) {
      addNote('package.json could not be parsed as JSON; dependency-based detection was skipped.');
    } else {
      for (const name of summary.names) deps.add(name);
      manifestMain = summary.main;
    }
  }

  // 5. Frameworks, runner and databases.
  const frontend = detectFrontend(deps, prepared);
  const backend = detectBackend(deps, prepared);
  const testRunner = detectTestRunner(deps, prepared);
  const databases = detectDatabases(deps, prepared);

  if (frontend === 'none') {
    addNote('No frontend framework was detected from dependency names or file extensions.');
  }
  if (backend === 'none') {
    addNote('No backend framework was detected from dependency names or route-registration code.');
  }
  if (testRunner === 'none') {
    addNote('No test runner was detected.');
  }
  if (databases.length === 0) addNote('No database dependency was detected.');

  // 6. Routes.
  const collector: RouteCollector = { api: [], page: [] };
  const nextProject = isNextProject(deps, prepared);
  for (const file of prepared) {
    if (!file.isCode) continue;
    if (nextProject && isNextConventionFile(file.path)) continue;
    collectCallRoutes(file, collector.api);
    collectReactRouterRoutes(file, collector.page);
  }
  for (const file of prepared) {
    if (!file.isCode) continue;
    collectNextRoutes(file, collector, nextProject);
  }

  let apiRoutes: DiscoveredRoute[] = sortAndDedupeRoutes(collector.api);
  let pageRoutes: DiscoveredRoute[] = sortAndDedupeRoutes(collector.page);
  if (apiRoutes.length + pageRoutes.length > APP_TEST_LIMITS.maxRoutes) {
    truncated = true;
    addNote(
      `Route list truncated at ${APP_TEST_LIMITS.maxRoutes} routes; API routes were kept before page routes.`,
    );
    apiRoutes = apiRoutes.slice(0, APP_TEST_LIMITS.maxRoutes);
    const remaining = APP_TEST_LIMITS.maxRoutes - apiRoutes.length;
    pageRoutes = pageRoutes.slice(0, Math.max(0, remaining));
  }
  if (apiRoutes.length === 0) addNote('No API route was detected in the inspected files.');
  if (pageRoutes.length === 0) addNote('No page route was detected in the inspected files.');

  // 7. Tests, entry points, auth and forms.
  const existingTests: ExistingTest[] = prepared
    .filter((file) => isTestFile(file.path))
    .map((file) => ({ path: file.path, runner: runnerForTestFile(file, testRunner) }))
    .sort((a, b) => compareStrings(a.path, b.path));

  if (testRunner === 'none') {
    const imported = existingTests.find((test) => test.runner !== 'none');
    if (imported !== undefined) {
      addNote(
        `Test runner not detected from the manifest or a config file; existing tests import ${imported.runner}.`,
      );
    }
  }

  const entryPoints = collectEntryPoints(prepared, manifestMain);
  if (entryPoints.length === 0) addNote('No entry point was identified.');

  const hasForms = hasFormUsage(prepared) || deps.has('formik') || deps.has('react-hook-form');
  const hasAuth = hasAuthDependency(deps) || hasAuthRoute([...apiRoutes, ...pageRoutes]);

  return {
    fileCount: prepared.length,
    truncated,
    frontend,
    backend,
    testRunner,
    databases,
    entryPoints,
    apiRoutes,
    pageRoutes,
    existingTests,
    dependencies: [...deps].sort(compareStrings),
    hasAuth,
    hasForms,
    notes,
  };
}
