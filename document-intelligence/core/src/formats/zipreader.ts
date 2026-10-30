/** Minimal, bounded ZIP reader for OOXML containers. Reads the End of Central
 *  Directory, then central-directory entries, then local headers. No paths,
 *  no archives outside the container, no decompression bombs (sizes are
 *  validated against limits before inflation). */
import { inflateRawSync } from 'node:zlib';
import { DocumentIntelligenceError } from '../errors/index.js';

export interface ZipPart {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CDE_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;

/** List entry paths from the central directory (no inflation). */
export function zipEntryPaths(bytes: Uint8Array): readonly string[] {
  const view = asDataView(bytes);
  const eocd = findEocd(view);
  if (!eocd) return [];
  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  const out: string[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CDE_SIGNATURE) break;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = utf8(bytes, p + 46, nameLen);
    if (name && !name.endsWith('/')) out.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Read up to `maxEntries` named parts (exact paths) from the archive. */
export function readZipParts(
  bytes: Uint8Array,
  wanted: readonly string[],
  maxTotalBytes: number,
): Map<string, Uint8Array> {
  const view = asDataView(bytes);
  const eocd = findEocd(view);
  if (!eocd)
    throw new DocumentIntelligenceError('DOCUMENT_UNSUPPORTED_FORMAT', 'Malformed ZIP container.');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const wantedSet = new Set(wanted);
  const out = new Map<string, Uint8Array>();
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CDE_SIGNATURE) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = utf8(bytes, p + 46, nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/') || !wantedSet.has(name)) continue;
    if (uncompressedSize > maxTotalBytes - total)
      throw new DocumentIntelligenceError('DOCUMENT_LIMIT_EXCEEDED', 'Container part too large.');
    const part = readLocal(bytes, view, localOffset, method, compressedSize, uncompressedSize);
    if (!part) continue;
    total += part.byteLength;
    out.set(name, part);
    if (out.size === wantedSet.size) break;
  }
  return out;
}

function readLocal(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array | null {
  if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== LFH_SIGNATURE) return null;
  const nameLen = view.getUint16(offset + 26, true);
  const extraLen = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLen + extraLen;
  const data = bytes.slice(dataStart, dataStart + compressedSize);
  if (data.byteLength < compressedSize) return null;
  if (method === 0) return data;
  if (method === 8) {
    if (uncompressedSize > 100 * 1024 * 1024) return null;
    const inflated = inflateRawSync(data);
    if (inflated.byteLength !== uncompressedSize) return null;
    return inflated;
  }
  return null;
}

function findEocd(view: DataView): number | null {
  const min = Math.max(0, view.byteLength - 66_000 - 22);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return null;
}

function utf8(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.slice(offset, offset + length));
}

function asDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
