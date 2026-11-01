import type { BackendModel, BackendRoute } from '../backend/index.js';

import type {
  CrossLayerGraph,
  CrossLayerLink,
  LinkConfidence,
  UnmatchedRequest,
  UnmatchedReason,
} from './types.js';

/**
 * Cross-layer intelligence (Step 34).
 *
 * The graph answers one question: does a frontend request have a backend route
 * that could serve it? It answers only from the text that was read, so every
 * edge carries a file and a line at both ends. A request with no route stays in
 * `unmatchedRequests`; a route with no caller stays in `routesWithoutCaller`.
 * Nothing is inferred to fill a gap, and no edge is created from a name that
 * merely looks similar.
 */

export interface SourceTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LinkDetectionInput {
  readonly files: readonly SourceTextFile[];
  readonly routes: readonly BackendRoute[];
  readonly models?: readonly BackendModel[];
}

/** Caps keep the payload bounded; the counts stay honest when they bite. */
export const LINK_LIMITS = {
  maxLinks: 400,
  maxFilesRead: 120,
  maxEvidence: 160,
} as const;

interface RequestSite {
  readonly file: string;
  readonly line: number;
  readonly method: string | null;
  readonly url: string;
  readonly evidence: string;
}

const FETCH_PATTERN = /\bfetch\s*\(\s*([`'"])([^`'"]+)\1/;
const AXIOS_PATTERN =
  /\baxios\.(get|post|put|patch|delete|head|options)\s*\(\s*([`'"])([^`'"]+)\2/i;
const API_LITERAL_PATTERN = /([`'"])(\/api\/[^`'"]*)\1/;
const METHOD_PATTERN = /\bmethod\s*:\s*([`'"])([A-Za-z]+)\1/;

/** A line that DECLARES a route is not a line that calls one. */
const ROUTE_DECLARATION_PATTERN =
  /(?:\.|\b)(?:get|post|put|patch|delete|head|options|all|route)\s*\(\s*[`'"]|@[A-Za-z_]+\.[a-z_]+\s*\(|^\s*export\s+(?:async\s+)?(?:function|const)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= LINK_LIMITS.maxEvidence
    ? trimmed
    : `${trimmed.slice(0, LINK_LIMITS.maxEvidence - 1)}…`;
}

/** Every request-looking call in a file, with its line. */
export function extractRequestSites(file: SourceTextFile): RequestSite[] {
  const sites: RequestSite[] = [];
  const lines = file.content.split(/\r?\n/);
  const seen = new Set<string>();

  lines.forEach((text, index) => {
    const line = index + 1;
    // Route declarations read like a request (they carry an /api path literal).
    // They are the backend side of the graph, never a caller.
    if (ROUTE_DECLARATION_PATTERN.test(text)) return;
    const push = (method: string | null, url: string): void => {
      const key = `${line}:${method ?? ''}:${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      sites.push({ file: file.path, line, method, url, evidence: clip(text) });
    };

    const axios = AXIOS_PATTERN.exec(text);
    if (axios !== null && axios[3] !== undefined) {
      push((axios[1] ?? '').toUpperCase() || null, axios[3]);
      return;
    }

    const fetched = FETCH_PATTERN.exec(text);
    if (fetched !== null && fetched[2] !== undefined) {
      // A method literal belongs to THIS call. Read the rest of the line, and
      // only spill onto following lines while the call's parentheses are open,
      // so the next statement's `method:` is never borrowed.
      const fromCall = text.slice(Math.max(0, text.indexOf('fetch')));
      const open = (fromCall.match(/\(/g) ?? []).length - (fromCall.match(/\)/g) ?? []).length;
      const window = open > 0 ? lines.slice(index, index + 3).join(' ') : fromCall;
      const method = METHOD_PATTERN.exec(window);
      push(method?.[2]?.toUpperCase() ?? null, fetched[2]);
      return;
    }

    const literal = API_LITERAL_PATTERN.exec(text);
    if (literal !== null && literal[2] !== undefined) {
      push(null, literal[2]);
    }
  });

  return sites;
}

/** Route and request paths reduced to the same shape for comparison. */
function normalisePath(raw: string): string {
  const withoutQuery = raw.split(/[?#]/)[0] ?? '';
  const withoutOrigin = withoutQuery.replace(/^https?:\/\/[^/]+/i, '');
  const withoutTrailing = withoutOrigin.replace(/\/+$/, '');
  return withoutTrailing.length === 0 ? '/' : withoutTrailing;
}

/** A declared parameter segment matches any single request segment. */
function routeSegments(path: string): readonly string[] {
  return normalisePath(path)
    .split('/')
    .map((segment) =>
      /^(?::[A-Za-z0-9_]+|\[[^/\]]+\]|\{[^/}]+\}|<[^/>]+>)$/.test(segment) ? '*' : segment,
    );
}

function requestSegments(path: string): readonly string[] {
  return normalisePath(path).split('/');
}

function pathMatches(routePath: string, requestPath: string): 'exact' | 'parameterised' | null {
  const route = routeSegments(routePath);
  const request = requestSegments(requestPath);
  if (route.length !== request.length) return null;
  let parameterised = false;
  for (let index = 0; index < route.length; index += 1) {
    const expected = route[index];
    const actual = request[index];
    if (expected === '*') {
      if (actual === undefined || actual.length === 0) return null;
      parameterised = true;
      continue;
    }
    if (expected !== actual) return null;
  }
  return parameterised ? 'parameterised' : 'exact';
}

function requestHostKind(url: string): UnmatchedReason | null {
  if (/^https?:\/\//i.test(url)) return 'external-host';
  if (/\$\{|\+\s*[A-Za-z_$]/.test(url)) return 'dynamic-url';
  return null;
}

/** Builds the cross-layer graph from the text that was actually read. */
export function detectCrossLayerLinks(input: LinkDetectionInput): CrossLayerGraph {
  const routeFiles = new Set(input.routes.map((entry) => entry.file));
  // A file that declares routes is the backend side of the graph; reading it as
  // a caller would make every route look invoked by its own declaration.
  const files = input.files
    .filter((file) => !routeFiles.has(file.path))
    .slice(0, LINK_LIMITS.maxFilesRead);
  const contents = new Map(input.files.map((file) => [file.path, file.content]));
  const links: CrossLayerLink[] = [];
  const unmatchedRequests: UnmatchedRequest[] = [];
  const calledRoutes = new Set<string>();

  let requests = 0;
  for (const file of files) {
    for (const site of extractRequestSites(file)) {
      requests += 1;
      const hostReason = requestHostKind(site.url);
      if (hostReason !== null) {
        unmatchedRequests.push({
          file: site.file,
          line: site.line,
          method: site.method,
          url: site.url,
          reason: hostReason,
        });
        continue;
      }

      const candidates: { route: BackendRoute; confidence: LinkConfidence }[] = [];
      let verbMismatch = false;
      for (const route of input.routes) {
        const confidence = pathMatches(route.path, site.url);
        if (confidence === null) continue;
        if (site.method !== null && route.method !== site.method) {
          verbMismatch = true;
          continue;
        }
        candidates.push({ route, confidence });
      }

      const best = candidates[0];
      if (best === undefined) {
        unmatchedRequests.push({
          file: site.file,
          line: site.line,
          method: site.method,
          url: site.url,
          reason: verbMismatch ? 'method-mismatch' : 'no-matching-route',
        });
        continue;
      }

      calledRoutes.add(`${best.route.method} ${best.route.path}`);
      links.push({
        kind: 'frontend-request',
        from: {
          label: site.method === null ? site.url : `${site.method} ${site.url}`,
          file: site.file,
          line: site.line,
        },
        to: {
          label: `${best.route.method} ${best.route.path}`,
          file: best.route.file,
          line: best.route.line,
        },
        method: site.method ?? best.route.method,
        path: normalisePath(site.url),
        confidence: best.confidence,
        evidence: site.evidence,
      });
    }
  }

  // Route -> handler, handler -> model, route -> authentication wiring. Each of
  // these is read from the route's own declaration or its own file.
  for (const route of input.routes) {
    if (route.handler !== null) {
      links.push({
        kind: 'route-handler',
        from: { label: `${route.method} ${route.path}`, file: route.file, line: route.line },
        to: { label: route.handler, file: route.file, line: route.line },
        method: route.method,
        path: route.path,
        confidence: 'exact',
        evidence: route.evidence,
      });
    }

    if (route.auth === 'declared') {
      links.push({
        kind: 'route-auth',
        from: { label: `${route.method} ${route.path}`, file: route.file, line: route.line },
        to: { label: 'Authentication configuration', file: route.file, line: route.line },
        method: route.method,
        path: route.path,
        confidence: 'exact',
        evidence: route.evidence,
      });
    }

    const content = contents.get(route.file);
    if (content === undefined || input.models === undefined) continue;
    for (const model of input.models) {
      // Model accessors are often lower-cased (`prisma.user`), so the name is
      // matched case-insensitively, as a whole word, in the route's own file.
      const pattern = new RegExp(`\\b${model.name.replace(/[^A-Za-z0-9_]/g, '')}\\b`, 'i');
      const lines = content.split(/\r?\n/);
      const index = lines.findIndex((line) => pattern.test(line));
      if (index === -1) continue;
      links.push({
        kind: 'handler-model',
        from: {
          label: route.handler ?? `${route.method} ${route.path}`,
          file: route.file,
          line: index + 1,
        },
        to: { label: model.name, file: model.file, line: model.line },
        method: route.method,
        path: route.path,
        confidence: 'exact',
        evidence: clip(lines[index] ?? ''),
      });
      break;
    }
  }

  const clipped = links.slice(0, LINK_LIMITS.maxLinks);
  const routesWithoutCaller = input.routes
    .filter((route) => !calledRoutes.has(`${route.method} ${route.path}`))
    .map((route) => ({ method: route.method, path: route.path }));

  return {
    links: clipped,
    requests,
    unmatchedRequests: unmatchedRequests.slice(0, LINK_LIMITS.maxLinks),
    routesWithoutCaller: routesWithoutCaller.slice(0, LINK_LIMITS.maxLinks),
    note: 'Edges are read from the text of the files that were scanned. A request with no matching route is listed as unmatched, and an unmatched route is not an error: its caller may live outside the workspace.',
  };
}
