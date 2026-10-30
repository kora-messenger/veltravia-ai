/** Document security helpers: magic-byte format detection and bounded string
 *  hygiene. Formats are NEVER trusted from declared filenames or MIME types;
 *  unparseable metadata stays null, never guessed. */
import { DocumentIntelligenceError } from '../errors/index.js';
import type { DocumentFormat } from '../types/index.js';

/** Secret-shaped content is rejected, never stored. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\W)(sk-[A-Za-z0-9][A-Za-z0-9_-]{7,})($|\W)/,
  /(^|\W)(api[_-]?key\s*[:=]\s*\S{8,})/i,
  /(^|\W)(secret\s*[:=]\s*\S{8,})/i,
  /(^|\W)(Bearer\s+[A-Za-z0-9._-]{16,})/,
];

export function containsSecretShape(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function assertNoSecretShape(text: string, what: string): void {
  if (containsSecretShape(text))
    throw new DocumentIntelligenceError(
      'DOCUMENT_SECRET_REJECTED',
      `The ${what} contains secret-shaped content and was rejected.`,
    );
}

/** Clamp a string to a bound; never throw on content, only size. */
export function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function newJobId(): string {
  return `docjob_${randomToken()}`;
}

export function randomToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20);
}

/** Intermediate detection result: ZIP containers need entry inspection. */
export type DetectedDocumentFormat = DocumentFormat | 'zip-container' | 'unknown';

/** Magic-byte sniffing. Returns 'unknown' rather than guessing. */
export function detectDocumentFormat(bytes: Uint8Array): DetectedDocumentFormat {
  if (bytes.length < 4) return 'unknown';
  const head = Array.from(bytes.slice(0, 8));
  const text = head
    .slice(0, 4)
    .map((b) => String.fromCharCode(b))
    .join('');

  // %PDF-
  if (text.startsWith('%PDF')) return 'pdf';

  // ZIP-based (DOCX/XLSX/PPTX share the PK magic; disambiguated by entries).
  if (head[0] === 0x50 && head[1] === 0x4b) return 'zip-container';

  // JSON: first non-whitespace byte is { or [
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  // NOTE: XML may also begin with '<'; handled after zip/html checks below.

  // HTML: <! or <html
  if (bytes.length >= 5) {
    const headStr = utf8Slice(bytes, 0, Math.min(bytes.length, 512)).trimStart().toLowerCase();
    if (headStr.startsWith('<!doctype html') || headStr.startsWith('<html')) return 'html';
    if (headStr.startsWith('<?xml')) return 'xml';
    // Text-family bytes only: control bytes or invalid UTF-8 mean binary.
    if (!looksLikeText(headStr)) return 'unknown';
    // Markdown vs txt vs csv decided structurally, not by magic.
    return sniffText(headStr);
  }
  return 'unknown';
}

function utf8Slice(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(start, end));
}

function looksLikeText(sample: string): boolean {
  if (sample.includes(String.fromCharCode(0xfffd))) return false; // invalid UTF-8
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sample);
}

function sniffText(headStr: string): DetectedDocumentFormat {
  // CSV heuristic: first line has commas and more than one line exists.
  const firstLine = headStr.split('\n')[0] ?? '';
  if (
    (firstLine.match(/,/g)?.length ?? 0) >= 2 &&
    firstLine.includes(',') &&
    !firstLine.includes('    ') &&
    firstLine.indexOf('#') !== 0
  )
    return 'csv';
  return 'txt';
}

/** Disambiguate a ZIP container into a document format by its entries. */
export function documentFormatFromZipEntries(paths: readonly string[]): DocumentFormat | 'unknown' {
  const has = (prefix: string) => paths.some((p) => p === prefix || p.startsWith(prefix));
  if (has('word/document.xml')) return 'docx';
  if (has('xl/workbook.xml')) return 'xlsx';
  if (has('ppt/presentation.xml')) return 'pptx';
  return 'unknown';
}

/** Structural refinement of plain text: html/json/xml/csv/markdown/txt. */
export function refineTextFormat(text: string): DocumentFormat {
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) return 'html';
  if (trimmed.startsWith('<?xml')) return 'xml';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  const firstLine = text.split('\n')[0] ?? '';
  if ((firstLine.match(/,/g)?.length ?? 0) >= 1 && text.includes('\n')) return 'csv';
  const lines = text.split('\n');
  let mdScore = 0;
  for (const line of lines.slice(0, 200)) {
    if (/^#{1,6}\s+\S/.test(line)) mdScore += 2;
    else if (/^\s*([-*+]\s+\S|\d+\.\s+\S)/.test(line)) mdScore += 1;
    else if (/^\s*>\s?\S/.test(line)) mdScore += 1;
    else if (/\[[^\]]+\]\([^)]+\)/.test(line)) mdScore += 2;
    else if (/^```/.test(line)) mdScore += 2;
    else if (/^\|.*\|/.test(line)) mdScore += 2;
  }
  return mdScore >= 2 ? 'markdown' : 'txt';
}
