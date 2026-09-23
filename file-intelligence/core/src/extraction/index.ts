import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import { FileIntelligenceError } from '../errors/index.js';
import { detectFile } from '../detection/index.js';
import { normalizeSafePath, scrubSecrets } from '../security/index.js';
import type {
  ArchiveEntry,
  FileLimits,
  FileMetadata,
  StructuredRepresentation,
} from '../types/index.js';

export interface ExtractedArchiveFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface ExtractionOutput {
  readonly representation: StructuredRepresentation;
  readonly archiveFiles: readonly ExtractedArchiveFile[];
}
interface ZipInspection {
  readonly entries: ArchiveEntry[];
  readonly rawEntries: Entry[];
  readonly totalUncompressedBytes: number;
}
const openZip = (bytes: Uint8Array) =>
  new Promise<ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (e, z) => (e || !z ? reject(e ?? new Error('zip unavailable')) : resolve(z)),
    ),
  );
const readEntry = (zip: ZipFile, entry: Entry, limit: number) =>
  new Promise<Uint8Array>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error('entry unavailable'));
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          stream.destroy(new Error('entry limit exceeded'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}
export async function inspectZip(bytes: Uint8Array, limits: FileLimits): Promise<ZipInspection> {
  const zip = await openZip(bytes).catch(() => {
    throw new FileIntelligenceError(
      'FILE_ARCHIVE_REJECTED',
      'Archive central directory is invalid.',
    );
  });
  return await new Promise((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    const rawEntries: Entry[] = [];
    let total = 0;
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(
        new FileIntelligenceError('FILE_ARCHIVE_REJECTED', 'Archive failed security inspection.', {
          reason,
        }),
      );
    };
    zip.on('error', () => fail('malformed'));
    zip.on('entry', (entry) => {
      try {
        const directory = /\/$/.test(entry.fileName);
        const clean = normalizeSafePath(
          directory ? entry.fileName.slice(0, -1) : entry.fileName,
          limits.maxPathLength,
        );
        if (entries.some((e) => e.path.toLowerCase() === clean.toLowerCase()))
          return fail('duplicate-entry');
        const depth = clean.split('/').length;
        if (depth > limits.maxNestingDepth) return fail('nesting-depth');
        if (isSymlink(entry)) return fail('symlink');
        if (entries.length + 1 > limits.maxArchiveEntries) return fail('entry-count');
        total += entry.uncompressedSize;
        if (total > limits.maxArchiveUncompressedBytes) return fail('uncompressed-size');
        const ratio =
          entry.compressedSize === 0
            ? entry.uncompressedSize === 0
              ? 1
              : Infinity
            : entry.uncompressedSize / entry.compressedSize;
        if (ratio > limits.maxCompressionRatio) return fail('compression-ratio');
        if (!directory && /\.(zip|jar|apk|docx|xlsx)$/i.test(clean)) return fail('nested-archive');
        const extension = clean.split('.').pop()?.toLowerCase() ?? '';
        const kind = directory ? 'directory' : 'file';
        entries.push({
          path: clean,
          kind,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          detectedType:
            extension === 'json'
              ? 'json'
              : extension === 'csv'
                ? 'csv'
                : extension === 'md'
                  ? 'markdown'
                  : extension === 'txt'
                    ? 'txt'
                    : extension === 'png'
                      ? 'png'
                      : extension === 'jpg' || extension === 'jpeg'
                        ? 'jpeg'
                        : extension === 'ts' || extension === 'js' || extension === 'py'
                          ? 'code'
                          : 'unknown',
        });
        rawEntries.push(entry);
        zip.readEntry();
      } catch (e) {
        fail(e instanceof Error ? e.message : 'unsafe-path');
      }
    });
    zip.on('end', () => {
      if (!settled) {
        settled = true;
        resolve({ entries, rawEntries, totalUncompressedBytes: total });
      }
    });
    zip.readEntry();
  });
}
async function readZipSelected(
  bytes: Uint8Array,
  paths: readonly string[],
  limit: number,
): Promise<Map<string, Uint8Array>> {
  const wanted = new Set(paths);
  const zip = await openZip(bytes);
  const out = new Map<string, Uint8Array>();
  return await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('entry', async (entry) => {
      try {
        if (wanted.has(entry.fileName)) {
          out.set(entry.fileName, await readEntry(zip, entry, limit));
        }
        zip.readEntry();
      } catch (e) {
        reject(e);
      }
    });
    zip.on('end', () => resolve(out));
    zip.readEntry();
  });
}
const bounded = (text: string, max: number) => ({
  text: scrubSecrets(text.slice(0, max)),
  truncated: text.length > max,
  totalCharacters: text.length,
});
function parseCsv(
  text: string,
  maxRows = 200,
  maxColumns = 100,
): { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (rows.length < maxRows) rows.push(row.slice(0, maxColumns));
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    if (rows.length < maxRows) rows.push(row.slice(0, maxColumns));
  }
  const totalRows = text.split(/\r?\n/).filter(Boolean).length;
  return { columns: rows[0] ?? [], rows: rows.slice(1), totalRows, truncated: totalRows > maxRows };
}
function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
async function extractDocx(
  bytes: Uint8Array,
  limits: FileLimits,
): Promise<StructuredRepresentation> {
  const parts = await readZipSelected(
    bytes,
    ['word/document.xml'],
    limits.maxTextExtractionCharacters * 4,
  );
  const data = parts.get('word/document.xml');
  if (!data)
    throw new FileIntelligenceError('FILE_EXTRACTION_FAILED', 'DOCX document.xml is missing.');
  const xml = Buffer.from(data).toString('utf8');
  const paragraphs = [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((m) => xmlText(m[0]));
  const text = paragraphs.join('\n');
  const b = bounded(text, limits.maxTextExtractionCharacters);
  return { kind: 'document', text: b.text, pages: null, headings: [], truncated: b.truncated };
}
async function extractXlsx(
  bytes: Uint8Array,
  limits: FileLimits,
): Promise<StructuredRepresentation> {
  const inspection = await inspectZipContainer(bytes, limits);
  const paths = inspection.filter(
    (p) =>
      p === 'xl/workbook.xml' ||
      p === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(p),
  );
  const parts = await readZipSelected(bytes, paths, limits.maxTextExtractionCharacters * 4);
  const sharedXml = Buffer.from(parts.get('xl/sharedStrings.xml') ?? []).toString('utf8');
  const shared = [...sharedXml.matchAll(/<si[\s>][\s\S]*?<\/si>/g)].map((m) => xmlText(m[0]));
  const workbook = Buffer.from(parts.get('xl/workbook.xml') ?? []).toString('utf8');
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map(
    (m) => m[1] ?? 'Sheet',
  );
  const sheets = [];
  for (const [i, path] of paths.filter((p) => /^xl\/worksheets/.test(p)).entries()) {
    const xml = Buffer.from(parts.get(path) ?? []).toString('utf8');
    const rowMatches = [...xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)];
    const cells = rowMatches.slice(0, 100).map((r) =>
      [...r[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].slice(0, 50).map((c) => {
        const idx = Number(/\bt="s"/.test(c[1] ?? '') ? xmlText(c[2] ?? '') : -1);
        return idx >= 0 ? (shared[idx] ?? '') : xmlText(c[2] ?? '');
      }),
    );
    sheets.push({
      name: names[i] ?? `Sheet ${i + 1}`,
      rows: rowMatches.length,
      columns: Math.max(0, ...cells.map((r) => r.length)),
      headers: cells[0] ?? [],
      cells,
    });
  }
  return { kind: 'workbook', sheets, truncated: sheets.some((s) => s.rows > 100) };
}
async function inspectZipContainer(bytes: Uint8Array, limits: FileLimits): Promise<string[]> {
  const checked = await inspectZip(bytes, limits);
  return checked.entries.map((e) => e.path);
}
async function extractPdf(
  bytes: Uint8Array,
  limits: FileLimits,
): Promise<StructuredRepresentation> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: Uint8Array.from(bytes),
      disableFontFace: true,
      useSystemFonts: false,
    });
    const doc = await task.promise;
    const pages = doc.numPages;
    let text = '';
    for (let i = 1; i <= pages && text.length < limits.maxTextExtractionCharacters; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += (content.items as Array<{ str?: string }>).map((x) => x.str ?? '').join(' ') + '\n';
    }
    await task.destroy();
    const b = bounded(text, limits.maxTextExtractionCharacters);
    return { kind: 'document', text: b.text, pages, headings: [], truncated: b.truncated };
  } catch {
    throw new FileIntelligenceError('FILE_EXTRACTION_FAILED', 'PDF text extraction failed safely.');
  }
}
export async function extractFile(
  metadata: FileMetadata,
  bytes: Uint8Array,
  limits: FileLimits,
  extractArchiveBytes = false,
): Promise<ExtractionOutput> {
  const type = metadata.detectedType;
  const decode = () => Buffer.from(bytes).toString('utf8');
  if (type === 'txt' || type === 'markdown') {
    const b = bounded(decode(), limits.maxTextExtractionCharacters);
    return { representation: { kind: 'text', ...b }, archiveFiles: [] };
  }
  if (type === 'code') {
    const b = bounded(decode(), limits.maxTextExtractionCharacters);
    return {
      representation: {
        kind: 'code',
        language: metadata.language ?? 'Unknown',
        lineCount: metadata.lineCount ?? 0,
        text: b.text,
        truncated: b.truncated,
      },
      archiveFiles: [],
    };
  }
  if (type === 'json') {
    const raw = decode();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new FileIntelligenceError('FILE_EXTRACTION_FAILED', 'JSON is invalid.');
    }
    const b = bounded(JSON.stringify(value, null, 2), limits.maxTextExtractionCharacters);
    const safeValue = b.truncated
      ? null
      : (JSON.parse(scrubSecrets(JSON.stringify(value))) as unknown);
    return {
      representation: {
        kind: 'json',
        value: safeValue,
        textPreview: b.text,
        truncated: b.truncated,
      },
      archiveFiles: [],
    };
  }
  if (type === 'xml') {
    const raw = decode();
    if (/<!DOCTYPE|<!ENTITY/i.test(raw))
      throw new FileIntelligenceError(
        'FILE_EXTRACTION_FAILED',
        'XML document type declarations are not supported.',
      );
    try {
      const parsed = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
        allowBooleanAttributes: true,
      }).parse(raw) as Record<string, unknown>;
      const roots = Object.keys(parsed).slice(0, 50);
      const b = bounded(raw, limits.maxTextExtractionCharacters);
      return {
        representation: {
          kind: 'xml',
          rootNames: roots,
          textPreview: b.text,
          truncated: b.truncated,
        },
        archiveFiles: [],
      };
    } catch {
      throw new FileIntelligenceError('FILE_EXTRACTION_FAILED', 'XML is invalid.');
    }
  }
  if (type === 'csv') {
    const out = parseCsv(decode());
    return { representation: { kind: 'csv', ...out }, archiveFiles: [] };
  }
  if (type === 'docx')
    return { representation: await extractDocx(bytes, limits), archiveFiles: [] };
  if (type === 'xlsx')
    return { representation: await extractXlsx(bytes, limits), archiveFiles: [] };
  if (type === 'pdf') return { representation: await extractPdf(bytes, limits), archiveFiles: [] };
  if (type === 'zip') {
    const inspected = await inspectZip(bytes, limits);
    let files: ExtractedArchiveFile[] = [];
    if (extractArchiveBytes) {
      const zip = await openZip(bytes);
      files = await new Promise((resolve, reject) => {
        const out: ExtractedArchiveFile[] = [];
        zip.on('error', reject);
        zip.on('entry', async (e) => {
          try {
            if (!/\/$/.test(e.fileName)) {
              out.push({
                path: normalizeSafePath(e.fileName, limits.maxPathLength),
                bytes: await readEntry(zip, e, limits.maxSingleFileBytes),
              });
            }
            zip.readEntry();
          } catch (err) {
            reject(err);
          }
        });
        zip.on('end', () => resolve(out));
        zip.readEntry();
      });
    }
    return {
      representation: {
        kind: 'archive',
        entries: inspected.entries,
        totalEntries: inspected.entries.length,
        totalUncompressedBytes: inspected.totalUncompressedBytes,
        truncated: false,
      },
      archiveFiles: files,
    };
  }
  if (
    metadata.category === 'image' ||
    metadata.category === 'audio' ||
    metadata.category === 'video'
  )
    return {
      representation: {
        kind: 'media',
        width: metadata.width,
        height: metadata.height,
        durationSeconds: metadata.durationSeconds,
      },
      archiveFiles: [],
    };
  throw new FileIntelligenceError(
    'FILE_EXTRACTION_FAILED',
    'This file type has no safe extractor.',
  );
}
export async function validateArchiveContent(bytes: Uint8Array, limits: FileLimits): Promise<void> {
  await inspectZip(bytes, limits);
}
export async function detectArchiveChild(path: string, bytes: Uint8Array) {
  return detectFile(path, null, bytes);
}
