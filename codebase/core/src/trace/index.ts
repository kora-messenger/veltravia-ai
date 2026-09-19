/**
 * Feature trace engine (Phase 17).
 *
 * Given a feature description ("authentication"), the engine builds a
 * BOUNDED feature map: seed files/symbols by name overlap, then expand
 * strictly along RECORDED index relationships (imports, calls, extends,
 * routes_to, renders) up to hard depth and node ceilings. Every node states
 * why it is in the map; every edge carries evidence. Anything the index
 * cannot support is noted honestly - the engine never invents a chain like
 * controller -> service -> model unless relationships actually exist.
 */

import type {
  CodebaseIndex,
  FeatureTraceEdge,
  FeatureTraceNode,
  FeatureTraceQuery,
  FeatureTraceResult,
  RelationshipKind,
  SourcePath,
  SymbolRelationship,
} from '../types/index.js';

const EXPAND_KINDS: ReadonlySet<RelationshipKind> = new Set([
  'imports',
  'calls',
  'extends',
  'implements',
  'routes_to',
  'renders',
  'contains',
  'references',
]);

function nodeKeyForSymbol(symbolId: string): string {
  return `symbol:${symbolId}`;
}

function nodeKeyForFile(path: SourcePath): string {
  return `file:${path}`;
}

/**
 * Splits a path or identifier into lowercase word segments
 * ('src/services/auth.ts' -> ['src','services','auth','ts'];
 * 'AuthService' -> ['auth','service']).
 */
function wordSegments(value: string): string[] {
  const split = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3);
  return [...new Set(split)];
}

/**
 * Seeds: files/symbols whose word segments overlap the feature terms in
 * EITHER direction ('auth' is a segment of 'authentication', so a query
 * for 'authentication' seeds auth.ts and AuthService). Bounded and
 * evidence-based in both directions.
 */
function seedNodes(index: CodebaseIndex, tokens: readonly string[]): FeatureTraceNode[] {
  const seeds: FeatureTraceNode[] = [];
  const lowered = tokens.map((token) => token.toLowerCase());

  const matches = (value: string): boolean => {
    const loweredValue = value.toLowerCase();
    if (lowered.some((token) => loweredValue.includes(token) && token.length >= 3)) {
      return true;
    }
    // Inverse: one of the value's segments is contained in a query token
    // ('auth' ⊂ 'authentication').
    const segments = wordSegments(value);
    return segments.some((segment) => lowered.some((token) => token.includes(segment)));
  };

  for (const file of index.files) {
    if (matches(file.path)) {
      seeds.push({
        key: nodeKeyForFile(file.path),
        label: file.path,
        kind: 'file',
        filePath: file.path,
        range: null,
        symbolId: null,
        reason: 'file path mentions the feature terms',
      });
    }
  }
  for (const symbol of index.symbols) {
    if (matches(symbol.name) || matches(symbol.scope)) {
      seeds.push({
        key: nodeKeyForSymbol(symbol.symbolId),
        label: symbol.name,
        kind: 'symbol',
        filePath: symbol.filePath,
        range: {
          startLine: symbol.startLine,
          startColumn: symbol.startColumn,
          endLine: symbol.endLine,
          endColumn: symbol.endColumn,
        },
        symbolId: symbol.symbolId,
        reason: `symbol name or scope mentions the feature terms (${symbol.kind})`,
      });
    }
  }
  return seeds;
}

function relationshipsFrom(index: CodebaseIndex, key: string): SymbolRelationship[] {
  const edges: SymbolRelationship[] = [];
  const symbolId = key.startsWith('symbol:') ? key.slice('symbol:'.length) : null;
  const filePath = key.startsWith('file:') ? key.slice('file:'.length) : null;
  for (const relationship of index.relationships) {
    if (symbolId !== null && relationship.fromSymbolId === symbolId) {
      edges.push(relationship);
    } else if (filePath !== null && relationship.fromPath === filePath) {
      edges.push(relationship);
    }
  }
  return edges;
}

function nodeForEdge(
  index: CodebaseIndex,
  relationship: SymbolRelationship,
): FeatureTraceNode | null {
  if (relationship.toSymbolId !== undefined) {
    const symbol = index.symbols.find(
      (candidate) => candidate.symbolId === relationship.toSymbolId,
    );
    if (symbol === undefined) return null;
    return {
      key: nodeKeyForSymbol(symbol.symbolId),
      label: symbol.name,
      kind: 'symbol',
      filePath: symbol.filePath,
      range: {
        startLine: symbol.startLine,
        startColumn: symbol.startColumn,
        endLine: symbol.endLine,
        endColumn: symbol.endColumn,
      },
      symbolId: symbol.symbolId,
      reason: `reachable via recorded ${relationship.kind} relationship`,
    };
  }
  if (relationship.toPath !== undefined) {
    const file = index.files.find((candidate) => candidate.path === relationship.toPath);
    if (file === undefined) return null;
    return {
      key: nodeKeyForFile(file.path),
      label: file.path,
      kind: 'file',
      filePath: file.path,
      range: null,
      symbolId: null,
      reason: `reachable via recorded ${relationship.kind} relationship`,
    };
  }
  return null;
}

export function traceFeature(index: CodebaseIndex, query: FeatureTraceQuery): FeatureTraceResult {
  const maxDepth = Math.min(query.maxDepth ?? 3, index.symbolCount > 0 ? 6 : 6);
  const maxNodes = Math.min(120, 120);
  const tokens = query.feature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);

  const nodes = new Map<string, FeatureTraceNode>();
  const edges: FeatureTraceEdge[] = [];
  const notes: string[] = [];

  const seedNodesList = seedNodes(index, tokens).slice(0, maxNodes);
  for (const seed of seedNodesList) {
    nodes.set(seed.key, seed);
  }

  if (seedNodesList.length === 0) {
    notes.push(
      'No file paths or symbol names matched the feature terms - the index has no evidence for this feature.',
    );
    return { feature: query.feature, nodes: [], edges: [], truncated: false, notes };
  }

  let frontier = seedNodesList.map((seed) => seed.key);
  const visited = new Set<string>(frontier);
  let truncated = false;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      if (nodes.size >= maxNodes) {
        truncated = true;
        break;
      }
      const relationships = relationshipsFrom(index, key).filter((edge) =>
        EXPAND_KINDS.has(edge.kind),
      );
      for (const relationship of relationships.slice(0, 40)) {
        const target = nodeForEdge(index, relationship);
        if (target === null) continue;
        const fromNode = nodes.get(key);
        if (fromNode !== undefined) {
          edges.push({
            fromKey: key,
            toKey: target.key,
            relationship: relationship.kind,
            evidence: relationship.evidence,
          });
        }
        if (!visited.has(target.key)) {
          visited.add(target.key);
          nodes.set(target.key, target);
          next.push(target.key);
          if (nodes.size >= maxNodes) {
            truncated = true;
            break;
          }
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  if (truncated) {
    notes.push(`Trace stopped early at the ${maxNodes}-node ceiling; results are partial.`);
  }
  notes.push(
    'Only relationships recorded in the index appear here; unsupported chains are not invented.',
  );

  return {
    feature: query.feature,
    nodes: [...nodes.values()],
    edges,
    truncated,
    notes,
  };
}
