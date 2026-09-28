/** Audio-specific safety helpers: format mapping, WAV header parsing (the only
 *  container parsed here), bounded ids, and language normalization. */
import { createHash, randomUUID } from 'node:crypto';
import type { AudioFormat } from '../types/index.js';

const FORMAT_BY_MIME: Record<string, AudioFormat> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/opus': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};
export function formatFromMime(mime: string): AudioFormat | null {
  return FORMAT_BY_MIME[mime.toLowerCase()] ?? null;
}

export interface WavInfo {
  readonly sampleRateHz: number | null;
  readonly channels: number | null;
  /** Bytes per second of PCM data, when computable. */
  readonly byteRate: number | null;
}
/** Safely parse a RIFF/WAVE header. Any doubt -> null. Never throws. */
export function parseWavInfo(bytes: Uint8Array): WavInfo {
  const b = Buffer.from(bytes);
  if (
    b.length < 44 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE'
  )
    return { sampleRateHz: null, channels: null, byteRate: null };
  try {
    let offset = 12;
    let sampleRate: number | null = null;
    let channels: number | null = null;
    let byteRate: number | null = null;
    while (offset + 8 <= b.length) {
      const chunkId = b.toString('ascii', offset, offset + 4);
      const size = b.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ' && offset + 8 + 16 <= b.length) {
        channels = b.readUInt16LE(offset + 10);
        sampleRate = b.readUInt32LE(offset + 12);
        byteRate = b.readUInt32LE(offset + 16);
        if (sampleRate <= 0 || channels <= 0 || byteRate <= 0)
          return { sampleRateHz: null, channels: null, byteRate: null };
      }
      offset += 8 + size + (size % 2);
    }
    return { sampleRateHz: sampleRate, channels, byteRate };
  } catch {
    return { sampleRateHz: null, channels: null, byteRate: null };
  }
}

export function newAudioJobId(): string {
  return `audiojob_${randomUUID()}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** BCP-47-ish normalization for requested/detected languages. */
export function normalizeLanguageTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const trimmed = tag.trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(trimmed)) return null;
  return trimmed;
}

/** Deterministic, collision-free segment ids per job. */
export function segmentId(jobKey: string, index: number): string {
  return `seg_${sha256Hex(Buffer.from(`${jobKey}:${index}`)).slice(0, 16)}`;
}

/** Chunk plan: bounded chunk count, never exceeding limits. */
export function planChunks(
  byteLength: number,
  maxChunks: number,
  maxFileBytes: number,
): { count: number; size: number } {
  if (byteLength <= 0) return { count: 1, size: byteLength };
  const target = Math.max(1, Math.ceil(maxFileBytes / maxChunks));
  const count = Math.max(1, Math.min(maxChunks, Math.ceil(byteLength / target)));
  return { count, size: Math.ceil(byteLength / count) };
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
