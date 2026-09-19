/**
 * Import/export resolution and symbol relationship building (Phases 9-11).
 *
 * Takes the raw per-file parse products and resolves them against the KNOWN
 * file set of the index build. Resolution is deliberately conservative:
 * a relationship between files/symbols is only recorded when the target
 * resolves confidently (an indexed file for internal edges, a plausible
 * package name for external edges). Unresolved relative imports stay as
 * honest file-level edges with their raw specifier; they are NEVER
 * promoted to symbol relationships.
 *
 * External package dependencies (react, fastify, zod) are kept strictly
 * separate from internal source relationships - they never masquerade as
 * file edges.
 */

import type {
  DependencyEdge,
  IndexedSymbol,
  SourcePath,
  SymbolRelationship,
} from '../types/index.js';
import { directoryOf } from '../languages/index.js';
import { scrubEvidence } from '../secrets/index.js';
import type { ParsedFile } from '../parse/index.js';

const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

/** True for relative specifiers ('./', '../'). */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** True for bare package specifiers ('react', '@scope/pkg/sub', 'pkg/paths'). */
function isBare(specifier: string): boolean {
  return specifier.length > 0 && !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** Package name of a bare specifier ('@scope/pkg/sub' -> '@scope/pkg'). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? specifier;
}

/** Resolves a relative specifier to an indexed file path, or null. */
export function resolveRelativeImport(
  fromPath: SourcePath,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): SourcePath | null {
  const fromDir = directoryOf(fromPath);
  const resolved: string[] = fromDir === '' ? [] : fromDir.split('/');
  const spec = specifier.startsWith('./') ? specifier.slice(2) : specifier;
  for (const segment of spec.split('/')) {
    if (segment === '..') {
      if (resolved.length > 0) {
        resolved.pop();
      } else {
        return null; // would escape the workspace root
      }
    } else if (segment !== '.' && segment !== '') {
      resolved.push(segment);
    }
  }
  const joined = resolved.join('/');
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${joined}${suffix}`;
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface BuildRelationshipsOptions {
  readonly parsedFiles: readonly ParsedFile[];
  /** Symbol lookup: file path -> exported symbol names -> symbol. */
  readonly limits: { readonly maxRelationshipsTotal: number };
}

export interface RelationshipBuildResult {
  readonly relationships: SymbolRelationship[];
  readonly dependencies: DependencyEdge[];
  /** Internal file -> file edges (resolved), with the specifier that made them. */
  readonly internalEdges: readonly {
    readonly fromPath: SourcePath;
    readonly toPath: SourcePath;
    readonly specifier: string;
  }[];
  /** Importer files per symbol id (for references/callers queries). */
  readonly referencedBy: ReadonlyMap<string, readonly SourcePath[]>;
}

/**
 * Resolves imports and builds the relationship set. Bounded by the total
 * relationship cap - once reached, further edges are dropped and the
 * build records truncation via the caller.
 */
export function buildRelationships(options: BuildRelationshipsOptions): RelationshipBuildResult {
  const { parsedFiles } = options;

  const knownFiles = new Set<string>(parsedFiles.map((file) => file.path));
  // Per-file symbol lookup keyed by bare name AND scope-qualified name, so
  // method edges disambiguate from same-file bare functions.
  const symbolIndex = new Map<string, Map<string, IndexedSymbol>>();
  for (const file of parsedFiles) {
    const byName = new Map<string, IndexedSymbol>();
    for (const symbol of file.symbols) {
      if (!byName.has(symbol.name)) {
        byName.set(symbol.name, symbol);
      }
      const qualified = symbol.scope === '' ? symbol.name : `${symbol.scope}.${symbol.name}`;
      if (!byName.has(qualified)) {
        byName.set(qualified, symbol);
      }
    }
    symbolIndex.set(file.path, byName);
  }

  // Per-file EXPORTED symbol index (name -> first exported symbol), so an
  // imported name resolves to the exported symbol even when a same-named
  // non-exported symbol comes first in the file.
  const exportIndex = new Map<string, Map<string, IndexedSymbol>>();
  for (const file of parsedFiles) {
    const exported = new Map<string, IndexedSymbol>();
    for (const symbol of file.symbols) {
      if (symbol.exported && !exported.has(symbol.name)) {
        exported.set(symbol.name, symbol);
      }
    }
    exportIndex.set(file.path, exported);
  }

  // Pass 1: resolve relative import specifiers to indexed files and map
  // each imported NAME to its target file.
  const importsByFile = new Map<string, Map<string, string>>();
  for (const file of parsedFiles) {
    const nameToTarget = new Map<string, string>();
    for (const rawImport of file.rawImports) {
      if (!isRelative(rawImport.specifier)) continue;
      const target = resolveRelativeImport(file.path, rawImport.specifier, knownFiles);
      if (target === null) continue;
      for (const name of rawImport.names) {
        if (!nameToTarget.has(name)) {
          nameToTarget.set(name, target);
        }
      }
    }
    importsByFile.set(file.path, nameToTarget);
  }

  const relationships: SymbolRelationship[] = [];
  const dependencies: DependencyEdge[] = [];
  const internalEdges: { fromPath: SourcePath; toPath: SourcePath; specifier: string }[] = [];
  const referencedBy = new Map<string, SourcePath[]>();

  let budget = options.limits.maxRelationshipsTotal;
  const push = (relationship: SymbolRelationship): boolean => {
    if (budget <= 0) {
      return false;
    }
    budget -= 1;
    relationships.push(relationship);
    return true;
  };

  for (const file of parsedFiles) {
    const localSymbols = symbolIndex.get(file.path) ?? new Map<string, IndexedSymbol>();

    // File DEFINES its symbols (structural backbone of the graph).
    for (const symbol of file.symbols) {
      if (
        !push({
          kind: 'defines',
          fromPath: file.path,
          toSymbolId: symbol.symbolId,
          evidence: `file declares ${symbol.kind} ${symbol.name}`,
        })
      ) {
        break;
      }
      // Exported symbols: file -exports-> symbol.
      if (symbol.exported) {
        if (
          !push({
            kind: 'exports',
            fromPath: file.path,
            toSymbolId: symbol.symbolId,
            evidence: `file exports ${symbol.kind} ${symbol.name}`,
          })
        ) {
          break;
        }
      }
    }

    // Import declarations -> file/file and file/symbol edges.
    for (const rawImport of file.rawImports) {
      const specifier = rawImport.specifier;
      if (isRelative(specifier)) {
        const target = resolveRelativeImport(file.path, specifier, knownFiles);
        if (target !== null) {
          internalEdges.push({ fromPath: file.path, toPath: target, specifier });
          dependencies.push({
            fromPath: file.path,
            toPath: target,
            specifier,
            external: false,
            package: null,
          });
          push({
            kind: 'imports',
            fromPath: file.path,
            toPath: target,
            evidence: `imports module '${specifier}'`,
          });
          // Symbol-level reference edges - ONLY for the names the import
          // clause actually names (never every export of the target).
          const namedImports = file.rawImports
            .filter(
              (rawImport) =>
                resolveRelativeImport(file.path, rawImport.specifier, knownFiles) === target,
            )
            .flatMap((rawImport) => [...rawImport.names]);
          const targetExported = exportIndex.get(target);
          if (targetExported !== undefined) {
            for (const name of namedImports) {
              const symbol = targetExported.get(name);
              if (symbol === undefined) continue;
              push({
                kind: 'references',
                fromPath: file.path,
                toSymbolId: symbol.symbolId,
                evidence: `imports ${symbol.kind} ${name} from '${specifier}'`,
              });
              const list = referencedBy.get(symbol.symbolId);
              if (list !== undefined) {
                if (!list.includes(file.path)) {
                  list.push(file.path);
                }
              } else {
                referencedBy.set(symbol.symbolId, [file.path]);
              }
            }
          }
        } else {
          // Honest unresolved relative import: file-level edge with the raw
          // specifier kept as evidence, never a symbol relationship.
          dependencies.push({
            fromPath: file.path,
            toPath: specifier,
            specifier,
            external: false,
            package: null,
          });
        }
      } else if (isBare(specifier)) {
        dependencies.push({
          fromPath: file.path,
          toPath: specifier,
          specifier,
          external: true,
          package: packageNameOf(specifier),
        });
      }
      // Absolute specifiers are neither internal nor packages: dropped,
      // honestly (nothing confident to claim about them).
    }

    // Intra-file and imported raw edges -> symbol relationships where the
    // ends resolve (locally, or via the file's own imports to another file).
    const importTargets = importsByFile.get(file.path) ?? new Map<string, string>();
    const crossFileLookup = (name: string): IndexedSymbol | undefined => {
      const target = importTargets.get(name);
      if (target === undefined) return undefined;
      // Only confidently resolve EXPORTED targets.
      return exportIndex.get(target)?.get(name);
    };

    for (const raw of file.rawEdges) {
      if (raw.kind === 'imports') continue;
      const fromKey =
        raw.fromName !== null
          ? raw.fromScope !== undefined
            ? `${raw.fromScope}.${raw.fromName}`
            : raw.fromName
          : null;
      const fromSymbol =
        fromKey !== null
          ? (localSymbols.get(fromKey) ?? localSymbols.get(raw.fromName ?? ''))
          : undefined;
      if (raw.fromName !== null && fromSymbol === undefined) {
        // The FROM side must resolve to a known symbol for a symbol edge;
        // otherwise the edge is kept as a file-level hint only for the
        // kinds where the file itself meaningfully owns the edge.
        if (raw.kind === 'calls' || raw.kind === 'renders') {
          push({ kind: raw.kind, fromPath: file.path, evidence: raw.evidence });
        }
        continue;
      }
      const fromRef =
        fromSymbol !== undefined ? { fromSymbolId: fromSymbol.symbolId } : { fromPath: file.path };
      const toSymbol =
        raw.toName !== null
          ? (localSymbols.get(raw.toName) ??
            (raw.kind === 'calls' || raw.kind === 'renders'
              ? crossFileLookup(raw.toName)
              : undefined))
          : undefined;
      if (toSymbol !== undefined) {
        push({
          kind: raw.kind,
          ...fromRef,
          toSymbolId: toSymbol.symbolId,
          evidence: raw.evidence,
        });
      } else {
        // TO side unresolved: the edge is still REAL (e.g. calls a library
        // function) - record it file-level with the name in evidence.
        push({
          kind: raw.kind,
          ...fromRef,
          evidence: `${raw.evidence} (target not statically resolvable in this file)`,
        });
      }
    }

    // Route registrations -> route symbol edges to handler symbols.
    for (const route of file.routes) {
      const handler =
        route.handlerSymbol !== null ? localSymbols.get(route.handlerSymbol) : undefined;
      if (handler !== undefined) {
        push({
          kind: 'routes_to',
          fromPath: file.path,
          toSymbolId: handler.symbolId,
          evidence: `${route.method} ${route.path} routes to handler ${handler.name}`,
        });
      }
    }
  }

  // referencedBy paths are frozen copies.
  const frozenReferencedBy = new Map<string, readonly SourcePath[]>();
  for (const [key, paths] of referencedBy) {
    frozenReferencedBy.set(key, [...paths]);
  }

  return { relationships, dependencies, internalEdges, referencedBy: frozenReferencedBy };
}

export { isBare, isRelative, packageNameOf, scrubEvidence };
