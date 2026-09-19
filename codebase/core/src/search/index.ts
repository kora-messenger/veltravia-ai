/**
 * Code search engine (Phase 15, 16, 18).
 *
 * Five bounded search modes over ONE stored index: exact text, symbol,
 * file, relationship, and structural. Every important result carries a
 * reason plus concrete evidence. The engine NEVER reads source content at
 * query time - it answers from index data (paths, names, ranges, recorded
 * evidence) only.
 *
 * Semantic search: this step ships the bounded ARCHITECTURE for it - the
 * `file` search mode ranks by name/path/topic-token overlap, and a future
 * embedding model plugs into the same result shape. No vector database is
 * required or used here.
 */

import type {
  CodeSearchQuery,
  CodeSearchResult,
  CodeSearchType,
  CodebaseIndex,
  DetectedRoute,
  IndexedSymbol,
  SourcePath,
} from '../types/index.js';

export const DEFAULT_SEARCH_LIMIT = 50;

function caseInsensitiveContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function symbolResult(symbol: IndexedSymbol, reason: string, evidence: string[]): CodeSearchResult {
  return {
    kind: 'symbol',
    title: symbol.name,
    filePath: symbol.filePath,
    range: {
      startLine: symbol.startLine,
      startColumn: symbol.startColumn,
      endLine: symbol.endLine,
      endColumn: symbol.endColumn,
    },
    symbolId: symbol.symbolId,
    detail: `${symbol.kind}${symbol.scope !== '' ? ` in ${symbol.scope}` : ''}${symbol.exported ? ' (exported)' : ''}`,
    evidence: { reason, evidence: evidence.slice(0, 3) },
  };
}

function fileResult(path: SourcePath, reason: string, evidence: string[]): CodeSearchResult {
  return {
    kind: 'file',
    title: path,
    filePath: path,
    range: null,
    symbolId: null,
    detail: 'indexed file',
    evidence: { reason, evidence: evidence.slice(0, 3) },
  };
}

function routeResult(route: DetectedRoute, reason: string, evidence: string[]): CodeSearchResult {
  return {
    kind: 'route',
    title: `${route.method} ${route.path}`,
    filePath: route.filePath,
    range: route.range,
    symbolId: null,
    detail: `${route.framework}; handler: ${route.handlerSymbol ?? 'not statically resolvable'}`,
    evidence: { reason, evidence: evidence.slice(0, 3) },
  };
}

function matchesFilters(symbol: IndexedSymbol, query: CodeSearchQuery): boolean {
  if (query.symbolKind !== undefined && symbol.kind !== query.symbolKind) {
    return false;
  }
  if (
    query.filePattern !== undefined &&
    !caseInsensitiveContains(symbol.filePath, query.filePattern)
  ) {
    return false;
  }
  return true;
}

/** Ranks file paths for the topic-ish `file` search mode (bounded semantics). */
function scoreFilePath(path: SourcePath, tokens: readonly string[]): number {
  const lowered = path.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (lowered.includes(token.toLowerCase())) {
      score += token.length >= 4 ? 3 : 1;
      if (baseNameSegment(path).toLowerCase().startsWith(token.toLowerCase())) {
        score += 2;
      }
    }
  }
  return score;
}

function baseNameSegment(path: SourcePath): string {
  return path.split('/').pop() ?? path;
}

export function searchCodebase(index: CodebaseIndex, query: CodeSearchQuery): CodeSearchResult[] {
  const limit = Math.max(
    1,
    Math.min(query.maxResults ?? DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
  );
  const needle = query.query.trim();
  const results: CodeSearchResult[] = [];

  if (query.searchType === 'exact') {
    for (const symbol of index.symbols) {
      if (results.length >= limit) break;
      if (symbol.name === needle && matchesFilters(symbol, query)) {
        results.push(
          symbolResult(symbol, `exact symbol name match for "${needle}"`, [
            `${symbol.kind} declared at ${symbol.filePath}:${symbol.startLine}`,
          ]),
        );
      }
    }
    for (const file of index.files) {
      if (results.length >= limit) break;
      if (file.path === needle) {
        results.push(
          fileResult(file.path, 'exact file path match', [
            `file indexed as ${file.language ?? 'unknown'} (${file.parseStatus})`,
          ]),
        );
      }
    }
    return results;
  }

  if (query.searchType === 'symbol') {
    for (const symbol of index.symbols) {
      if (results.length >= limit) break;
      const nameMatch = caseInsensitiveContains(symbol.name, needle);
      const scopeMatch = needle.length >= 3 && caseInsensitiveContains(symbol.scope, needle);
      if ((nameMatch || scopeMatch) && matchesFilters(symbol, query)) {
        results.push(
          symbolResult(
            symbol,
            nameMatch ? `symbol name contains "${needle}"` : `symbol scope contains "${needle}"`,
            [`${symbol.kind} declared at ${symbol.filePath}:${symbol.startLine}`],
          ),
        );
      }
    }
    return results;
  }

  if (query.searchType === 'file') {
    const tokens = needle.split(/[\s/-]+/).filter((token) => token.length >= 2);
    const scored = index.files
      .map((file) => ({
        file,
        score:
          scoreFilePath(file.path, tokens) + (caseInsensitiveContains(file.path, needle) ? 5 : 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    for (const entry of scored) {
      results.push(
        fileResult(entry.file.path, `file path matches the search terms (score ${entry.score})`, [
          `language: ${entry.file.language ?? 'unknown'}`,
          `parse status: ${entry.file.parseStatus}`,
        ]),
      );
    }
    return results;
  }

  if (query.searchType === 'relationship') {
    // e.g. "what imports AuthService" / "AuthService"
    for (const relationship of index.relationships) {
      if (results.length >= limit) break;
      const evidenceMatch = caseInsensitiveContains(relationship.evidence, needle);
      if (!evidenceMatch) continue;
      const target =
        relationship.toSymbolId !== undefined
          ? index.symbols.find((symbol) => symbol.symbolId === relationship.toSymbolId)
          : undefined;
      results.push({
        kind: 'relationship',
        title: `${relationship.kind}: ${relationship.evidence}`,
        filePath: relationship.fromPath ?? target?.filePath ?? null,
        range: null,
        symbolId: relationship.toSymbolId ?? null,
        detail: relationship.evidence,
        evidence: {
          reason: `recorded ${relationship.kind} relationship mentioning "${needle}"`,
          evidence: [relationship.evidence],
        },
        ...(query.includeRelationships === true ? { relationships: [relationship] } : {}),
      });
    }
    return results;
  }

  // structural
  const kind = query.structuralKind ?? 'routes';
  if (kind === 'routes') {
    for (const route of index.routes.slice(0, limit)) {
      results.push(
        routeResult(route, 'structurally detected HTTP route', [
          `${route.method} ${route.path} registered at ${route.filePath}:${route.range.startLine}`,
        ]),
      );
    }
    return results;
  }
  if (kind === 'entry_points') {
    for (const entry of index.entryPoints.slice(0, limit)) {
      results.push({
        kind: 'entry_point',
        title: entry.filePath,
        filePath: entry.filePath,
        range: null,
        symbolId: null,
        detail: `confidence: ${entry.confidence}`,
        evidence: { reason: 'likely application entry point', evidence: entry.evidence },
      });
    }
    return results;
  }
  if (kind === 'components') {
    for (const component of index.components.slice(0, limit)) {
      results.push({
        kind: 'component',
        title: component.name,
        filePath: component.filePath,
        range: component.range,
        symbolId: component.symbolId,
        detail: 'detected UI component',
        evidence: {
          reason: 'structurally detected UI component (PascalCase + JSX)',
          evidence: [
            `${component.name} defined at ${component.filePath}:${component.range.startLine}`,
          ],
        },
      });
    }
    return results;
  }
  // exports
  for (const relationship of index.relationships) {
    if (results.length >= limit) break;
    if (relationship.kind !== 'exports') continue;
    const symbol =
      relationship.toSymbolId !== undefined
        ? index.symbols.find((candidate) => candidate.symbolId === relationship.toSymbolId)
        : undefined;
    if (symbol !== undefined && matchesFilters(symbol, query)) {
      results.push(
        symbolResult(symbol, 'exported symbol', [
          `exported from ${relationship.fromPath ?? symbol.filePath}`,
        ]),
      );
    }
  }
  return results;
}

export type { CodeSearchType };
