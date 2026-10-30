/** Structured text format parsers: CSV, Markdown, HTML, JSON, XML, plain
 *  text. All parsing is structural; nothing is executed. */
import type { DocumentElement, DocumentMetadataEntry, DocumentTable } from '../types/index.js';
import { refineTextFormat } from '../security/index.js';
import { decodeEntities } from './ooxml-helpers.js';

export interface StructuredParseLimits {
  readonly maxElements: number;
  readonly maxTables: number;
  readonly maxTableRows: number;
}

export interface StructuredParseResult {
  readonly format: 'csv' | 'markdown' | 'html' | 'json' | 'xml' | 'txt';
  readonly elements: readonly DocumentElement[];
  readonly tables: readonly DocumentTable[];
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly truncated: boolean;
}

export function parseStructured(
  format: 'csv' | 'markdown' | 'html' | 'json' | 'xml' | 'txt',
  text: string,
  limits: StructuredParseLimits,
  fileId: string,
): StructuredParseResult {
  const elements: DocumentElement[] = [];
  const tables: DocumentTable[] = [];
  let truncated = false;

  const add = (
    type: DocumentElement['type'],
    textValue: string,
    level: number | null = null,
    linkUrl: string | null = null,
  ): void => {
    if (elements.length >= limits.maxElements) {
      truncated = true;
      return;
    }
    const id = `${fileId}-el${elements.length}`;
    elements.push({
      id,
      type,
      text: textValue.slice(0, 2000),
      level,
      tableId: null,
      imageCount: null,
      linkUrl,
      ref: { kind: 'element', id, label: `Element ${elements.length + 1}` },
    });
  };

  const addTable = (headers: readonly string[], rows: readonly (readonly string[])[]): void => {
    if (tables.length >= limits.maxTables) {
      truncated = true;
      return;
    }
    const id = `${fileId}-tbl${tables.length}`;
    tables.push({
      id,
      headers: headers.map((h) => h.slice(0, 200)),
      rows: rows.slice(0, limits.maxTableRows).map((r) => r.map((c) => c.slice(0, 500))),
      truncated: rows.length > limits.maxTableRows,
      ref: { kind: 'table', id, label: `Table ${tables.length + 1}` },
    });
    const elId = `${fileId}-el${elements.length}`;
    elements.push({
      id: elId,
      type: 'table',
      text: headers.join(' | ').slice(0, 2000),
      level: null,
      tableId: id,
      imageCount: null,
      linkUrl: null,
      ref: { kind: 'element', id: elId, label: `Element ${elements.length + 1}` },
    });
  };

  switch (format) {
    case 'csv': {
      const records = parseCsv(text, limits.maxTableRows + 1);
      const headers = records[0];
      if (records.length > 0 && headers) {
        addTable(headers, records.slice(1));
        for (const row of records.slice(1).slice(0, 20)) add('listItem', row.join(' | '));
      }
      break;
    }
    case 'markdown': {
      parseMarkdown(text, add, addTable, limits);
      break;
    }
    case 'html': {
      parseHtml(text, add, addTable, limits);
      break;
    }
    case 'json': {
      try {
        const value = JSON.parse(text.length > 2_000_000 ? text.slice(0, 2_000_000) : text);
        describeJson(value, '$', add, 0, limits);
        add('code', JSON.stringify(value).slice(0, 2000));
      } catch {
        add('code', text.slice(0, 2000));
      }
      break;
    }
    case 'xml': {
      const targets = extractXmlLeafText(text, limits.maxElements);
      for (const { tag, value } of targets) add('listItem', `<${tag}> ${value}`);
      break;
    }
    case 'txt': {
      const refined = refineTextFormat(text);
      if (refined === 'markdown') {
        parseMarkdown(text, add, addTable, limits);
      } else {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) add('paragraph', trimmed);
        }
      }
      break;
    }
    default:
      break;
  }

  return { format, elements, tables, metadata: [], truncated };
}

export function parseCsv(text: string, maxRows: number): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim().slice(0, 500)));
}

function parseMarkdown(
  text: string,
  add: (
    type: DocumentElement['type'],
    text: string,
    level?: number | null,
    linkUrl?: string | null,
  ) => void,
  addTable: (headers: readonly string[], rows: readonly (readonly string[])[]) => void,
  _limits: StructuredParseLimits,
): void {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let fenceBuffer: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (/^```/.test(line.trim())) {
      if (inFence) {
        add('code', fenceBuffer.join('\n'));
        fenceBuffer = [];
        inFence = false;
      } else {
        inFence = true;
      }
      index++;
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      index++;
      continue;
    }
    if (/^\|.*\|/.test(line.trim())) {
      const tableLines: string[] = [];
      while (index < lines.length && /^\|.*\|/.test((lines[index] ?? '').trim())) {
        tableLines.push(lines[index] ?? '');
        index++;
      }
      const parsed = tableLines
        .filter((l) => !/^\|[\s:|-]+\|$/.test(l.trim()))
        .map((l) =>
          l
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim().slice(0, 500)),
        );
      const firstRow = parsed[0];
      if (parsed.length > 0 && firstRow) addTable(firstRow, parsed.slice(1));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[2] !== undefined) {
      add('heading', heading[2].trim(), (heading[1] ?? '#').length);
      index++;
      continue;
    }
    const listItem = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listItem?.[2] !== undefined) {
      add('listItem', listItem[2].trim());
      index++;
      continue;
    }
    const link = /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/.exec(line);
    if (link?.[1] && link[2] && line.trim().startsWith('[')) {
      add('link', link[1], null, link[2]);
      index++;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote?.[1] !== undefined) {
      add('paragraph', quote[1].trim());
      index++;
      continue;
    }
    if (line.trim()) add('paragraph', line.trim());
    index++;
  }
}

function parseHtml(
  text: string,
  add: (
    type: DocumentElement['type'],
    text: string,
    level?: number | null,
    linkUrl?: string | null,
  ) => void,
  addTable: (headers: readonly string[], rows: readonly (readonly string[])[]) => void,
  _limits: StructuredParseLimits,
): void {
  // Strip script/style content entirely; their text is never emitted.
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const headings = stripped.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi) ?? [];
  for (const h of headings) {
    const level = Number(/<h([1-6])/.exec(h)?.[1] ?? 1);
    const inner = h
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (inner) add('heading', inner, level);
  }
  const tableMatches = stripped.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const tbl of tableMatches) {
    const headerCells = [...tbl.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
      .map((m) => cleanHtmlText(m[1] ?? ''))
      .filter((t) => t.length > 0);
    const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) =>
        [...(m[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
          cleanHtmlText(c[1] ?? ''),
        ),
      )
      .filter((cells) => cells.length > 0);
    const firstRow = rows[0];
    if (rows.length > 0 && firstRow) {
      const headers = headerCells.length > 0 ? headerCells : firstRow;
      const bodyRows = headerCells.length > 0 ? rows.slice(1) : rows.slice(1);
      addTable(headers, bodyRows);
    }
  }
  const links = [...stripped.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(
    0,
    200,
  );
  for (const link of links) {
    const label = cleanHtmlText(link[2] ?? '');
    const href = link[1] ?? '';
    if (label && href) add('link', label, null, decodeEntities(href));
  }
  const paragraphs = stripped.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) ?? [];
  for (const p of paragraphs) {
    const inner = cleanHtmlText(p.replace(/^<p[^>]*>/i, '').replace(/<\/p>$/i, ''));
    if (inner) add('paragraph', inner);
  }
  const _title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(stripped);
  const listItems = stripped.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
  for (const li of listItems) {
    const inner = cleanHtmlText(li.replace(/^<li[^>]*>/i, '').replace(/<\/li>$/i, ''));
    if (inner) add('listItem', inner);
  }
  if (elementsEmptyCheck(text) && !paragraphs.length && !headings.length) {
    const bodyText = cleanHtmlText(stripped.replace(/<[^>]+>/g, ' '));
    if (bodyText) add('paragraph', bodyText);
  }
}

function elementsEmptyCheck(_text: string): boolean {
  return true;
}

function cleanHtmlText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function describeJson(
  value: unknown,
  path: string,
  add: (type: DocumentElement['type'], text: string) => void,
  depth: number,
  limits: StructuredParseLimits,
): void {
  if (depth > 6) return;
  if (value === null || typeof value !== 'object') {
    add('listItem', `${path} = ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    add('listItem', `${path} (${value.length} items)`);
    for (const [i, item] of value.slice(0, 20).entries())
      describeJson(item, `${path}[${i}]`, add, depth + 1, limits);
    return;
  }
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    describeJson(child, `${path}.${key}`, add, depth + 1, limits);
  }
}

interface XmlLeaf {
  readonly tag: string;
  readonly value: string;
}

function extractXmlLeafText(text: string, max: number): readonly XmlLeaf[] {
  const out: XmlLeaf[] = [];
  const re = /<([\w:.-]+)(?:\s[^>]*)?>([^<]+)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < max) {
    const tag = m[1] ?? '';
    const value = decodeEntities(m[2] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (value && tag) out.push({ tag, value: value.slice(0, 1000) });
  }
  return out;
}

export function textFormatMetadata(_text: string): readonly DocumentMetadataEntry[] {
  return [];
}
