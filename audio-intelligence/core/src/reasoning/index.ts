/**
 * Tolerant, fail-closed parsing of provider reasoning output.
 *
 * Providers return text. For structured operations the provider is asked for
 * JSON; this module validates it strictly against the expected shape and
 * throws AUDIO_PROVIDER_ERROR on anything malformed. Evidence references are
 * intersected with REAL transcript segment ids afterwards (in the manager),
 * so a provider can never fabricate timestamps or evidence.
 */
import type { FileAssetId } from '@veltravia/file-intelligence-core';
import { AudioIntelligenceError } from '../errors/index.js';
import type {
  AudioActionItem,
  AudioDecision,
  AudioEntity,
  AudioSummary,
  AudioSummaryStyle,
} from '../types/index.js';

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // Some models wrap JSON in prose or fences; try the first balanced object.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1));
    throw new AudioIntelligenceError('AUDIO_PROVIDER_ERROR', 'Provider output was not valid JSON.');
  }
  return tryParse(trimmed);
}
function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AudioIntelligenceError('AUDIO_PROVIDER_ERROR', 'Provider output was not valid JSON.');
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown, max: number): readonly string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];
export interface QueryAnswer {
  readonly answer: string;
  readonly supportingSegmentIds: readonly string[];
}
export function parseQueryAnswer(text: string): QueryAnswer {
  const parsed = parseJson(text) as Record<string, unknown>;
  const answer = str(parsed.answer);
  if (!answer)
    throw new AudioIntelligenceError('AUDIO_PROVIDER_ERROR', 'Provider answer was empty.');
  const ids = strList(parsed.supportingSegmentIds, 64);
  return { answer, supportingSegmentIds: ids.filter((id) => /^seg_[0-9a-f]{16}$/.test(id)) };
}

export function parseSummary(
  text: string,
  style: AudioSummaryStyle,
  providerId: string,
  fileId: FileAssetId,
): AudioSummary {
  const parsed = parseJson(text) as Record<string, unknown>;
  const summaryText = str(parsed.text) || str(parsed.summary);
  if (!summaryText)
    throw new AudioIntelligenceError('AUDIO_PROVIDER_ERROR', 'Provider summary was empty.');
  return {
    fileId,
    style,
    text: summaryText.slice(0, 20_000),
    keyPoints: strList(parsed.keyPoints, 20),
    attendees: strList(parsed.attendees, 20),
    unresolvedQuestions: strList(parsed.unresolvedQuestions, 20),
    followUps: strList(parsed.followUps, 20),
    providerId,
    trust: 'ai_generated',
  };
}

export interface ExtractionResult {
  readonly entities: readonly AudioEntity[];
  readonly actionItems: readonly AudioActionItem[];
  readonly decisions: readonly AudioDecision[];
}
const SEG_ID = /^seg_[0-9a-f]{16}$/;
export function parseExtraction(text: string): ExtractionResult {
  const parsed = parseJson(text) as Record<string, unknown>;
  const entities: AudioEntity[] = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .map((raw) => {
      const e = raw as Record<string, unknown>;
      const field = str(e.field);
      const value = str(e.value);
      const segId = str(e.segmentId);
      return {
        field,
        value,
        evidence: SEG_ID.test(segId) ? { segmentId: segId } : null,
        uncertain: e.uncertain === true,
      };
    })
    .filter((e) => e.field && e.value)
    .slice(0, 50);
  const actionItems: AudioActionItem[] = (
    Array.isArray(parsed.actionItems) ? parsed.actionItems : []
  )
    .map((raw) => {
      const a = raw as Record<string, unknown>;
      const description = str(a.description);
      const segId = str(a.segmentId);
      return {
        description,
        assignedTo: str(a.assignedTo) || null,
        deadline: str(a.deadline) || null,
        evidence: SEG_ID.test(segId) ? { segmentId: segId } : null,
        certainty: a.certainty === 'suggested' ? ('suggested' as const) : ('stated' as const),
      };
    })
    .filter((a) => a.description)
    .slice(0, 30);
  const decisions: AudioDecision[] = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map((raw) => {
      const d = raw as Record<string, unknown>;
      const statement = str(d.statement);
      const segId = str(d.segmentId);
      return {
        statement,
        evidence: SEG_ID.test(segId) ? { segmentId: segId } : null,
        certainty: d.certainty === 'probable' ? ('probable' as const) : ('stated' as const),
      };
    })
    .filter((d) => d.statement)
    .slice(0, 30);
  return { entities, actionItems, decisions };
}

export function parseTranslation(text: string): string {
  const parsed = parseJson(text) as Record<string, unknown>;
  const translated = str(parsed.text) || str(parsed.translation);
  if (!translated)
    throw new AudioIntelligenceError('AUDIO_PROVIDER_ERROR', 'Provider translation was empty.');
  return translated.slice(0, 100_000);
}
