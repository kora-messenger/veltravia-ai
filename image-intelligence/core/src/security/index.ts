/** Signature-level image inspection helpers. These never trust declared
 *  MIME types or filenames; they read bytes only, defensively. */
import { createHash, randomBytes } from 'node:crypto';
import type { ImageFormat } from '../types/index.js';

const MIME_TO_FORMAT: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/tif': 'tiff',
  'image/svg+xml': 'svg',
};

/** Map a detected MIME type to a format. Null when unknown. */
export function formatFromMime(mime: string): ImageFormat | null {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_TO_FORMAT[base] ?? null;
}

/** Detect the format from magic bytes alone (never the declared type). */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8) {
    const head = bytes.subarray(0, 8);
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  }
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, 4);
    // JPEG: FF D8 FF
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
    // GIF87a / GIF89a
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'gif';
    // BMP: 42 4D
    if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
    // TIFF: II*\0 or MM\0*
    if (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) return 'tiff';
    if (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00) return 'tiff';
  }
  if (bytes.length >= 12) {
    // WEBP: RIFF....WEBP
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const webp = String.fromCharCode(...bytes.subarray(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'webp';
  }
  if (bytes.length >= 4) {
    const text = Buffer.from(bytes.subarray(0, 512)).toString('latin1');
    if (/^\s*(<\?xml|<svg|<!--)/i.test(text) && text.toLowerCase().includes('<svg')) return 'svg';
  }
  return null;
}

/** PNG IHDR color facts. Layout: 8-byte signature, 4-byte length, 'IHDR',
 *  width(4), height(4), then bitDepth(1) and colorType(1) -> offsets 24/25. */
export function parsePngInfo(b: Uint8Array): {
  bitDepth: number | null;
  colorType: number | null;
  hasAlpha: boolean;
} {
  if (b.length < 26) return { bitDepth: null, colorType: null, hasAlpha: false };
  const sig = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d;
  if (!sig) return { bitDepth: null, colorType: null, hasAlpha: false };
  const type = String.fromCharCode(...b.subarray(12, 16));
  if (type !== 'IHDR') return { bitDepth: null, colorType: null, hasAlpha: false };
  const bitDepth = b[24] ?? null;
  const colorType = b[25] ?? null;
  return {
    bitDepth,
    colorType,
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

/** Read PNG dimensions from IHDR. */
export function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null;
  const type = String.fromCharCode(...b.subarray(12, 16));
  if (type !== 'IHDR') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Animation facts for GIF/animated WebP. Scan is capped; unknown = null. */
const ANIMATION_SCAN_CAP = 1024 * 1024;
export function parseAnimationInfo(
  b: Uint8Array,
  format: ImageFormat | null,
): { animated: boolean | null; frameCount: number | null } {
  if (format === 'gif') {
    const scan = b.subarray(0, Math.min(b.length, ANIMATION_SCAN_CAP));
    let frames = 0;
    for (let i = 13; i < scan.length; i++) {
      // Image Separator 0x2C counts a frame.
      if (scan[i] === 0x2c) frames++;
    }
    const count = Math.max(frames, 1);
    return { animated: count > 1, frameCount: count };
  }
  if (format === 'webp') {
    if (b.length >= 16) {
      const chunk = String.fromCharCode(...b.subarray(12, 16));
      if (chunk === 'VP8X') {
        const flags = b[20] ?? 0;
        const animated = (flags & 0x02) !== 0;
        return { animated, frameCount: animated ? null : 1 };
      }
    }
    return { animated: false, frameCount: 1 };
  }
  // Only GIF and WebP can be animated containers; anything else is honestly
  // unknown here because this helper reads bytes only and does not guess.
  return { animated: null, frameCount: null };
}

/** SVG safety check: script tags, event handlers, javascript: URLs. */
export function svgHasScript(b: Uint8Array): boolean {
  const text = Buffer.from(b.subarray(0, Math.min(b.length, ANIMATION_SCAN_CAP))).toString(
    'latin1',
  );
  return /<script|onload\s*=|onerror\s*=|javascript:/i.test(text);
}

/** Ceiling check for decoded dimensions. Null means unknown -> allowed. */
export function withinDimensionCeiling(
  width: number | null,
  height: number | null,
  maxDimensionPixels: number,
): boolean {
  if (width === null || height === null) return true;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width <= maxDimensionPixels && height <= maxDimensionPixels;
}

const id = (prefix: string, key: string, index: number) =>
  `${prefix}_${createHash('sha256').update(`${key}:${index}`).digest('hex').slice(0, 12)}`;

/** Deterministic, unforgeable OCR region ids owned by the manager. */
export function regionId(checksum: string, index: number): string {
  return id('r', checksum, index);
}
/** Deterministic UI element ids. */
export function elementId(checksum: string, index: number): string {
  return id('e', checksum, index);
}
/** Deterministic diagram node ids. */
export function nodeId(checksum: string, index: number): string {
  return id('n', checksum, index);
}

export function newImageJobId(): string {
  return `imagejob_${randomBytes(12).toString('hex')}`;
}

/** Bounded text truncation with an honest marker. */
export function truncateText(
  text: string,
  maxCharacters: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxCharacters - 32))}\n[TRUNCATED: text exceeded ${maxCharacters} characters]`,
    truncated: true,
  };
}
