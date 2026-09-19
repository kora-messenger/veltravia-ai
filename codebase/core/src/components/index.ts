/**
 * Component extraction view (Phase 14).
 *
 * Components are detected during parsing (PascalCase + JSX / React.Component
 * subclass). This module only projects the SAFE view over indexed symbols;
 * it never invents semantics - "likely rendered children" come from the
 * bounded `renders` relationships recorded by the parser, nothing more.
 */

import type { DetectedComponent, IndexedSymbol } from '../types/index.js';

export function detectComponentsFromSymbols(
  symbols: readonly IndexedSymbol[],
): DetectedComponent[] {
  return symbols
    .filter((symbol) => symbol.kind === 'component')
    .map((symbol) => ({
      symbolId: symbol.symbolId,
      name: symbol.name,
      filePath: symbol.filePath,
      range: {
        startLine: symbol.startLine,
        startColumn: symbol.startColumn,
        endLine: symbol.endLine,
        endColumn: symbol.endColumn,
      },
    }));
}
