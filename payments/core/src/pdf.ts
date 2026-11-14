/**
 * A small PDF writer.
 *
 * Invoices and receipts have to be downloadable, and a downloadable invoice that
 * needs a browser or a headless Chromium is a dependency this service cannot
 * carry. This module writes PDF 1.4 directly: two core fonts, one text operator,
 * a rule for the header and a page break when the page fills up. That is enough
 * for a bill, and it is a hundred lines that can be read in full - which matters
 * more than typography for a financial document.
 *
 * It does not attempt: embedded fonts, images, tables with wrapped cells or
 * encryption. `docs/payments.md` lists those as absent rather than pretending
 * the output is a full report engine.
 *
 * The output is deterministic for the same document and the same date, so a test
 * can assert a byte length and a customer cannot get two different PDFs for one
 * receipt.
 */

import type { PrintableDocument } from './invoices.js';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const LINE_GAP = 4;

interface Placed {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly bold: boolean;
  readonly grey?: boolean;
}

interface Rule {
  readonly y: number;
  readonly x1: number;
  readonly x2: number;
}

interface PageContent {
  readonly placed: Placed[];
  readonly rules: Rule[];
}

/** Rough advance widths, enough to right-align a number. */
const WIDE = new Set(['m', 'w', 'M', 'W']);
const NARROW = new Set(['i', 'j', 'l', 'I', 't', 'f', 'r', '1', '.', ',', ':', ';', "'", '|']);

function charWidth(character: string, bold: boolean): number {
  if (character === ' ') return 0.278;
  if (WIDE.has(character)) return 0.889;
  if (NARROW.has(character)) return 0.333;
  if (character >= '0' && character <= '9') return 0.556;
  if (character >= 'A' && character <= 'Z') return bold ? 0.722 : 0.667;
  if (character === '(' || character === ')') return 0.333;
  return 0.5;
}

export function textWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const character of text) units += charWidth(character, bold);
  return units * size;
}

/** Everything a PDF string literal cannot carry, mapped to what it can. */
function toWinAnsi(text: string): string {
  const replacements: Record<string, string> = {
    '\u2018': "'",
    '\u2019': "'",
    '\u201c': '"',
    '\u201d': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2026': '...',
    '\u00a0': ' ',
    '\u20ac': 'EUR ',
  };
  let out = '';
  for (const character of text) {
    const mapped = replacements[character];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = character.codePointAt(0) ?? 63;
    out += code >= 32 && code <= 126 ? character : '?';
  }
  return out;
}

function escapeLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Lays the document out. Pure: same document in, same pages out. */
export function layoutDocument(document: PrintableDocument): PageContent[] {
  const pages: PageContent[] = [];
  let placed: Placed[] = [];
  let rules: Rule[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  const push = (): void => {
    pages.push({ placed, rules });
    placed = [];
    rules = [];
    y = PAGE_HEIGHT - MARGIN;
  };

  const ensure = (needed: number): void => {
    if (y - needed < MARGIN) push();
  };

  const write = (
    text: string,
    options: { size?: number; bold?: boolean; x?: number; grey?: boolean; gap?: number } = {},
  ): void => {
    const size = options.size ?? 10;
    ensure(size + (options.gap ?? LINE_GAP));
    placed.push({
      text,
      x: options.x ?? MARGIN,
      y,
      size,
      bold: options.bold ?? false,
      ...(options.grey === undefined ? {} : { grey: options.grey }),
    });
    y -= size + (options.gap ?? LINE_GAP);
  };

  const right = (
    text: string,
    options: { size?: number; bold?: boolean; y?: number } = {},
  ): void => {
    const size = options.size ?? 10;
    const bold = options.bold ?? false;
    const width = textWidth(text, size, bold);
    const target = options.y ?? y + size + LINE_GAP;
    placed.push({
      text,
      x: PAGE_WIDTH - MARGIN - width,
      y: target,
      size,
      bold,
    });
  };

  const rule = (): void => {
    rules.push({ y, x1: MARGIN, x2: PAGE_WIDTH - MARGIN });
    y -= 10;
  };

  // Header: business on the left, document identity on the right.
  write(document.business.name, { size: 16, bold: true, gap: 2 });
  for (const line of document.business.lines) {
    write(line, { size: 9, grey: true, gap: 1 });
  }
  right(document.title.toUpperCase(), { size: 18, bold: true });
  right(document.number, { size: 10, y: PAGE_HEIGHT - MARGIN - 26 });
  y -= 8;
  rule();

  write(document.statusLine, { size: 11, bold: true, gap: 10 });

  // Customer, then metadata in two columns.
  write('Billed to', { size: 8, bold: true, grey: true, gap: 2 });
  write(document.customer.name, { size: 10, bold: true, gap: 1 });
  for (const line of document.customer.lines) {
    write(line, { size: 9, gap: 1 });
  }
  y -= 8;

  for (const entry of document.meta) {
    write(`${entry.label}: ${entry.value}`, { size: 9, gap: 1 });
  }
  y -= 8;
  rule();

  // Lines, with the amount right-aligned on the label's baseline.
  for (const line of document.lines) {
    write(line.label, { size: 10, bold: true, gap: 1 });
    if (line.amount !== null) right(line.amount, { size: 10 });
    if (line.detail !== '') write(line.detail, { size: 9, grey: true, gap: 6 });
  }
  y -= 4;

  for (const total of document.totals) {
    write(total.label, {
      size: total.emphasis === true ? 11 : 10,
      bold: total.emphasis === true,
      gap: 2,
    });
    right(total.value, { size: total.emphasis === true ? 11 : 10, bold: total.emphasis === true });
  }

  y -= 12;
  rule();
  for (const note of document.footer) {
    write(note, { size: 8, grey: true, gap: 2 });
  }

  // Guard: an empty document still has to be a page.
  ensure(0);
  push();
  return pages;
}

function contentStream(page: PageContent): string {
  const parts: string[] = ['q', '0.85 0.85 0.85 RG', '0.6 w'];
  for (const line of page.rules) {
    parts.push(`0.6 w ${line.x1} ${line.y} m ${line.x2} ${line.y} l S`);
  }
  parts.push('Q');
  for (const item of page.placed) {
    const font = item.bold ? '/F2' : '/F1';
    const grey = item.grey === true ? '0.42 0.42 0.42 rg' : '0 0 0 rg';
    parts.push(
      `${grey} BT ${font} ${item.size} Tf 1 0 0 1 ${item.x.toFixed(2)} ${item.y.toFixed(2)} Tm (${escapeLiteral(
        toWinAnsi(item.text),
      )}) Tj ET`,
    );
  }
  return parts.join('\n');
}

/** The finished file. Valid PDF 1.4, xref offsets computed from the bytes. */
export function renderPdf(document: PrintableDocument): Buffer {
  const pages = layoutDocument(document);

  // Object layout: 1 catalog, 2 pages tree, 3..4 fonts, then page/content pairs.
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const firstPageObject = 5;
  for (let index = 0; index < pages.length; index += 1) {
    pageObjectNumbers.push(firstPageObject + index * 2);
  }

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index] as PageContent;
    const contentNumber = firstPageObject + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    );
    const stream = contentStream(page);
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
    );
  }

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(header + body, 'utf8'));
    body += `${index + 1} 0 obj\n${objects[index] as string}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(header + body, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, 'utf8');
}

/** Rendered once so a test can assert a receipt is a real file. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.length > 64 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}
