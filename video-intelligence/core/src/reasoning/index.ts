/** Strict, fail-closed parsers for provider reasoning output.
 *
 *  Rules (mirroring the Step 20/21 parsers, tightened for time-aware data):
 *  - Only bare JSON objects are accepted. Markdown fences, prose, or arrays
 *    at the top level fail closed.
 *  - Required fields are required. Optional fields must be well-formed or
 *    they become null/dropped - never clamped into plausibility.
 *  - Timestamps outside [0, maxSeconds] (when known) are dropped to null;
 *    timestamps are NEVER invented.
 *  - Evidence references are INDEXES into manager-owned collections; the
 *    manager maps them to minted ids and silently drops forged indexes.
 *  - Speaker labels are derived only from a neutral numeric index
 *    ("Speaker 1"); free-text speaker identities are rejected outright.
 *  - Arrays are bounded with an honest truncated flag. */
import { VideoIntelligenceError } from '../errors/index.js';
import type {
  TimelineEventKind,
  VideoComparisonDifference,
  VideoComparisonResult,
  VideoComparisonKind,
  VideoDescription,
  VideoExtraction,
  VideoExtractedField,
  VideoFrame,
  VideoFrameExtraction,
  VideoOcrEntry,
  VideoOcrResult,
  VideoQueryResult,
  VideoScene,
  VideoSummary,
  VideoSummaryMode,
  VideoSummaryStep,
  VideoTimeline,
  VideoTimelineEvent,
  VideoTranscript,
  VideoTranscriptSegment,
  VideoTranslation,
} from '../types/index.js';
import {
  frameId,
  eventId,
  ocrEntryId,
  sceneId,
  segmentId,
  truncateText,
} from '../security/index.js';
import type { FileAssetId } from '@veltravia/file-intelligence-core';

/** Bare JSON object or fail closed. No fences, no prose. */
export function parseProviderJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 4_000_000)
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider output was unusable.');
  if (trimmed.startsWith('```'))
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider output was not bare JSON.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider output was not JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider output was not an object.');
  return parsed as Record<string, unknown>;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Timestamp: finite, >= 0, and (when the duration is known) <= duration.
 *  Anything else is an invented timestamp and becomes null. */
export const ts = (v: unknown, maxSeconds: number | null): number | null => {
  const n = num(v);
  if (n === null || n < 0) return null;
  if (maxSeconds !== null && n > maxSeconds) return null;
  return Math.round(n * 1000) / 1000;
};

const bool = (v: unknown): boolean => v === true;

/** Bounded string array; entries that are not strings are dropped. */
function strings(v: unknown, max: number): { items: string[]; truncated: boolean } {
  if (!Array.isArray(v)) return { items: [], truncated: false };
  const items: string[] = [];
  for (const entry of v) {
    if (items.length >= max) return { items, truncated: true };
    const s = str(entry);
    if (s !== null) items.push(s.slice(0, 2000));
  }
  return { items, truncated: v.length > items.length };
}

/** Bounded, validated index array for evidence mapping. Out-of-range
 *  indexes are forged references and are dropped. */
function indexes(v: unknown, maxIndex: number): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const entry of v) {
    const n = num(entry);
    if (n === null || !Number.isInteger(n) || n < 0 || n >= Math.max(maxIndex, 0)) continue;
    if (!out.includes(n) && out.length < 64) out.push(n);
  }
  return out;
}

/** 0..1 box; anything outside its valid domain is dropped, never clamped. */
function box(v: unknown): readonly [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const a = num(v[0]),
    b = num(v[1]),
    c = num(v[2]),
    d = num(v[3]);
  if (
    a === null ||
    b === null ||
    c === null ||
    d === null ||
    a < 0 ||
    b < 0 ||
    c > 1 ||
    d > 1 ||
    a > c ||
    b > d
  )
    return null;
  return [a, b, c, d];
}

const confidence = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};

/** Map provider evidence indexes onto manager-minted ids; forged refs drop. */
function mapIndexes(
  raw: unknown,
  maxIndex: number,
  minter: (index: number) => string | null,
): string[] {
  return [
    ...new Set(
      indexes(raw, maxIndex)
        .map(minter)
        .filter((v): v is string => v !== null),
    ),
  ];
}

export function parseDescription(
  text: string,
  providerId: string,
  fileId: FileAssetId,
): VideoDescription {
  const o = parseProviderJson(text);
  const summary = str(o.summary);
  if (!summary)
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider summary was missing.');
  const observed = strings(o.observed, 32).items;
  const inferred = strings(o.inferred, 32).items;
  return {
    fileId,
    summary: summary.slice(0, 4000),
    observed,
    inferences: inferred,
    providerId,
    trust: 'ai_generated',
  };
}

export function parseFrames(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  strategy: VideoFrameExtraction['strategy'],
  maxSeconds: number | null,
  maxFrames: number,
): { frames: VideoFrame[]; truncated: boolean } {
  const o = parseProviderJson(text);
  const raw = Array.isArray(o.frames) ? o.frames : [];
  const frames: VideoFrame[] = [];
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    if (frames.length >= maxFrames) {
      truncated = true;
      break;
    }
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const caption = str(e.caption) ?? str(e.description) ?? '';
    const timestamp = ts(e.timestamp ?? e.timestampSeconds, maxSeconds);
    const index = num(e.index);
    frames.push({
      id: frameId(checksum, i),
      timestampSeconds: timestamp,
      frameIndex: index !== null && index >= 0 && Number.isInteger(index) ? index : null,
      strategy,
      caption: caption.slice(0, 1000),
      trust: 'ai_generated',
    });
  }
  return { frames, truncated: truncated || raw.length > frames.length };
}

export function parseScenes(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  maxSeconds: number | null,
  knownFrameIds: readonly string[],
  maxScenes: number,
): { scenes: VideoScene[]; truncated: boolean } {
  const o = parseProviderJson(text);
  const raw = Array.isArray(o.scenes) ? o.scenes : [];
  const scenes: VideoScene[] = [];
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    if (scenes.length >= maxScenes) {
      truncated = true;
      break;
    }
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const start = ts(e.start ?? e.startSeconds, maxSeconds);
    const end = ts(e.end ?? e.endSeconds, maxSeconds);
    const observed = strings(e.observed, 16).items;
    const inferred = strings(e.inferred ?? e.description, 16).items;
    const rep =
      indexes([e.representativeFrameIndex], knownFrameIds.length).map(
        (n) => knownFrameIds[n] ?? null,
      )[0] ?? null;
    const duration = start !== null && end !== null && end >= start ? end - start : null;
    scenes.push({
      id: sceneId(checksum, i),
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
      observed,
      inferred,
      representativeFrameId: rep,
    });
  }
  return { scenes, truncated: truncated || raw.length > scenes.length };
}

export function parseTranscript(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  maxSeconds: number | null,
  maxSegments: number,
  maxCharacters = 500_000,
): { transcript: VideoTranscript; truncated: boolean } {
  const o = parseProviderJson(text);
  const raw = Array.isArray(o.segments) ? o.segments : [];
  const language = str(o.language);
  const segments: VideoTranscriptSegment[] = [];
  let truncated = false;
  let characters = 0;
  let anyTimestamp = false;
  let anySpeaker = false;
  let anyConfidence = false;
  for (let i = 0; i < raw.length; i++) {
    if (segments.length >= maxSegments) {
      truncated = true;
      break;
    }
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const segText = str(e.text);
    if (!segText) continue;
    if (characters >= maxCharacters) {
      truncated = true;
      break;
    }
    const safeText = segText.slice(0, Math.min(5000, maxCharacters - characters));
    if (safeText.length < segText.length) truncated = true;
    characters += safeText.length;
    const start = ts(e.start ?? e.startSeconds, maxSeconds);
    const end = ts(e.end ?? e.endSeconds, maxSeconds);
    if (start !== null) anyTimestamp = true;
    // Speaker labels are NEUTRAL and index-derived only. A provider string
    // label (a claimed identity) is rejected outright.
    let speaker: string | null = null;
    const speakerIndex = num(e.speakerIndex);
    if (
      speakerIndex !== null &&
      Number.isInteger(speakerIndex) &&
      speakerIndex >= 1 &&
      speakerIndex <= 8
    ) {
      speaker = `Speaker ${speakerIndex}`;
      anySpeaker = true;
    }
    const conf = confidence(e.confidence);
    if (conf !== null) anyConfidence = true;
    segments.push({
      id: segmentId(checksum, i),
      startSeconds: start,
      endSeconds: end,
      text: safeText,
      speaker,
      language: language,
      confidence: conf,
    });
  }
  const joined = truncateText(segments.map((s) => s.text).join('\n'), maxCharacters);
  return {
    transcript: {
      fileId,
      segments,
      text: joined.text,
      language,
      timestampsAvailable: anyTimestamp,
      speakersAvailable: anySpeaker,
      confidenceAvailable: anyConfidence,
      truncated: truncated || joined.truncated,
      providerId,
      trust: 'untrusted_data',
    },
    truncated: truncated || joined.truncated,
  };
}

const EVENT_KINDS: readonly TimelineEventKind[] = ['observed', 'inferred', 'uncertain'];

export function parseTimeline(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  maxSeconds: number | null,
  knownFrameIds: readonly string[],
  knownSceneIds: readonly string[],
  knownSegmentIds: readonly string[],
  maxEvents: number,
): { timeline: VideoTimeline; truncated: boolean } {
  const o = parseProviderJson(text);
  const raw = Array.isArray(o.events) ? o.events : [];
  const events: VideoTimelineEvent[] = [];
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const statement = str(e.statement);
    if (!statement) continue;
    const kindRaw = str(e.kind);
    const kind: TimelineEventKind =
      kindRaw && (EVENT_KINDS as readonly string[]).includes(kindRaw)
        ? (kindRaw as TimelineEventKind)
        : 'uncertain';
    const frameIds = mapIndexes(
      e.frameIndexes,
      knownFrameIds.length,
      (n) => knownFrameIds[n] ?? null,
    );
    const sceneIds = mapIndexes(
      e.sceneIndexes,
      knownSceneIds.length,
      (n) => knownSceneIds[n] ?? null,
    );
    const segmentIds = mapIndexes(
      e.segmentIndexes,
      knownSegmentIds.length,
      (n) => knownSegmentIds[n] ?? null,
    );
    events.push({
      id: eventId(checksum, i),
      timestampSeconds: ts(e.timestamp ?? e.timestampSeconds, maxSeconds),
      kind,
      statement: statement.slice(0, 2000),
      frameIds,
      sceneIds,
      segmentIds,
    });
  }
  events.sort((a, b) => {
    if (a.timestampSeconds === null) return 1;
    if (b.timestampSeconds === null) return -1;
    return a.timestampSeconds - b.timestampSeconds;
  });
  return {
    timeline: { fileId, events, truncated, providerId, trust: 'ai_generated' },
    truncated: truncated || raw.length > events.length,
  };
}

export function parseQueryResult(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  question: string,
  maxSeconds: number | null,
  knownFrameIds: readonly string[],
  knownSceneIds: readonly string[],
  knownSegmentIds: readonly string[],
): VideoQueryResult {
  const o = parseProviderJson(text);
  const answer = str(o.answer);
  if (!answer)
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider answer was missing.');
  const insufficientEvidence = bool(o.insufficientEvidence);
  const frameIds = mapIndexes(
    o.frameIndexes,
    knownFrameIds.length,
    (n) => knownFrameIds[n] ?? null,
  );
  const sceneIds = mapIndexes(
    o.sceneIndexes,
    knownSceneIds.length,
    (n) => knownSceneIds[n] ?? null,
  );
  const segmentIds = mapIndexes(
    o.segmentIndexes,
    knownSegmentIds.length,
    (n) => knownSegmentIds[n] ?? null,
  );
  const combinedInference = strings(o.combinedInference, 16).items;
  void maxSeconds; // timestamps inside free-text answers are provider claims,
  // labeled ai_generated; structured evidence refs are what stay honest.
  return {
    fileId,
    question,
    answer: answer.slice(0, 4000),
    insufficientEvidence,
    visualEvidence: { frameIds, sceneIds },
    audioEvidence: { segmentIds },
    combinedInference,
    providerId,
    trust: 'ai_generated',
  };
}

export function parseOcrResult(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  createdAt: string,
  maxSeconds: number | null,
  knownFrameIds: readonly string[],
  maxEntries: number,
  maxCharacters = 200_000,
): { ocr: VideoOcrResult; truncated: boolean } {
  const o = parseProviderJson(text);
  const raw = Array.isArray(o.entries) ? o.entries : [];
  const entries: VideoOcrEntry[] = [];
  let characters = 0;
  let truncated = false;
  for (let i = 0; i < raw.length; i++) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const entryText = str(e.text);
    if (!entryText) continue;
    if (characters >= maxCharacters) {
      truncated = true;
      break;
    }
    const safeText = entryText.slice(0, Math.min(2000, maxCharacters - characters));
    if (safeText.length < entryText.length) truncated = true;
    characters += safeText.length;
    const frameIds = mapIndexes(
      [e.frameIndex],
      knownFrameIds.length,
      (n) => knownFrameIds[n] ?? null,
    );
    entries.push({
      id: ocrEntryId(checksum, i),
      text: safeText,
      timestampSeconds: ts(e.timestamp ?? e.timestampSeconds, maxSeconds),
      frameId: frameIds[0] ?? null,
      box: box(e.box),
      confidence: confidence(e.confidence),
    });
  }
  const joined = truncateText(entries.map((e) => e.text).join('\n'), maxCharacters);
  return {
    ocr: {
      fileId,
      entries,
      text: joined.text,
      truncated: truncated || joined.truncated,
      providerId,
      createdAt,
      trust: 'untrusted_data',
    },
    truncated: truncated || joined.truncated,
  };
}

const SUMMARY_MODES: readonly VideoSummaryMode[] = [
  'general',
  'timeline',
  'meeting',
  'tutorial',
  'bug_report',
];

export function parseSummary(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  mode: VideoSummaryMode,
  maxSeconds: number | null,
): VideoSummary {
  const o = parseProviderJson(text);
  const summary = str(o.summary);
  if (!summary)
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Provider summary was missing.');
  const requested = str(o.mode);
  const declared: VideoSummaryMode =
    requested && (SUMMARY_MODES as readonly string[]).includes(requested)
      ? (requested as VideoSummaryMode)
      : mode;
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: VideoSummaryStep[] = [];
  let stepTruncated = false;
  for (const entry of rawSteps) {
    if (steps.length >= 40) {
      stepTruncated = true;
      break;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const stepText = str(e.text ?? e.step);
    if (!stepText) continue;
    steps.push({ text: stepText.slice(0, 2000), timestampSeconds: ts(e.timestamp, maxSeconds) });
  }
  const rawActions = Array.isArray(o.actionItems) ? o.actionItems : [];
  const actionItems: { description: string; uncertain: boolean }[] = [];
  for (const entry of rawActions) {
    if (actionItems.length >= 40) break;
    if (typeof entry === 'string' && entry.trim()) {
      actionItems.push({ description: entry.slice(0, 1000), uncertain: true });
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const description = str(e.description);
      if (description)
        actionItems.push({ description: description.slice(0, 1000), uncertain: !bool(e.stated) });
    }
  }
  return {
    fileId,
    mode: declared,
    summary: summary.slice(0, 4000),
    keyPoints: strings(o.keyPoints, 40).items,
    steps,
    decisions: strings(o.decisions, 40).items,
    actionItems,
    questions: strings(o.questions, 40).items,
    observedFailure: str(o.observedFailure)?.slice(0, 2000) ?? null,
    suspectedCause: str(o.suspectedCause)?.slice(0, 2000) ?? null,
    truncated: stepTruncated,
    providerId,
    trust: 'ai_generated',
  };
}

export function parseExtraction(
  text: string,
  providerId: string,
  fileId: FileAssetId,
): VideoExtraction {
  const o = parseProviderJson(text);
  const raw = Array.isArray(o.fields) ? o.fields : [];
  const fields: VideoExtractedField[] = [];
  for (const entry of raw) {
    if (fields.length >= 40) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const field = str(e.field);
    const value = str(e.value);
    if (!field || !value) continue;
    fields.push({
      field: field.slice(0, 200),
      value: value.slice(0, 2000),
      uncertain: !bool(e.certain),
    });
  }
  return { fileId, fields, providerId, trust: 'ai_generated' };
}

export function parseTranslation(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  language: string,
  segmentCount: number,
): VideoTranslation {
  const o = parseProviderJson(text);
  const translated = str(o.translatedText);
  if (!translated)
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Translation text was missing.');
  return {
    fileId,
    language,
    languageName: str(o.languageName)?.slice(0, 100) ?? null,
    translatedText: translated.slice(0, 500_000),
    segmentCount,
    originalPreserved: true,
    providerId,
    trust: 'ai_generated',
  };
}

const COMPARISON_KINDS: readonly VideoComparisonKind[] = [
  'duration_change',
  'scene_change',
  'text_change',
  'ui_change',
  'audio_change',
  'other',
];

export function parseComparisonResult(
  text: string,
  providerId: string,
  fileAId: FileAssetId,
  fileBId: FileAssetId,
  maxSecondsA: number | null,
  maxSecondsB: number | null,
): VideoComparisonResult & { differences: readonly VideoComparisonDifference[] } {
  const o = parseProviderJson(text);
  const summary = str(o.summary);
  if (!summary)
    throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'Comparison summary was missing.');
  const raw = Array.isArray(o.differences) ? o.differences : [];
  const differences: VideoComparisonDifference[] = [];
  for (const entry of raw) {
    if (differences.length >= 100) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const statement = str(e.statement);
    if (!statement) continue;
    const kindRaw = str(e.kind);
    const kind: VideoComparisonKind =
      kindRaw && (COMPARISON_KINDS as readonly string[]).includes(kindRaw)
        ? (kindRaw as VideoComparisonKind)
        : 'other';
    differences.push({
      kind,
      statement: statement.slice(0, 2000),
      basis: e.basis === 'fact' ? 'fact' : 'inference',
      atSecondsA: ts(e.atSecondsA, maxSecondsA),
      atSecondsB: ts(e.atSecondsB, maxSecondsB),
    });
  }
  return {
    fileAId,
    fileBId,
    summary: summary.slice(0, 4000),
    differences,
    providerId,
    trust: 'ai_generated',
  };
}
