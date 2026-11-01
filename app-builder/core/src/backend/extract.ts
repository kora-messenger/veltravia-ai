import { redactSensitiveText } from './redact.js';
import type {
  BackendEnvironmentVariable,
  BackendFunction,
  BackendHttpMethod,
  BackendManifest,
  BackendModel,
  BackendModelField,
  BackendModelRelationship,
  BackendRoute,
  RouteAuthState,
} from './types.js';

/**
 * Evidence-preserving extraction.
 *
 * Every function here reads ONE file's text and reports only what the text
 * literally says: a route declaration, a model block, an environment variable
 * name. There is no inference about behaviour, no attempt to evaluate code, and
 * nothing here can execute anything - the input is a string, the output is
 * data. Extracted text is redacted before it can leave the server.
 */

export interface BackendFileText {
  readonly path: string;
  readonly content: string;
}

const MAX_EVIDENCE = 160;
const MAX_ROUTES_PER_FILE = 200;

const METHOD_WORDS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

/** Words that indicate a route declaration is guarded in its own file. */
const AUTH_HINTS =
  /\b(preHandler|onRequest|requireAuth|requireUser|requireLogin|authenticate|ensureAuth|ensureLoggedIn|isAuthenticated|authGuard|verifyToken|verifySession|@login_required|@requires_auth|Depends\(\s*(?:get_)?current_user)\b/;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return redactSensitiveText(flat.length > MAX_EVIDENCE ? `${flat.slice(0, MAX_EVIDENCE)}…` : flat);
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < content.length; cursor += 1) {
    if (content[cursor] === '\n') line += 1;
  }
  return line;
}

/** A guard registered once for the whole file, e.g. `app.use(requireAuth)`. */
const GLOBAL_GUARD =
  /\b(?:app|router|fastify|server)\s*\.\s*(?:use|addHook)\s*\(\s*['"]?(?:preHandler|onRequest)?['"]?\s*,?\s*\b(?:requireAuth|requireUser|requireLogin|authenticate|ensureAuth|authGuard|verifyToken|verifySession)\b/;

/**
 * Truthful only in one direction: a guard we can see means `declared`; nothing
 * here may claim a route is public, so everything else stays `unknown`.
 */
function authStateFor(content: string, declaration: string): RouteAuthState {
  if (AUTH_HINTS.test(declaration)) return 'declared';
  if (GLOBAL_GUARD.test(content)) return 'declared';
  return 'unknown';
}

function methodOf(raw: string): BackendHttpMethod | null {
  const word = raw.toLowerCase();
  if (!METHOD_WORDS.has(word)) return null;
  if (word === 'all') return null;
  return word.toUpperCase() as BackendHttpMethod;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `app.get('/path', handler)` and friends, incl. optional chaining.
 *
 * Fastify allows an options object between the path and the handler
 * (`app.get('/x', { preHandler }, handler)`), so a single-level `{...}` is
 * allowed to sit there. Without that, the handler of every guarded route would
 * be reported as unnamed even though the source names it.
 */
const CALL_ROUTE =
  /(?<!@)\b(?:app|router|server|fastify|api|routes?|group)\s*\??\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])([^'"`\n]{1,200})\2\s*(?:,\s*(?:\{[^{}\n]*\}\s*,\s*)?([A-Za-z_$][\w$.]*))?/g;

/** `fastify.route({ method: 'GET', url: '/path' })`. */
const ROUTE_OBJECT = /\.route\s*<\s*[^>]*>\s*\(\s*\{|\.route\s*\(\s*\{/g;

/** `@app.get('/path')`, `@router.post('/path', ...)`. */
const PY_DECORATOR =
  /@\s*(?:app|router|api|bp|blueprint)\s*\.\s*(get|post|put|patch|delete|head|options|route)\s*\(\s*['"]([^'"\n]{1,200})['"]/g;

/** `path('users/<id>/', view)` inside a Django urlconf. */
const DJANGO_PATH = /\b(?:path|re_path)\s*\(\s*['"]([^'"\n]{1,200})['"]\s*,\s*([A-Za-z_$][\w.]*)/g;

/**
 * Words that sit where a handler name would, but are not one.
 *
 * `app.post('/x', async (req) => ...)` captures `async` with a naive identifier
 * pattern. Reporting "async" as the handler would be a fabricated name, so those
 * positions become `null` - "not named in the source we read".
 */
const NOT_A_HANDLER_NAME = new Set([
  'async',
  'await',
  'function',
  'new',
  'return',
  'then',
  'catch',
  'true',
  'false',
  'null',
  'undefined',
]);

function handlerName(candidate: string | undefined): string | null {
  if (candidate === undefined) return null;
  if (NOT_A_HANDLER_NAME.has(candidate)) return null;
  return candidate;
}

function nextJsAppRoute(file: string): { path: string } | null {
  const normalised = file.replace(/\\/g, '/');
  const match = /(?:^|\/)app\/(.*)\/route\.(?:ts|js|mjs)$/.exec(normalised);
  if (match === null) {
    if (/(?:^|\/)app\/route\.(?:ts|js|mjs)$/.test(normalised)) return { path: '/' };
    return null;
  }
  const segments = (match[1] ?? '')
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith('('))
    .map((segment) =>
      segment.startsWith('[') ? `:${segment.replace(/[[\]]/g, '').replace('...', '')}` : segment,
    );
  return { path: `/${segments.join('/')}`.replace(/\/$/, '') || '/' };
}

function nextJsPagesRoute(file: string): string | null {
  const normalised = file.replace(/\\/g, '/');
  const match = /(?:^|\/)pages\/(api\/.*)\.(?:ts|js|mjs)$/.exec(normalised);
  if (match === null) return null;
  const rest = (match[1] ?? '').replace(/\/index$/, '');
  return `/${rest}`.replace(/\/$/, '');
}

function routeFromAppFile(file: string, content: string): BackendRoute[] {
  const target = nextJsAppRoute(file);
  if (target === null) return [];
  const driven =
    /(?:^|\n)\s*export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  const routes: BackendRoute[] = [];
  let match = driven.exec(content);
  while (match !== null && routes.length < MAX_ROUTES_PER_FILE) {
    routes.push({
      method: (match[1] ?? 'GET') as BackendHttpMethod,
      path: target.path,
      file,
      line: lineAt(content, match.index),
      handler: `${match[1]}`,
      auth: authStateFor(content, match[0]),
      source: 'next-app-router',
      evidence: clip(match[0]),
    });
    match = driven.exec(content);
  }
  return routes;
}

function routeFromPagesApi(file: string, content: string): BackendRoute[] {
  const path = nextJsPagesRoute(file);
  if (path === null) return [];
  if (
    !/export\s+default\s+(?:async\s+)?function\s+handler|export\s+default\s+async\s*\(/.test(
      content,
    )
  ) {
    return [];
  }
  const methodChecks =
    /req(?:uest)?\.method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g;
  const routes: BackendRoute[] = [];
  let match = methodChecks.exec(content);
  while (match !== null && routes.length < MAX_ROUTES_PER_FILE) {
    routes.push({
      method: (match[1] ?? 'GET') as BackendHttpMethod,
      path,
      file,
      line: lineAt(content, match.index),
      handler: 'handler',
      auth: authStateFor(content, match[0]),
      source: 'next-pages-api',
      evidence: clip(match[0]),
    });
    match = methodChecks.exec(content);
  }
  if (routes.length === 0) {
    // A handler with no method check answers every verb; report that plainly.
    const index = content.search(/export\s+default/);
    routes.push({
      method: 'OPTIONS',
      path,
      file,
      line: lineAt(content, Math.max(0, index)),
      handler: 'handler',
      auth: authStateFor(content, 'handler'),
      source: 'next-pages-api',
      evidence: 'handler without an explicit method check (any method)',
    });
  }
  return routes;
}

/** Extracts every route declaration a single file shows. */
export function extractRoutes(input: BackendFileText): BackendRoute[] {
  const file = input.path;
  const { content } = input;
  const routes: BackendRoute[] = [
    ...routeFromAppFile(file, content),
    ...routeFromPagesApi(file, content),
  ];

  let match = CALL_ROUTE.exec(content);
  while (match !== null && routes.length < MAX_ROUTES_PER_FILE) {
    const method = methodOf(match[1] ?? '');
    const routePath = match[3] ?? '';
    if (method !== null && routePath.startsWith('/')) {
      routes.push({
        method,
        path: routePath,
        file,
        line: lineAt(content, match.index),
        handler: handlerName(match[4]),
        auth: authStateFor(content, content.slice(match.index, match.index + 220)),
        source: 'express-fastify',
        evidence: clip(match[0]),
      });
    } else if (match[1]?.toLowerCase() === 'all' && routePath.startsWith('/')) {
      routes.push({
        method: 'GET',
        path: routePath,
        file,
        line: lineAt(content, match.index),
        handler: handlerName(match[4]),
        auth: authStateFor(content, match[0]),
        source: 'express-fastify',
        evidence: `${clip(match[0])} (declared for any method; shown as GET)`,
      });
    }
    match = CALL_ROUTE.exec(content);
  }

  let objectMatch = ROUTE_OBJECT.exec(content);
  while (objectMatch !== null && routes.length < MAX_ROUTES_PER_FILE) {
    const window = content.slice(objectMatch.index, objectMatch.index + 400);
    const methodMatch = /method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/.exec(
      window,
    );
    const urlMatch = /url\s*:\s*['"]([^'"\n]{1,200})['"]/.exec(window);
    if (methodMatch !== null && urlMatch !== null) {
      routes.push({
        method: (methodMatch[1] ?? 'GET') as BackendHttpMethod,
        path: urlMatch[1] ?? '/',
        file,
        line: lineAt(content, objectMatch.index),
        handler: null,
        auth: authStateFor(content, window),
        source: 'fastify-route-object',
        evidence: clip(`${objectMatch[0]} method: '${methodMatch[1]}', url: '${urlMatch[1]}' }`),
      });
    }
    objectMatch = ROUTE_OBJECT.exec(content);
  }

  let pyMatch = PY_DECORATOR.exec(content);
  while (pyMatch !== null && routes.length < MAX_ROUTES_PER_FILE) {
    const raw = (pyMatch[1] ?? '').toLowerCase();
    const methods: BackendHttpMethod[] =
      raw === 'route' ? ['GET'] : [raw.toUpperCase() as BackendHttpMethod];
    for (const method of methods) {
      routes.push({
        method,
        path: pyMatch[2] ?? '/',
        file,
        line: lineAt(content, pyMatch.index),
        handler: null,
        auth: authStateFor(content, pyMatch[0]),
        source: 'python-decorator',
        evidence: clip(pyMatch[0]),
      });
    }
    pyMatch = PY_DECORATOR.exec(content);
  }

  let djangoMatch = DJANGO_PATH.exec(content);
  while (
    djangoMatch !== null &&
    routes.length < MAX_ROUTES_PER_FILE &&
    /urls?\.py$|urlconf/i.test(file)
  ) {
    routes.push({
      method: 'GET',
      path: `/${(djangoMatch[1] ?? '').replace(/^\/+/, '')}`,
      file,
      line: lineAt(content, djangoMatch.index),
      handler: djangoMatch[2] ?? null,
      auth: authStateFor(content, djangoMatch[0]),
      source: 'django-urlconf',
      evidence: `${clip(djangoMatch[0])} (urlconf declares no method; shown as GET)`,
    });
    djangoMatch = DJANGO_PATH.exec(content);
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const PRISMA_MODEL = /^model\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)^\}/gm;
const SQL_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][\w.]*)["`\]]?\s*\(([\s\S]*?)\)\s*;/gi;
const SQL_INDEX =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+["`[]?([\w.]+)["`\]]?\s+ON\s+["`[]?([\w.]+)["`\]]?\s*\(([^)]*)\)/gi;

const PRISMA_SCALARS = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

function normalisePrismaType(raw: string): string {
  const base = raw.replace(/[[\]?]+/g, '');
  return base.length > 0 ? base : 'unknown';
}

function parsePrismaModels(file: BackendFileText): BackendModel[] {
  const models: BackendModel[] = [];
  const { content } = file;
  let match = PRISMA_MODEL.exec(content);
  while (match !== null) {
    const name = match[1] ?? 'Unknown';
    const body = match[2] ?? '';
    const fields: BackendModelField[] = [];
    const relationships: BackendModelRelationship[] = [];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('//') || line.startsWith('@@')) continue;
      const parts = line.split(/\s+/);
      const fieldName = parts[0];
      const rawType = parts[1];
      if (fieldName === undefined || rawType === undefined) continue;
      if (fieldName.startsWith('@')) continue;
      const attributes = parts.slice(2).join(' ');
      const list = rawType.endsWith('[]');
      const type = normalisePrismaType(rawType);
      const isRelationField =
        /@relation/.test(attributes) || (PRISMA_SCALARS.has(type) === false && /^[A-Z]/.test(type));
      fields.push({
        name: fieldName,
        type,
        required: !rawType.endsWith('?') && !list,
        primaryKey: /@id\b|@@id/.test(attributes),
        unique: /@unique\b/.test(attributes),
        references: isRelationField ? type : null,
      });
      if (isRelationField) {
        relationships.push({
          field: fieldName,
          target: type,
          cardinality: list ? 'list' : 'single',
          derivedFrom: 'prisma-relation',
        });
      }
    }

    models.push({
      name,
      source: 'prisma',
      file: file.path,
      line: lineAt(content, match.index),
      fields,
      indexes: [...body.matchAll(/@@(?:unique|index)\s*\(([^)]*)\)/g)].map((entry) =>
        (entry[1] ?? '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim(),
      ),
      relationships,
    });
    match = PRISMA_MODEL.exec(content);
  }
  return models;
}

function parseSqlModels(file: BackendFileText): BackendModel[] {
  const models: BackendModel[] = [];
  const { content } = file;
  const indexes = new Map<string, string[]>();
  let indexMatch = SQL_INDEX.exec(content);
  while (indexMatch !== null) {
    const table = (indexMatch[2] ?? '').toLowerCase();
    const entry = `${indexMatch[1] ?? 'index'} (${(indexMatch[3] ?? '').replace(/\s+/g, ' ').trim()})`;
    indexes.set(table, [...(indexes.get(table) ?? []), entry]);
    indexMatch = SQL_INDEX.exec(content);
  }

  let match = SQL_TABLE.exec(content);
  while (match !== null) {
    const name = (match[1] ?? 'unknown').split('.').pop() ?? 'unknown';
    const body = match[2] ?? '';
    const fields: BackendModelField[] = [];
    const relationships: BackendModelRelationship[] = [];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (line.length === 0) continue;
      if (/^(PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|CHECK)\b/i.test(line)) {
        const fk =
          /FOREIGN\s+KEY\s*\(\s*["`[]?(\w+)["`\]]?\s*\)\s*REFERENCES\s+["`[]?(\w+)["`\]]?/i.exec(
            line,
          );
        if (fk !== null) {
          relationships.push({
            field: fk[1] ?? 'unknown',
            target: fk[2] ?? 'unknown',
            cardinality: 'single',
            derivedFrom: 'sql-foreign-key',
          });
        }
        continue;
      }
      const parts = line.split(/\s+/);
      const fieldName = (parts[0] ?? '').replace(/["`[\]]/g, '');
      const type = parts[1] ?? 'unknown';
      if (fieldName.length === 0) continue;
      const rest = parts.slice(2).join(' ');
      const fk = /REFERENCES\s+["`[]?(\w+)["`\]]?/i.exec(rest);
      fields.push({
        name: fieldName,
        type,
        required: /NOT\s+NULL/i.test(rest) || /PRIMARY\s+KEY/i.test(rest),
        primaryKey: /PRIMARY\s+KEY/i.test(rest),
        unique: /UNIQUE/i.test(rest),
        references: fk?.[1] ?? null,
      });
      if (fk !== null) {
        relationships.push({
          field: fieldName,
          target: fk[1] ?? 'unknown',
          cardinality: 'single',
          derivedFrom: 'sql-foreign-key',
        });
      }
    }

    models.push({
      name,
      source: 'sql',
      file: file.path,
      line: lineAt(content, match.index),
      fields,
      indexes: indexes.get(name.toLowerCase()) ?? [],
      relationships,
    });
    match = SQL_TABLE.exec(content);
  }
  return models;
}

/** Parses Prisma and SQL schema declarations. Other formats are not guessed. */
export function extractModels(file: BackendFileText): BackendModel[] {
  if (/\.prisma$/i.test(file.path) || /^\s*model\s+[A-Za-z_]\w*\s*\{/m.test(file.content)) {
    return parsePrismaModels(file);
  }
  if (/\.sql$/i.test(file.path) || /CREATE\s+TABLE/i.test(file.content)) {
    return parseSqlModels(file);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

const FUNCTION_DIRS =
  /(?:^|\/)(netlify\/functions|functions|api|workers|lambda|lambdas|supabase\/functions|serverless)\/[^/]+\.(?:ts|js|mjs|py|go)$/i;

const HANDLER_SIGNATURE =
  /export\s+(?:default\s+)?(?:async\s+)?function\s+handler\b|export\s+const\s+handler\s*[:=]|exports\.handler\s*=|export\s+default\s+async\s+function\b|def\s+handler\s*\(/;

/** Serverless-style entry points, identified by directory and by handler shape. */
export function extractFunctions(file: BackendFileText, runtime: string | null): BackendFunction[] {
  const inFunctionDir = FUNCTION_DIRS.test(file.path);
  const hasHandler = HANDLER_SIGNATURE.test(file.content);
  if (!inFunctionDir && !hasHandler) return [];
  if (/(?:^|\/)pages\/api\//.test(file.path)) return [];

  const name =
    file.path
      .replace(/^(?:.*\/)?(?:functions|api|workers|lambda|lambdas|netlify)\//, '')
      .replace(/\.(?:ts|js|mjs|py|go)$/i, '')
      .replace(/\/index$/, '') || file.path;

  const signature = HANDLER_SIGNATURE.exec(file.content);
  return [
    {
      name,
      file: file.path,
      kind: inFunctionDir ? 'serverless-function' : 'request-handler',
      runtime,
      // A handler signature that destructures a typed body is still not a
      // published schema; only a declared schema counts, and none is parsed.
      inputSchema: 'not-declared',
      outputSchema: 'not-declared',
      evidence: clip(
        signature?.[0] ?? `file under ${file.path.split('/').slice(0, -1).join('/')}/`,
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

const CODE_ENV_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{1,64})/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]{1,64})['"]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{1,64})/g,
  /os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Z][A-Z0-9_]{1,64})['"]/g,
  /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]{1,64})['"]/g,
  /env\(\s*['"]([A-Z][A-Z0-9_]{1,64})['"]\s*\)/g,
];

const TEMPLATE_ENV_FILE = /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/;

/** Names only. A value is never read, stored or returned. */
export function extractEnvironment(file: BackendFileText): BackendEnvironmentVariable[] {
  const found = new Map<
    string,
    { sources: Set<string>; kind: 'code' | 'template'; first: number }
  >();

  const record = (name: string, kind: 'code' | 'template', at: number) => {
    const existing = found.get(name);
    if (existing === undefined) {
      found.set(name, { sources: new Set([file.path]), kind, first: at });
      return;
    }
    existing.sources.add(file.path);
    if (kind === 'code') existing.kind = 'code';
    existing.first = Math.min(existing.first, at);
  };

  for (const pattern of CODE_ENV_PATTERNS) {
    const scoped = new RegExp(pattern.source, pattern.flags);
    let match = scoped.exec(file.content);
    while (match !== null) {
      const name = match[1];
      if (name !== undefined) record(name, 'code', match.index);
      match = scoped.exec(file.content);
    }
  }

  if (TEMPLATE_ENV_FILE.test(file.path)) {
    let scopedIndex = 0;
    for (const rawLine of file.content.split('\n')) {
      scopedIndex += rawLine.length + 1;
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const name = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      // Only the name is kept; the value on the right of `=` is discarded here.
      if (name !== undefined) record(name, 'template', scopedIndex);
    }
  }

  return [...found.entries()]
    .sort((left, right) => left[1].first - right[1].first)
    .map(([name, value]) => ({
      name,
      sources: [...value.sources].sort(),
      kind: value.kind,
    }));
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const MANIFEST_FILES =
  /(?:^|\/)(package\.json|requirements\.txt|pyproject\.toml|composer\.json|go\.mod|Gemfile)$/i;

/** Dependency NAMES from a manifest. Versions are dropped deliberately. */
export function extractManifest(file: BackendFileText): BackendManifest | null {
  if (!MANIFEST_FILES.test(file.path)) return null;
  const base = file.path.split('/').pop() ?? file.path;

  if (base === 'package.json') {
    try {
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      const names: string[] = [];
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const block = parsed[key];
        if (block !== null && typeof block === 'object') {
          names.push(...Object.keys(block as Record<string, unknown>));
        }
      }
      return { file: file.path, dependencies: [...new Set(names)].sort() };
    } catch {
      return { file: file.path, dependencies: [] };
    }
  }

  if (base === 'requirements.txt' || base === 'Gemfile') {
    const names = file.content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => /^([A-Za-z0-9_.-]+)/.exec(line)?.[1] ?? '')
      .filter((name) => name.length > 0);
    return { file: file.path, dependencies: [...new Set(names)].sort() };
  }

  if (base === 'pyproject.toml') {
    const names = [...file.content.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[><=~!]/gm)].map(
      (entry) => entry[1] ?? '',
    );
    return {
      file: file.path,
      dependencies: [...new Set(names.filter((name) => name.length > 0))].sort(),
    };
  }

  if (base === 'composer.json') {
    try {
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      const block = parsed['require'];
      const names = block !== null && typeof block === 'object' ? Object.keys(block) : [];
      return { file: file.path, dependencies: names.sort() };
    } catch {
      return { file: file.path, dependencies: [] };
    }
  }

  if (base === 'go.mod') {
    const names = [
      ...file.content.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v/gim),
    ].map((entry) => entry[1] ?? '');
    return { file: file.path, dependencies: [...new Set(names)].sort() };
  }

  return null;
}

/** Exposed for the report builder: which files are worth reading at all. */
export function isBackendSourceFile(path: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|go|java|kt|cs|rs|sql|prisma|json|toml)$/i.test(path) ||
    /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/.test(path)
  );
}
