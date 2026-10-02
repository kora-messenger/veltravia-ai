/** Signature-level video inspection helpers. These never trust declared
 *  MIME types or filenames; they read bytes only, defensively. Every parser
 *  is bounds-checked and returns null for facts it cannot genuinely read -
 *  nothing is invented. */
import { createHash, randomBytes } from 'node:crypto';
import type { VideoContainerInfo, VideoFormat } from '../types/index.js';

/** MP4-family brands mapped to a Veltravia format. Detection is by
 *  signature (ftyp box) only - the declared MIME type is never consulted. */
const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'avc2', 'isml', 'dash']);
const MOV_BRANDS = new Set(['qt  ', 'qtl ']);
const M4V_BRANDS = new Set(['M4V ', 'M4VH', 'M4VP']);

function ascii(b: Uint8Array, start: number, length: number): string {
  return Buffer.from(b.subarray(start, start + length)).toString('latin1');
}

/** Detect the video format from magic bytes alone (never declared types). */
export function detectVideoFormat(bytes: Uint8Array): VideoFormat | null {
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (MP4_BRANDS.has(brand)) return 'mp4';
    if (MOV_BRANDS.has(brand)) return 'mov';
    if (M4V_BRANDS.has(brand)) return 'm4v';
    // Unknown ftyp brand: still an MP4-family ISO container, honestly 'mp4'.
    if (brand.length === 4) return 'mp4';
  }
  // EBML header (Matroska/WebM family): 1A 45 DF A3.
  if (bytes.length >= 4) {
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      const doctype = ebmlDocType(bytes);
      if (doctype === 'webm') return 'webm';
      if (doctype === 'matroska') return 'mkv';
      return null; // EBML but not a doctype we can honestly name
    }
    // RIFF....AVI
    if (ascii(bytes, 0, 4) === 'RIFF' && bytes.length >= 12 && ascii(bytes, 8, 4) === 'AVI ')
      return 'avi';
    // MPEG program/system streams: 00 00 01 BA (pack) or B3 (sequence).
    if (
      bytes[0] === 0x00 &&
      bytes[1] === 0x00 &&
      bytes[2] === 0x01 &&
      (bytes[3] === 0xba || bytes[3] === 0xb3)
    )
      return 'mpeg';
  }
  return null;
}

/** Read the EBML DocType element ("webm" / "matroska") near the header.
 *  Bounded scan; null when the element cannot be read defensively. */
export function ebmlDocType(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096)));
  for (let i = 4; i < b.length - 2; i++) {
    if (b[i] === 0x42 && b[i + 1] === 0x82) {
      // DocType element: size is a vint starting at i+2.
      let cursor = i + 2;
      let lengthBytes = 0;
      for (let bit = 7; bit >= 0; bit--) {
        if ((b[cursor] ?? 0) & (1 << bit)) {
          lengthBytes = 8 - bit;
          break;
        }
      }
      if (lengthBytes === 0 || lengthBytes > 4) return null;
      cursor += lengthBytes;
      if (cursor + lengthBytes > b.length) return null;
      return ascii(b, cursor, lengthBytes);
    }
  }
  return null;
}

interface Box {
  readonly type: string;
  readonly contentStart: number;
  readonly contentEnd: number;
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** True when a box is a container we deliberately descend into. */
function isContainerBox(type: string): boolean {
  return CONTAINER_BOXES.has(type);
}

/** Defensive ISO box walker. Bounded per-level box count and size; corrupt
 *  sizes stop the walk instead of throwing. */
function walkBoxes(
  b: Buffer,
  start: number,
  end: number,
  visitor: (box: Box) => 'stop' | 'continue',
  depth = 0,
): void {
  let offset = start;
  let count = 0;
  while (offset + 8 <= end && count < 128) {
    const size = b.readUInt32BE(offset);
    const type = ascii(b, offset + 4, 4);
    if (size < 8 || offset + size > end) return;
    const box: Box = { type, contentStart: offset + 8, contentEnd: offset + size };
    if (visitor(box) === 'stop') return;
    if (depth < 4 && isContainerBox(type))
      walkBoxes(b, box.contentStart, box.contentEnd, visitor, depth + 1);
    offset += size;
    count++;
  }
}

function findBoxes(b: Buffer, start: number, end: number, wanted: string): Box[] {
  const found: Box[] = [];
  walkBoxes(b, start, end, (box) => {
    if (box.type === wanted) found.push(box);
    return 'continue';
  });
  return found;
}

function readUInt64(b: Buffer, at: number): number | null {
  if (at < 0 || at + 8 > b.length) return null;
  const hi = b.readUInt32BE(at);
  const lo = b.readUInt32BE(at + 4);
  if (hi > 0x1_000_000) return null; // beyond any honest duration
  return hi * 2 ** 32 + lo;
}

/** Parse genuine MP4-family container facts by walking the moov box:
 *  mvhd (duration), tkhd (dimensions), hdlr (stream types), mdhd (media
 *  timescale), stsd (codecs, audio channels/rate), stts (frame-rate
 *  estimate). Everything is bounds-checked; missing facts are null. */
export function parseMp4Container(bytes: Uint8Array): VideoContainerInfo {
  const empty: VideoContainerInfo = {
    durationSeconds: null,
    timescale: null,
    width: null,
    height: null,
    frameRate: null,
    videoCodec: null,
    audioCodec: null,
    audioSampleRateHz: null,
    audioChannels: null,
    streamCount: null,
    hasAudio: null,
  };
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return empty;
  const b = Buffer.from(bytes);
  const moov = findBoxes(b, 0, b.length, 'moov')[0];
  if (!moov) return empty;

  let durationSeconds: number | null = null;
  let timescale: number | null = null;
  const mvhd = findBoxes(b, moov.contentStart, moov.contentEnd, 'mvhd')[0];
  if (mvhd) {
    const version = b[mvhd.contentStart];
    if (version === 1) {
      const ts = mvhd.contentStart + 20;
      const dur = mvhd.contentStart + 24;
      const t = ts + 8 <= b.length ? b.readUInt32BE(ts) : 0;
      const d = readUInt64(b, dur);
      timescale = t > 0 ? t : null;
      if (t > 0 && d !== null) durationSeconds = d / t;
    } else if (version === 0) {
      const at = mvhd.contentStart + 12;
      if (at + 8 <= mvhd.contentEnd) {
        const t = b.readUInt32BE(at);
        const d = b.readUInt32BE(at + 4);
        timescale = t > 0 ? t : null;
        if (t > 0) durationSeconds = d / t;
      }
    }
  }

  const traks = findBoxes(b, moov.contentStart, moov.contentEnd, 'trak');
  let width: number | null = null;
  let height: number | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let audioSampleRateHz: number | null = null;
  let audioChannels: number | null = null;
  let frameRate: number | null = null;
  let hasAudio = false;
  let hasVideo = false;

  for (const trak of traks) {
    const mdia = findBoxes(b, trak.contentStart, trak.contentEnd, 'mdia')[0];
    const hdlr = mdia ? findBoxes(b, mdia.contentStart, mdia.contentEnd, 'hdlr')[0] : undefined;
    // hdlr payload: version/flags(4), pre_defined(4), handler_type(4).
    const handler =
      hdlr && hdlr.contentStart + 12 <= hdlr.contentEnd ? ascii(b, hdlr.contentStart + 8, 4) : '';
    let mediaTimescale: number | null = null;
    if (mdia) {
      const mdhd = findBoxes(b, mdia.contentStart, mdia.contentEnd, 'mdhd')[0];
      if (mdhd) {
        const version = b[mdhd.contentStart];
        const at = mdhd.contentStart + (version === 1 ? 20 : 12);
        if (at + 4 <= mdhd.contentEnd) {
          const t = b.readUInt32BE(at);
          mediaTimescale = t > 0 ? t : null;
        }
      }
    }
    if (handler === 'vide') {
      hasVideo = true;
      const tkhd = findBoxes(b, trak.contentStart, trak.contentEnd, 'tkhd')[0];
      if (tkhd) {
        const version = b[tkhd.contentStart];
        // v0: width/height (16.16 fixed) at payload offsets 76/80; v1: 84/88.
        const wAt = tkhd.contentStart + (version === 1 ? 84 : 76);
        const hAt = wAt + 4;
        if (wAt + 8 <= tkhd.contentEnd) {
          const w = b.readUInt32BE(wAt) / 65536;
          const h = b.readUInt32BE(hAt) / 65536;
          if (w > 0 && h > 0) {
            width = Math.round(w);
            height = Math.round(h);
          }
        }
      }
      // stsd first sample entry: the codec fourcc.
      const codec = firstStsdFourcc(b, mdia);
      if (codec) videoCodec = codec;
      // stts: constant-rate estimate frameRate = samples / media-duration.
      frameRate = estimateFrameRate(b, mdia, mediaTimescale) ?? frameRate;
    } else if (handler === 'soun') {
      hasAudio = true;
      const codec = firstStsdFourcc(b, mdia);
      if (codec) audioCodec = codec;
      const audio = firstStsdAudioEntry(b, mdia);
      if (audio) {
        audioChannels = audio.channels;
        audioSampleRateHz = audio.sampleRate;
      }
    }
  }

  const sane = (n: number | null): number | null =>
    n !== null && Number.isFinite(n) && n >= 0 ? n : null;
  return {
    durationSeconds: sane(durationSeconds),
    timescale,
    width: sane(width),
    height: sane(height),
    frameRate:
      sane(frameRate) !== null && frameRate! > 0 ? Math.round(frameRate! * 100) / 100 : null,
    videoCodec,
    audioCodec,
    audioSampleRateHz: sane(audioSampleRateHz),
    audioChannels: sane(audioChannels),
    streamCount: traks.length,
    hasAudio: hasVideo || hasAudio ? hasAudio : null,
  };
}

function findStbl(b: Buffer, mdia: Box | undefined): Box | null {
  if (!mdia) return null;
  const minf = findBoxes(b, mdia.contentStart, mdia.contentEnd, 'minf')[0];
  if (!minf) return null;
  return findBoxes(b, minf.contentStart, minf.contentEnd, 'stbl')[0] ?? null;
}

function firstStsdFourcc(b: Buffer, mdia: Box | undefined): string | null {
  const stbl = findStbl(b, mdia);
  if (!stbl) return null;
  const stsd = findBoxes(b, stbl.contentStart, stbl.contentEnd, 'stsd')[0];
  if (!stsd) return null;
  // stsd payload: version/flags(4), entry_count(4), entry{size(4), format(4)}.
  if (stsd.contentStart + 8 > stsd.contentEnd || b.readUInt32BE(stsd.contentStart + 4) < 1)
    return null;
  const fourccAt = stsd.contentStart + 12;
  if (fourccAt + 4 > b.length || fourccAt + 4 > stsd.contentEnd) return null;
  const fourcc = ascii(b, fourccAt, 4);
  return /^[\x20-\x7e]{4}$/.test(fourcc) ? fourcc : null;
}

interface AudioSampleEntry {
  readonly channels: number | null;
  readonly sampleRate: number | null;
}

function firstStsdAudioEntry(b: Buffer, mdia: Box | undefined): AudioSampleEntry | null {
  const stbl = findStbl(b, mdia);
  if (!stbl) return null;
  const stsd = findBoxes(b, stbl.contentStart, stbl.contentEnd, 'stsd')[0];
  if (!stsd) return null;
  const entryAt = stsd.contentStart + 8;
  // entry: size(4), format(4), reserved(6), data_ref_index(2), channels(2),
  // sample_size(2), pre_defined(2), reserved(2), sample_rate(4, 16.16 fixed).
  const channelsAt = entryAt + 24;
  const rateAt = entryAt + 32;
  if (channelsAt + 2 > stsd.contentEnd || rateAt + 4 > stsd.contentEnd) return null;
  const channels = b.readUInt16BE(channelsAt);
  const rate = Math.round(b.readUInt32BE(rateAt) / 65536);
  return {
    channels: channels > 0 && channels <= 64 ? channels : null,
    sampleRate: rate > 0 ? rate : null,
  };
}

function estimateFrameRate(
  b: Buffer,
  mdia: Box | undefined,
  mediaTimescale: number | null,
): number | null {
  if (!mediaTimescale) return null;
  const stbl = findStbl(b, mdia);
  if (!stbl) return null;
  const stts = findBoxes(b, stbl.contentStart, stbl.contentEnd, 'stts')[0];
  if (!stts) return null;
  // stts payload: version/flags(4), entry_count(4), {sample_count, sample_delta}[].
  const countAt = stts.contentStart + 4;
  if (countAt + 4 > stts.contentEnd) return null;
  const entryCount = b.readUInt32BE(countAt);
  if (entryCount <= 0 || entryCount > 1024) return null;
  let totalSamples = 0;
  let totalUnits = 0;
  let cursor = countAt + 4;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 8 > b.length || cursor + 8 > stts.contentEnd) return null;
    const samples = b.readUInt32BE(cursor);
    const delta = b.readUInt32BE(cursor + 4);
    totalSamples += samples;
    totalUnits += samples * delta;
    cursor += 8;
  }
  if (totalSamples <= 0 || totalUnits <= 0) return null;
  return (totalSamples * mediaTimescale) / totalUnits;
}

/** Ceiling checks. Null means "unknown -> allowed" (never guessed). */
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

/** Deterministic, unforgeable evidence ids owned by the manager. Providers
 *  cannot mint these; forged references are silently dropped. */
export function frameId(checksum: string, index: number): string {
  return id('vf', checksum, index);
}
export function sceneId(checksum: string, index: number): string {
  return id('vs', checksum, index);
}
export function segmentId(checksum: string, index: number): string {
  return id('vt', checksum, index);
}
export function eventId(checksum: string, index: number): string {
  return id('ve', checksum, index);
}
export function ocrEntryId(checksum: string, index: number): string {
  return id('vo', checksum, index);
}

export function newVideoJobId(): string {
  return `videojob_${randomBytes(12).toString('hex')}`;
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
