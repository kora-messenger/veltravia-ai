import { fileTypeFromBuffer } from 'file-type';
import type {
  FileCategory,
  FileMetadata,
  FileType,
  FileValidationIssue,
  FileValidationResult,
} from '../types/index.js';
import { normalizeFilename, sha256 } from '../security/index.js';

const MAP: Record<string, FileType> = {
  txt: 'txt',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  xml: 'xml',
  csv: 'csv',
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  zip: 'zip',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  avi: 'video',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  dart: 'code',
  go: 'code',
  rs: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  css: 'code',
  scss: 'code',
  html: 'code',
  sh: 'code',
  sql: 'code',
  yaml: 'code',
  yml: 'code',
};
const MIME: Record<FileType, string> = {
  txt: 'text/plain',
  markdown: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  code: 'text/plain',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  zip: 'application/zip',
  audio: 'audio/octet-stream',
  video: 'video/octet-stream',
  binary: 'application/octet-stream',
  unknown: 'application/octet-stream',
};
const CATEGORY: Record<FileType, FileCategory> = {
  txt: 'text',
  markdown: 'text',
  json: 'text',
  xml: 'text',
  csv: 'text',
  pdf: 'document',
  docx: 'document',
  xlsx: 'spreadsheet',
  code: 'code',
  png: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  zip: 'archive',
  audio: 'audio',
  video: 'video',
  binary: 'binary',
  unknown: 'unknown',
};
const TYPE_FROM_MIME: Record<string, FileType> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/zip': 'zip',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const ext = (filename: string) => filename.toLowerCase().split('.').pop() ?? '';
function looksText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let bad = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return sample.length === 0 || bad / sample.length < 0.02;
}
function languageFor(filename: string): string | null {
  const e = ext(filename);
  return (
    (
      {
        ts: 'TypeScript',
        tsx: 'TypeScript React',
        js: 'JavaScript',
        jsx: 'JavaScript React',
        py: 'Python',
        java: 'Java',
        kt: 'Kotlin',
        swift: 'Swift',
        dart: 'Dart',
        go: 'Go',
        rs: 'Rust',
        c: 'C',
        h: 'C/C++',
        cpp: 'C++',
        css: 'CSS',
        scss: 'SCSS',
        html: 'HTML',
        sh: 'Shell',
        sql: 'SQL',
        yaml: 'YAML',
        yml: 'YAML',
      } as Record<string, string>
    )[e] ?? null
  );
}
function imageDimensions(
  bytes: Uint8Array,
  type: FileType,
): { width: number | null; height: number | null } {
  const b = Buffer.from(bytes);
  if (type === 'png' && b.length >= 24)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (type === 'gif' && b.length >= 10)
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (type === 'jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1] ?? 0;
      const len = b.readUInt16BE(i + 2);
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      )
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  if (type === 'webp' && b.length >= 30 && b.toString('ascii', 12, 16) === 'VP8X')
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return { width: null, height: null };
}
function mediaDuration(bytes: Uint8Array, type: FileType): number | null {
  const b = Buffer.from(bytes);
  if (
    type === 'audio' &&
    b.length >= 44 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WAVE'
  ) {
    const rate = b.readUInt32LE(28);
    const data = b.indexOf('data', 12, 'ascii');
    if (rate > 0 && data >= 0 && data + 8 <= b.length) return b.readUInt32LE(data + 4) / rate;
  }
  if (type === 'video') {
    const mvhd = b.indexOf('mvhd');
    if (mvhd >= 0 && mvhd + 24 < b.length) {
      const version = b[mvhd + 4];
      const off = version === 1 ? mvhd + 24 : mvhd + 16;
      if (off + 8 <= b.length) {
        const scale = b.readUInt32BE(off);
        const dur = b.readUInt32BE(off + 4);
        if (scale > 0) return dur / scale;
      }
    }
  }
  return null;
}
export async function detectFile(
  filenameRaw: string,
  declaredMimeType: string | null,
  bytes: Uint8Array,
): Promise<{ metadata: FileMetadata; validation: FileValidationResult }> {
  const filename = normalizeFilename(filenameRaw);
  const extension = ext(filename);
  const extensionType = MAP[extension] ?? 'unknown';
  const magic = await fileTypeFromBuffer(bytes).catch(() => undefined);
  let detected: FileType = magic
    ? (TYPE_FROM_MIME[magic.mime] ?? MAP[magic.ext] ?? 'binary')
    : looksText(bytes)
      ? extensionType
      : 'unknown';
  if ((detected === 'unknown' || detected === 'binary') && looksText(bytes))
    detected = extensionType !== 'unknown' ? extensionType : 'txt';
  if (
    !magic &&
    ['pdf', 'docx', 'xlsx', 'png', 'jpeg', 'webp', 'gif', 'zip', 'audio', 'video'].includes(
      detected,
    )
  )
    detected = 'unknown';
  // OOXML containers share ZIP magic; refine by extension, validated structurally during extraction.
  if (detected === 'zip' && (extensionType === 'docx' || extensionType === 'xlsx'))
    detected = extensionType;
  const detectedMime =
    detected === 'audio' && magic?.mime
      ? magic.mime
      : detected === 'video' && magic?.mime
        ? magic.mime
        : MIME[detected];
  const issues: FileValidationIssue[] = [];
  const extensionMismatch = extensionType !== 'unknown' && extensionType !== detected;
  const mimeType = declaredMimeType?.toLowerCase() ?? null;
  const declaredType = mimeType ? TYPE_FROM_MIME[mimeType] : undefined;
  const mimeMismatch = Boolean(
    declaredType &&
    declaredType !== detected &&
    !(declaredType === 'zip' && (detected === 'docx' || detected === 'xlsx')),
  );
  if (extensionMismatch)
    issues.push({
      code: 'EXTENSION_TYPE_MISMATCH',
      message: 'The filename extension does not match the detected content type.',
      severity: 'warning',
    });
  if (mimeMismatch)
    issues.push({
      code: 'MIME_TYPE_MISMATCH',
      message: 'The declared MIME type does not match the detected content type.',
      severity: 'warning',
    });
  const text = looksText(bytes) ? Buffer.from(bytes).toString('utf8') : null;
  const dims = imageDimensions(bytes, detected);
  const metadata: FileMetadata = {
    originalFilename: filenameRaw,
    normalizedFilename: filename,
    declaredMimeType: declaredMimeType ?? null,
    detectedMimeType: detectedMime,
    detectedType: detected,
    category: CATEGORY[detected],
    byteSize: bytes.length,
    checksum: sha256(bytes),
    extensionMismatch,
    mimeMismatch,
    encoding: text !== null ? 'utf-8' : null,
    lineCount: text !== null ? text.split(/\r?\n/).length : null,
    language: detected === 'code' ? languageFor(filename) : null,
    width: dims.width,
    height: dims.height,
    durationSeconds: mediaDuration(bytes, detected),
  };
  return {
    metadata,
    validation: {
      valid: detected !== 'unknown',
      declaredType: mimeType,
      detectedType: detected,
      issues,
    },
  };
}
