/** DOCX (WordprocessingML) parser: paragraphs, headings, list items, links,
 *  images and tables. Relationships are enumerated as data only - hyperlink
 *  URLs are surfaced, never fetched. Embedded scripts cannot exist in this
 *  part; anything unrecognized is skipped, never executed. */
import type { DocumentElement, DocumentMetadataEntry, DocumentTable } from '../types/index.js';
import { partToText } from './shared.js';
import { findAll, findFirst, parseXml, type XmlNode } from './ooxml-helpers.js';

export interface DocxParseResult {
  readonly elements: readonly DocumentElement[];
  readonly tables: readonly DocumentTable[];
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly truncated: boolean;
}

export interface DocxParseLimits {
  readonly maxElements: number;
  readonly maxTables: number;
  readonly maxTableRows: number;
}

export function parseDocx(
  parts: ReadonlyMap<string, Uint8Array>,
  limits: DocxParseLimits,
  fileId: string,
): DocxParseResult {
  const docBytes = parts.get('word/document.xml');
  if (!docBytes) throw new Error('word/document.xml missing');
  const root = parseXml(partToText(docBytes));
  const body = findFirst(root, 'w:body') ?? root;

  const relBytes = parts.get('word/_rels/document.xml.rels');
  const rels = relBytes ? collectRels(partToText(relBytes)) : new Map<string, string>();

  const coreBytes = parts.get('docProps/core.xml');
  const metadata = coreBytes ? parseCore(partToText(coreBytes)) : [];

  const tables: DocumentTable[] = [];
  const elements: DocumentElement[] = [];
  let truncated = false;

  const visitBlocks = (container: XmlNode): void => {
    for (const child of container.children) {
      if (elements.length >= limits.maxElements) {
        truncated = true;
        return;
      }
      if (child.tag === 'w:p') {
        const el = paragraphElement(child, rels, fileId, elements.length);
        if (el) elements.push(el);
      } else if (child.tag === 'w:tbl') {
        if (tables.length >= limits.maxTables) {
          truncated = true;
          return;
        }
        const table = tableOf(child, fileId, tables.length, limits.maxTableRows);
        if (table) {
          tables.push(table);
          elements.push({
            id: `${fileId}-el${elements.length}`,
            type: 'table',
            text: table.headers.join(' | ').slice(0, 2000),
            level: null,
            tableId: table.id,
            imageCount: null,
            linkUrl: null,
            ref: table.ref,
          });
        }
      } else if (child.tag === 'w:sectPr' || child.tag === 'w:sdt' || child.tag === 'w:sdtPr') {
        continue;
      } else {
        visitBlocks(child);
      }
    }
  };
  visitBlocks(body);

  return { elements, tables, metadata, truncated };
}

interface ParagraphInfo {
  readonly text: string;
  readonly heading: boolean;
  readonly headingLevel: number | null;
  readonly listItem: boolean;
  readonly linkId: string | null;
  readonly linkText: string;
  readonly images: number;
}

function paragraphElement(
  p: XmlNode,
  rels: ReadonlyMap<string, string>,
  fileId: string,
  index: number,
): DocumentElement | null {
  const info = inspectParagraph(p);
  const linkUrl = info.linkId ? (rels.get(info.linkId) ?? null) : null;
  if (!info.text && info.images === 0 && !linkUrl) return null;
  const id = `${fileId}-el${index}`;
  const ref = { kind: 'element' as const, id, label: `Paragraph ${index + 1}` };
  if (info.heading) {
    return {
      id,
      type: 'heading',
      text: info.text,
      level: info.headingLevel,
      tableId: null,
      imageCount: info.images,
      linkUrl: null,
      ref,
    };
  }
  if (linkUrl) {
    return {
      id,
      type: 'link',
      text: info.linkText || info.text,
      level: null,
      tableId: null,
      imageCount: info.images,
      linkUrl,
      ref,
    };
  }
  if (info.listItem) {
    return {
      id,
      type: 'listItem',
      text: info.text,
      level: null,
      tableId: null,
      imageCount: info.images,
      linkUrl: null,
      ref,
    };
  }
  if (info.images > 0 && !info.text) {
    return {
      id,
      type: 'image',
      text: '',
      level: null,
      tableId: null,
      imageCount: info.images,
      linkUrl: null,
      ref,
    };
  }
  return {
    id,
    type: 'paragraph',
    text: info.text,
    level: null,
    tableId: null,
    imageCount: info.images,
    linkUrl: null,
    ref,
  };
}

function inspectParagraph(p: XmlNode): ParagraphInfo {
  const runs = findAll(p, 'w:r');
  let text = '';
  let linkId: string | null = null;
  let linkText = '';
  let images = 0;
  for (const run of runs) {
    if (findFirst(run, 'w:br') || findFirst(run, 'w:tab')) text += ' ';
    const drawings = findAll(run, 'w:drawing').length + findAll(run, 'w:pict').length;
    images += drawings;
    const texts = findAll(run, 'w:t');
    for (const t of texts) {
      const chunk = (t.text ?? '').replace(/\s+/g, ' ');
      if (run.children.some((c) => c.tag === 'w:rPr' && findAll(c, 'w:rStyle').length > 0)) {
        // style runs carry no link id by themselves
      }
      text += chunk;
      if (linkId) linkText += chunk;
    }
    for (const h of findAll(run, 'w:hyperlink')) {
      // hyperlink wrappers live at paragraph level; handled below
      linkId = h.attrs['r:id'] ?? linkId;
    }
  }
  for (const h of findAll(p, 'w:hyperlink')) {
    linkId = h.attrs['r:id'] ?? linkId;
    for (const t of findAll(h, 'w:t')) linkText += (t.text ?? '').replace(/\s+/g, ' ');
  }
  const pPr = findFirst(p, 'w:pPr');
  let heading = false;
  let headingLevel: number | null = null;
  let listItem = false;
  if (pPr) {
    const style = findFirst(pPr, 'w:pStyle');
    const styleVal = style?.attrs['w:val'] ?? '';
    const m = /^Heading(\d)$/i.exec(styleVal);
    if (m) {
      heading = true;
      headingLevel = Number(m[1]);
    }
    if (findFirst(pPr, 'w:numPr')) listItem = true;
  }
  return {
    text: text.trim().slice(0, 2000),
    heading,
    headingLevel,
    listItem,
    linkId,
    linkText: linkText.trim().slice(0, 500),
    images,
  };
}

function tableOf(
  tbl: XmlNode,
  fileId: string,
  index: number,
  maxRows: number,
): DocumentTable | null {
  const rowsRaw = findAll(tbl, 'w:tr').slice(0, maxRows + 1);
  if (rowsRaw.length === 0) return null;
  const rows = rowsRaw.map((tr) =>
    findAll(tr, 'w:tc')
      .slice(0, 50)
      .map((tc) =>
        findAll(tc, 'w:t')
          .map((t) => (t.text ?? '').trim())
          .join('')
          .slice(0, 500),
      ),
  );
  const headers = rows.shift() ?? [];
  const id = `${fileId}-tbl${index}`;
  return {
    id,
    headers,
    rows,
    truncated: rowsRaw.length > maxRows,
    ref: { kind: 'table', id, label: `Table ${index + 1}` },
  };
}

function collectRels(xml: string): Map<string, string> {
  const root = parseXml(xml);
  const out = new Map<string, string>();
  for (const rel of findAll(root, 'Relationship')) {
    const id = rel.attrs['Id'];
    const target = rel.attrs['Target'] ?? '';
    if (id && target) out.set(id, target);
    if (out.size >= 200) break;
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
    push('dcterms:created');
    push('dcterms:modified');
    push('dc:subject');
  } catch {
    /* absent metadata is honest */
  }
  return out;
}
