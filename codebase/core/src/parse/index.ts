/**
 * TypeScript/JavaScript source parsing (Phases 7, 8, 13, 14).
 *
 * A REAL AST parse via the TypeScript compiler API (`ts.createSourceFile`)
 * - never a regex-only parser. The parser is read-only, bounded by a hard
 * AST node budget per file, and error-tolerant: a file that cannot be
 * parsed is recorded as `failed` with a scrubbed note and indexing
 * continues; it never crashes the project index.
 *
 * Untrusted data boundary: source content is PROJECT DATA. Nothing the
 * parser collects (names, evidence, notes) is ever treated as an
 * instruction, and evidence strings are scrubbed through `scrubEvidence`.
 */

import { createHash } from 'node:crypto';
import ts from 'typescript';

import { CodebaseError, scrubCodebaseText } from '../errors/index.js';
import {
  type DetectedRoute,
  type FileParseStatus,
  type IndexedSymbol,
  type SourcePath,
  type SourceRange,
} from '../types/index.js';
import { scrubEvidence } from '../secrets/index.js';

/** Hard cap on AST nodes walked per file - bounded parsing, always. */
export const MAX_AST_NODES_PER_FILE = 40_000;

/** Maximum characters of evidence retained per raw edge. */
const MAX_EDGE_EVIDENCE = 240;

export interface RawImport {
  readonly specifier: string;
  readonly range: SourceRange;
  /** Named imports actually referenced (for cross-file symbol resolution). */
  readonly names: readonly string[];
}

export interface RawEdge {
  readonly kind:
    'imports' | 'calls' | 'extends' | 'implements' | 'contains' | 'renders' | 'routes_to';
  readonly fromName: string | null;
  /** Enclosing class scope for method edges (e.g. 'AuthService'). */
  readonly fromScope?: string;
  readonly toName: string | null;
  readonly evidence: string;
}

/** Intermediate parse product for one file - raw, pre-resolution. */
export interface ParsedFile {
  readonly path: SourcePath;
  readonly parseStatus: FileParseStatus;
  readonly parseNote?: string;
  readonly symbols: readonly IndexedSymbol[];
  readonly rawImports: readonly RawImport[];
  /** Exported symbol NAMES in this file (for cross-file import resolution). */
  readonly exportedNames: readonly string[];
  readonly rawEdges: readonly RawEdge[];
  readonly routes: readonly DetectedRoute[];
}

function sha16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function rangeOf(node: ts.Node, sf: ts.SourceFile): SourceRange {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
}

function isExported(node: ts.Node): boolean {
  if (ts.canHaveModifiers(node)) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true) {
      return true;
    }
  }
  return ts.isExportAssignment(node) || node.parent.kind === ts.SyntaxKind.ExportDeclaration;
}

function nameOf(node: ts.Node): string | null {
  const name = (node as { name?: ts.Node }).name;
  if (name === undefined) {
    return null;
  }
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const ROUTE_OBJECT_HINTS = new Set([
  'app',
  'server',
  'fastify',
  'router',
  'route',
  'api',
  'apiRouter',
]);

function isRouteCall(call: ts.CallExpression): { method: string } | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr) || !ROUTE_METHODS.has(expr.name.text)) {
    return null;
  }
  const receiver = expr.expression;
  // Heuristic: `app.get('/x', ...)` / `router.post('/x', ...)` style. The
  // receiver name is only a HINT - the first string-literal path starting
  // with '/' is the strong signal.
  const receiverName = ts.isIdentifier(receiver) ? receiver.text : '';
  if (receiverName !== '' && !ROUTE_OBJECT_HINTS.has(receiverName)) {
    return null;
  }
  const first = call.arguments[0];
  if (first === undefined || !ts.isStringLiteral(first) || !first.text.startsWith('/')) {
    return null;
  }
  return { method: expr.name.text.toUpperCase() };
}

function handlerNameOf(call: ts.CallExpression): string | null {
  const second = call.arguments[1];
  if (second !== undefined && ts.isIdentifier(second)) {
    return second.text;
  }
  return null;
}

/** True when a function body (or arrow body) contains JSX. */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

/** Component heuristics: PascalCase name + JSX (or React.Component subclass). */
function looksLikeComponent(name: string, hasJsx: boolean, extendsReact: boolean): boolean {
  const pascal = /^[A-Z][A-Za-z0-9]*$/.test(name);
  return pascal && (hasJsx || extendsReact);
}

function reactComponentSuper(heritage: readonly ts.HeritageClause[] | undefined): boolean {
  if (heritage === undefined) {
    return false;
  }
  return heritage.some(
    (clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      clause.types.some((t) => {
        const expr = t.expression;
        return (
          ts.isPropertyAccessExpression(expr) &&
          expr.expression.getText() === 'React' &&
          (expr.name.text === 'Component' || expr.name.text === 'PureComponent')
        );
      }),
  );
}

export interface ParseFileOptions {
  readonly path: SourcePath;
  readonly content: string;
}

/**
 * Parses one TypeScript/JavaScript source file into raw index data.
 * NEVER throws for malformed source: returns `failed` with a scrubbed note.
 */
export function parseSourceFile(options: ParseFileOptions): ParsedFile {
  const { path, content } = options;
  const scriptKind =
    path.endsWith('.ts') || path.endsWith('.mts')
      ? ts.ScriptKind.TS
      : path.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : path.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : ts.ScriptKind.JS;

  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse failure';
    return {
      path,
      parseStatus: 'failed',
      parseNote: scrubCodebaseText(message, 160),
      symbols: [],
      rawImports: [],
      exportedNames: [],
      rawEdges: [],
      routes: [],
    };
  }

  const symbols: IndexedSymbol[] = [];
  const exportedNames: string[] = [];
  const rawImports: RawImport[] = [];
  const rawEdges: RawEdge[] = [];
  const routes: DetectedRoute[] = [];

  let nodeBudget = MAX_AST_NODES_PER_FILE;
  let budgetExhausted = false;

  const spend = (): boolean => {
    if (nodeBudget <= 0) {
      budgetExhausted = true;
      return false;
    }
    nodeBudget -= 1;
    return true;
  };

  const addSymbol = (
    node: ts.Node,
    rawName: string,
    kind: IndexedSymbol['kind'],
    scope: string,
    exportedOverride?: boolean,
  ): void => {
    if (symbols.length >= 400) {
      return; // per-file symbol cap; extra symbols are counted, not stored
    }
    const range = rangeOf(node, source);
    const exported = exportedOverride ?? isExported(node);
    symbols.push({
      symbolId: sha16(`${path}|${scope}|${rawName}|${kind}|${range.startLine}`),
      name: rawName,
      kind,
      filePath: path,
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
      scope,
      exported,
      ...(kind === 'route' ? { meta: { note: 'statically detected route registration' } } : {}),
    });
    if (exported && rawName.length > 0) {
      exportedNames.push(rawName);
    }
  };

  const edge = (
    kind: RawEdge['kind'],
    fromName: string | null,
    toName: string | null,
    evidence: string,
    fromScope?: string,
  ): void => {
    if (rawEdges.length >= 5_000 || toName === null) {
      return;
    }
    rawEdges.push({
      kind,
      fromName,
      ...(fromScope !== undefined ? { fromScope } : {}),
      toName,
      evidence: scrubEvidence(evidence, MAX_EDGE_EVIDENCE),
    });
  };

  const pushRawCall = (from: string | null, scope: string | undefined, callee: string): void => {
    rawEdges.push({
      kind: 'calls',
      fromName: from,
      ...(scope !== undefined ? { fromScope: scope } : {}),
      toName: callee,
      evidence: scrubEvidence(`${from ?? 'module'} calls ${callee}()`, MAX_EDGE_EVIDENCE),
    });
  };

  const collectCalls = (
    containerName: string | null,
    body: ts.Node,
    containerScope?: string,
  ): void => {
    const visit = (node: ts.Node): void => {
      if (!spend()) return;
      if (ts.isCallExpression(node)) {
        const route = isRouteCall(node);
        if (route !== null) {
          const first = node.arguments[0];
          if (first !== undefined && ts.isStringLiteral(first)) {
            const handler = handlerNameOf(node);
            const range = rangeOf(node, source);
            routes.push({
              method: route.method as DetectedRoute['method'],
              path: first.text,
              filePath: path,
              range,
              framework: 'fastify/express-style registration',
              handlerSymbol: handler,
            });
            if (handler !== null) {
              edge('routes_to', containerName, handler, `registers handler ${handler}`);
            }
          }
          return;
        }
        if (ts.isIdentifier(node.expression)) {
          pushRawCall(containerName, containerScope, node.expression.text);
        }
        node.forEachChild(visit);
        return;
      }
      node.forEachChild(visit);
    };
    visit(body);
  };

  const collectRenders = (componentName: string, body: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (!spend()) return;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
          edge('renders', componentName, tag.text, `renders <${tag.text}>`);
        }
      }
      node.forEachChild(visit);
    };
    visit(body);
  };

  const visitTopLevel = (node: ts.Node): void => {
    if (!spend()) {
      return;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const range = rangeOf(node, source);
      const names: string[] = [];
      const clause = node.importClause;
      if (clause !== undefined && clause.namedBindings !== undefined) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const specifier of clause.namedBindings.elements) {
            const imported = specifier.propertyName ?? specifier.name;
            if (ts.isIdentifier(imported)) {
              names.push(imported.text);
            }
          }
        }
        // Namespace imports (`import * as X`) carry no named symbols.
      }
      rawImports.push({ specifier: node.moduleSpecifier.text, range, names });
      node.forEachChild(visitTopLevel);
      return;
    }

    if (ts.isFunctionDeclaration(node)) {
      const name = nameOf(node);
      if (name !== null && name.length > 0) {
        const hasJsx = node.body !== undefined ? containsJsx(node.body) : false;
        const isComponent = looksLikeComponent(name, hasJsx, false);
        addSymbol(node, name, isComponent ? 'component' : 'function', '');
        if (node.body !== undefined) {
          collectCalls(name, node.body);
          if (isComponent) {
            collectRenders(name, node.body);
          }
        }
      }
      return;
    }

    if (ts.isClassDeclaration(node)) {
      const name = nameOf(node);
      if (name !== null && name.length > 0) {
        const extendsReact = reactComponentSuper(node.heritageClauses);
        const isComponent = looksLikeComponent(name, false, extendsReact);
        addSymbol(node, name, isComponent ? 'component' : 'class', '');
        for (const clause of node.heritageClauses ?? []) {
          const keyword =
            clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
          for (const type of clause.types) {
            const typeName = type.expression.getText(source);
            edge(keyword as RawEdge['kind'], name, typeName, `${name} ${keyword} ${typeName}`);
          }
        }
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member)) {
            const methodName = nameOf(member);
            if (methodName !== null && methodName !== undefined) {
              addSymbol(member, methodName, 'method', name);
              edge('contains', name, methodName, `${name} declares method ${methodName}`);
              if (member.body !== undefined) {
                collectCalls(methodName, member.body, name);
                if (isComponent) {
                  collectRenders(name, member.body);
                }
              }
            }
          }
        }
      }
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const name = nameOf(node);
      if (name !== null) {
        addSymbol(node, name, 'interface', '');
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            const typeName = type.expression.getText(source);
            edge('extends', name, typeName, `${name} extends ${typeName}`);
          }
        }
      }
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const name = nameOf(node);
      if (name !== null) {
        addSymbol(node, name, 'type', '');
      }
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      const name = nameOf(node);
      if (name !== null) {
        addSymbol(node, name, 'enum', '');
      }
      return;
    }

    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      addSymbol(node, node.name.text, 'namespace', '');
      return;
    }

    if (ts.isVariableStatement(node)) {
      const statementExported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        const name = nameOf(declaration);
        if (name === null || name.length === 0 || !ts.isIdentifier(declaration.name)) {
          continue;
        }
        const initializer = declaration.initializer;
        const isConst = node.declarationList.flags & ts.NodeFlags.Const ? true : false;
        let kind: IndexedSymbol['kind'] = isConst ? 'constant' : 'variable';
        if (
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          const hasJsx = containsJsx(initializer);
          if (looksLikeComponent(name, hasJsx, false)) {
            kind = 'component';
            collectRenders(name, initializer);
            collectCalls(name, initializer);
          } else {
            kind = 'function';
            collectCalls(name, initializer);
          }
        } else if (initializer !== undefined) {
          collectCalls(name, initializer);
        }
        addSymbol(declaration, name, kind, '', statementExported);
      }
      return;
    }

    if (ts.isCallExpression(node)) {
      // Top-level route registrations (`app.get('/x', handler)` at module
      // scope) and module-level calls.
      const route = isRouteCall(node);
      if (route !== null) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteral(first)) {
          const handler = handlerNameOf(node);
          routes.push({
            method: route.method as DetectedRoute['method'],
            path: first.text,
            filePath: path,
            range: rangeOf(node, source),
            framework: 'fastify/express-style registration',
            handlerSymbol: handler,
          });
          if (handler !== null) {
            edge('routes_to', null, handler, `registers handler ${handler}`);
          }
        }
      } else if (ts.isIdentifier(node.expression)) {
        edge('calls', null, node.expression.text, `module-level call ${node.expression.text}()`);
      }
      return;
    }

    node.forEachChild(visitTopLevel);
  };

  try {
    source.forEachChild(visitTopLevel);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'walker failure';
    return {
      path,
      parseStatus: 'failed',
      parseNote: scrubCodebaseText(message, 160),
      symbols,
      rawImports,
      exportedNames,
      rawEdges,
      routes,
    };
  }

  if (budgetExhausted) {
    return {
      path,
      parseStatus: 'failed',
      parseNote: `ast node budget (${MAX_AST_NODES_PER_FILE}) exhausted; partial results kept`,
      symbols,
      rawImports,
      exportedNames,
      rawEdges,
      routes,
    };
  }

  // `parseDiagnostics` is a runtime property of SourceFile not exposed in
  // the public types; read it defensively so malformed source is reported
  // honestly as `failed` (TS parsing itself never throws for bad code).
  const internal = source as {
    parseDiagnostics?: readonly { messageText: string | ts.DiagnosticMessageChain }[];
  };
  const diagnostics = internal.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const note =
      first !== undefined
        ? scrubCodebaseText(ts.flattenDiagnosticMessageText(first.messageText, ' '), 160)
        : 'source reported parse diagnostics';
    return {
      path,
      parseStatus: 'failed',
      parseNote: note,
      symbols,
      rawImports,
      exportedNames,
      rawEdges,
      routes,
    };
  }

  return {
    path,
    parseStatus: 'parsed',
    symbols,
    rawImports,
    exportedNames,
    rawEdges,
    routes,
  };
}

/** Parses JSON content - structural validity only, no symbols extracted. */
export function parseJsonFile(path: SourcePath, content: string): ParsedFile {
  try {
    JSON.parse(content);
    return emptyParsed(path, 'parsed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    return {
      ...emptyParsed(path, 'failed'),
      parseNote: scrubCodebaseText(message, 160),
    };
  }
}

function emptyParsed(
  path: SourcePath,
  parseStatus: FileParseStatus,
  parseNote?: string,
): ParsedFile {
  return {
    path,
    parseStatus,
    ...(parseNote !== undefined ? { parseNote } : {}),
    symbols: [],
    rawImports: [],
    exportedNames: [],
    rawEdges: [],
    routes: [],
  };
}

export type { CodebaseError };
