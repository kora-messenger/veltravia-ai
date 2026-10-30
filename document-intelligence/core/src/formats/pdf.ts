/** PDF parser: page count from the page tree and text extracted from
 *  FlateDecode content streams (BT/ET text operators). PDFs are treated as
 *  untrusted bytes: object streams are read only far enough to count pages
 *  and pull text; JavaScript, embedded files, actions and launch actions are
 *  NEVER interpreted. Unparseable structure stays null, never guessed. */
import { inflateSync } from 'node:zlib';
import { DocumentIntelligenceError } from '../errors/index.js';
import type { DocumentElement, DocumentMetadataEntry } from '../types/index.js';

export interface PdfParseResult {
  readonly pageCount: number | null;
  readonly elements: readonly DocumentElement[];
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly truncated: boolean;
}

export interface PdfParseLimits {
  readonly maxElements: number;
  readonly maxPages: number;
}

export function parsePdf(
  bytes: Uint8Array,
  limits: PdfParseLimits,
  fileId: string,
): PdfParseResult {
  const latin = new TextDecoder('latin1').decode(bytes);
  const pageCount = countPages(latin);
  const elements: DocumentElement[] = [];
  let truncated = false;

  const streams = collectStreams(latin, bytes, 2000);
  for (const text of streams) {
    const chunks = extractTextOperators(text);
    for (const chunk of chunks) {
      if (elements.length >= limits.maxElements) {
        truncated = true;
        break;
      }
      const trimmed = chunk.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      elements.push({
        id: `${fileId}-el${elements.length}`,
        type: 'paragraph',
        text: trimmed.slice(0, 2000),
        level: null,
        tableId: null,
        imageCount: null,
        linkUrl: null,
        ref: {
          kind: 'page',
          id: 'page-1',
          label: elements.length === 0 ? 'Page 1' : 'Page 1+',
        },
      });
    }
    if (truncated) break;
  }
  const metadata = parsePdfMetadata(latin);
  const maxPages = limits.maxPages;
  const capped = truncated || (pageCount !== null && pageCount > maxPages);
  return { pageCount, elements, metadata, truncated: capped };
}

function countPages(latin: string): number | null {
  const counts: number[] = [];
  const typeRe = /\/Type\s*\/Page\b/g;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(latin)) !== null) counts.push(m.index);
  if (counts.length === 0) return null;
  return counts.length;
}

function collectStreams(latin: string, bytes: Uint8Array, max: number): readonly string[] {
  const out: string[] = [];
  const re = /stream\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null && out.length < max) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    const raw = bytes.slice(start, end);
    out.push(decodeStream(raw));
  }
  return out;
}

function decodeStream(raw: Uint8Array): string {
  // Try FlateDecode first; fall back to raw bytes.
  try {
    const inflated = inflateSync(raw);
    return latinOrUtf8(inflated);
  } catch {
    return latinOrUtf8(raw);
  }
}

function latinOrUtf8(b: Uint8Array): string {
  const asUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(b).slice(0, 200_000);
  return asUtf8;
}

/** Pull Tj/TJ string operands from PDF text operators. */
function extractTextOperators(stream: string): readonly string[] {
  let current = '';
  const pieces: string[] = [];
  const tjRe = /\(((?:\\.|[^\\()])*)\)|TJ|ET|BT/g;
  let t: RegExpExecArray | null;
  while ((t = tjRe.exec(stream)) !== null) {
    if (t[0] === 'BT') {
      current = '';
      continue;
    }
    if (t[0] === 'ET') {
      if (current.trim()) pieces.push(current);
      current = '';
      continue;
    }
    if (t[1] !== undefined) {
      current += decodePdfString(t[1]);
      if (current.length > 5000) {
        pieces.push(current);
        current = '';
      }
    }
    if (t[0] === 'TJ') {
      // array form: keep accumulating then flush on next Td/T*
      pieces.push(current);
      current = '';
    }
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}

function decodePdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_, c) => {
      switch (c) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        default:
          return c;
      }
    })
    .replace(/\\([0-7]{1,3})/g, (_, oct) => {
      const code = Number.parseInt(oct, 8);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

function parsePdfMetadata(latin: string): DocumentMetadataEntry[] {
  const out: DocumentMetadataEntry[] = [];
  const push = (key: string, value: string): void => {
    if (value) out.push({ key, value: value.slice(0, 500), source: 'document' });
  };
  const infoMatch = /\/Title\s*\(((?:\\.|[^\\()])*)\)/.exec(latin);
  if (infoMatch) push('Title', decodePdfString(infoMatch[1] ?? ''));
  const authorMatch = /\/Author\s*\(((?:\\.|[^\\()])*)\)/.exec(latin);
  if (authorMatch) push('Author', decodePdfString(authorMatch[1] ?? ''));
  return out;
}

export function assertPdf(bytes: Uint8Array): void {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 5));
  if (!head.startsWith('%PDF'))
    throw new DocumentIntelligenceError('DOCUMENT_UNSUPPORTED_FORMAT', 'Not a PDF.');
}
