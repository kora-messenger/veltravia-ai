/** XLSX (SpreadsheetML) parser: sheet names, headers, bounded rows and
 *  numeric column statistics. Formula cells are RECORDED as text with cached
 *  values only - never evaluated. No macros are read; vbaProject parts are
 *  ignored entirely. */
import type {
  DocumentMetadataEntry,
  SpreadsheetColumnStats,
  SpreadsheetSheetView,
} from '../types/index.js';
import { DocumentIntelligenceError } from '../errors/index.js';
import { partToText } from './shared.js';
import { childrenOf, findAll, findFirst, parseXml, textOf, type XmlNode } from './ooxml-helpers.js';

export interface XlsxParseLimits {
  readonly maxSheetRows: number;
  readonly maxElements: number;
}

export interface XlsxParseResult {
  readonly sheets: readonly SpreadsheetSheetView[];
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly truncated: boolean;
}

const COLUMN_RE = /^([A-Z]+)(\d+)$/;

export function parseXlsx(
  parts: ReadonlyMap<string, Uint8Array>,
  limits: XlsxParseLimits,
): XlsxParseResult {
  const workbookBytes = parts.get('xl/workbook.xml');
  if (!workbookBytes)
    throw new DocumentIntelligenceError('DOCUMENT_UNSUPPORTED_FORMAT', 'xl/workbook.xml missing.');
  const workbook = parseXml(partToText(workbookBytes));
  const relBytes = parts.get('xl/_rels/workbook.xml.rels');
  const rels = relBytes ? sheetRelMap(partToText(relBytes)) : new Map<string, string>();

  const coreBytes = parts.get('docProps/core.xml');
  const metadata = coreBytes ? parseCore(partToText(coreBytes)) : [];

  const sheets: SpreadsheetSheetView[] = [];
  let truncated = false;

  for (const sheetEl of findAll(workbook, 'sheet').slice(0, 20)) {
    if (sheets.length >= limits.maxElements) break;
    const name = sheetEl.attrs['name'] ?? `Sheet${sheets.length + 1}`;
    const relId = sheetEl.attrs['r:id'] ?? '';
    const target = rels.get(relId);
    const partName = target ? normalizeTarget(target) : null;
    const partBytes = partName ? parts.get(partName) : undefined;
    if (!partBytes) continue;
    const sheet = parseSheet(name, partToText(partBytes), limits);
    sheets.push(sheet);
    if (sheet.rowCount >= limits.maxSheetRows) truncated = true;
  }
  return { sheets, metadata, truncated };
}

function normalizeTarget(target: string): string {
  const clean = target.replace(/^\.\//, '');
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

function parseSheet(name: string, xml: string, limits: XlsxParseLimits): SpreadsheetSheetView {
  const root = parseXml(xml);
  const rowsRaw = findAll(root, 'row').slice(0, limits.maxSheetRows);
  const grid = rowsRaw.map((row) => {
    const cells: Record<number, string> = {};
    for (const c of childrenOf(row, 'c').slice(0, 100)) {
      const ref = c.attrs['r'] ?? '';
      const m = COLUMN_RE.exec(ref);
      const col = m ? lettersToIndex(m[1] ?? 'A') : 0;
      const type = c.attrs['t'] ?? '';
      const f = findFirst(c, 'f');
      const v = findFirst(c, 'v');
      let value: string;
      if (type === 'inlineStr') {
        const t = findFirst(c, 'is');
        value = t ? collectText(t) : '';
      } else if (type === 's') {
        value = v ? (v.text ?? '').trim() : '';
      } else {
        value = v ? (v.text ?? '').trim() : '';
      }
      const formula = f ? collectText(f) : '';
      cells[col] = formula ? `=${formula}` : value;
    }
    return cells;
  });
  let maxCol = 0;
  for (const cells of grid) {
    for (const k of Object.keys(cells)) maxCol = Math.max(maxCol, Number(k));
  }
  const headers: string[] = [];
  const firstRow = grid[0] ?? {};
  for (let c = 0; c <= Math.min(maxCol, 63); c++) {
    headers.push(firstRow[c] ?? '');
  }
  const formulaCells = grid.reduce(
    (n, row) => n + Object.values(row).filter((v) => v.startsWith('=')).length,
    0,
  );
  const dataRows = grid.slice(1);
  const stats: SpreadsheetColumnStats[] = [];
  for (let c = 0; c < headers.length; c++) {
    const header = headers[c];
    if (!header) continue;
    const values = dataRows
      .map((row) => row[c] ?? '')
      .filter((v) => v.length > 0 && !v.startsWith('='));
    const numeric = values.map(Number).filter(Number.isFinite);
    const numericCount = numeric.length;
    const numericRatio = values.length > 0 ? numericCount / values.length : null;
    const statsFor: SpreadsheetColumnStats = {
      header: header.slice(0, 200),
      numericCount,
      numericRatio,
      min: numericCount > 0 ? Math.min(...numeric) : null,
      max: numericCount > 0 ? Math.max(...numeric) : null,
      sum: numericCount > 0 ? numeric.reduce((a, b) => a + b, 0) : null,
      mean:
        numericCount > 0
          ? Number((numeric.reduce((a, b) => a + b, 0) / numericCount).toFixed(6))
          : null,
    };
    stats.push(statsFor);
    if (stats.length >= 64) break;
  }
  return {
    name: name.slice(0, 200),
    rowCount: dataRows.length,
    columnCount: headers.length,
    headers,
    formulaCells,
    stats,
  };
}

function collectText(node: XmlNode): string {
  let out = node.text ?? '';
  for (const child of node.children) out += collectText(child);
  return out.trim();
}

function lettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRelMap(xml: string): Map<string, string> {
  const root = parseXml(xml);
  const out = new Map<string, string>();
  for (const rel of findAll(root, 'Relationship').slice(0, 100)) {
    const id = rel.attrs['Id'];
    const target = rel.attrs['Target'] ?? '';
    if (id && target) out.set(id, target);
  }
  return out;
}

function parseCore(xml: string): DocumentMetadataEntry[] {
  const out: DocumentMetadataEntry[] = [];
  try {
    const root = parseXml(xml);
    const push = (key: string): void => {
      const node = findFirst(root, key);
      const v = node?.text?.trim();
      if (typeof v === 'string' && v.length > 0)
        out.push({ key, value: v.slice(0, 500), source: 'document' });
    };
    push('dc:title');
    push('dc:creator');
  } catch {
    /* absent metadata is honest */
  }
  return out;
}

export function textOfNode(node: XmlNode): string {
  return textOf(node);
}
