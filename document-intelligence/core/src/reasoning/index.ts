/** Parsers that turn provider output into safe, bounded Veltravia structures.
 *
 *  Rules enforced here:
 *  - Provider output is text: only bare JSON objects are accepted, never
 *    markdown, never prose preambles.
 *  - Evidence quotes and references coming back from a provider are
 *    untrusted; quotes survive only when they genuinely appear in the
 *    parsed structure, and refs only when they match manager-owned ids.
 *  - Arrays are capped with an explicit omission marker.
 *  - Result objects carry trust tags: untrusted_data (extracted text, OCR)
 *    vs ai_generated (interpretation). */
import { DocumentIntelligenceError } from '../errors/index.js';
import type {
  DocumentAnswerView,
  DocumentComparisonPoint,
  DocumentComparisonView,
  DocumentElement,
  DocumentEntitiesView,
  DocumentEntity,
  DocumentEvidenceQuote,
  DocumentSearchMatch,
  DocumentStructureView,
  DocumentSummaryMode,
  DocumentSummaryView,
  SourceRef,
} from '../types/index.js';

const MAX_ITEMS = 200;
const MAX_STRING = 8000;
const OMIT = 'OTHER-DATA-OMITTED';

const ENTITY_TYPES = [
  'person',
  'organization',
  'location',
  'date',
  'amount',
  'product',
  'event',
  'identifier',
  'other',
  'unknown',
] as const;

/** Accept ONLY a bare JSON object. No fences, no prose, no arrays. */
export function parseProviderJson(text: string): Record<string, unknown> {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}'))
    throw new DocumentIntelligenceError(
      'DOCUMENT_PROVIDER_ERROR',
      'Provider output was not a bare JSON object.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DocumentIntelligenceError(
      'DOCUMENT_PROVIDER_ERROR',
      'Provider output was not valid JSON.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new DocumentIntelligenceError(
      'DOCUMENT_PROVIDER_ERROR',
      'Provider output was not a JSON object.',
    );
  return parsed as Record<string, unknown>;
}

export function truncateText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export interface ReasoningLimits {
  readonly maxAnswerChars: number;
  readonly maxEvidenceQuotes: number;
  readonly maxEntities: number;
  readonly maxSearchMatches: number;
}

function str(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? truncateText(value, max) : fallback;
}

function refOfElement(element: DocumentElement | undefined): SourceRef | null {
  if (!element) return null;
  return element.ref;
}

/** Validate a provider-claimed evidence quote against the real structure.
 *  Forged quotes (not present in any element) are DROPPED, not trusted. */
export function validateEvidenceQuote(
  structure: DocumentStructureView,
  quote: string,
): DocumentEvidenceQuote | null {
  const normalized = quote.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 2000) return null;
  const corpus = corpusText(structure);
  if (!corpus.includes(normalized)) return null;
  const element = structure.elements.find((e) => e.text.replace(/\s+/g, ' ').includes(normalized));
  const ref = refOfElement(element) ?? {
    kind: 'element' as const,
    id: 'unknown',
    label: 'Document',
  };
  return { quote: normalized, ref };
}

function corpusText(structure: DocumentStructureView): string {
  return structure.elements.map((e) => e.text.replace(/\s+/g, ' ')).join(' \n ');
}

function parseEvidence(
  structure: DocumentStructureView,
  raw: unknown,
  limits: ReasoningLimits,
): readonly DocumentEvidenceQuote[] {
  const out: DocumentEvidenceQuote[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw.slice(0, limits.maxEvidenceQuotes * 3)) {
    const quoteText =
      typeof item === 'string' ? item : str((item as Record<string, unknown>)?.quote, 2000);
    const validated = validateEvidenceQuote(structure, quoteText);
    if (validated) out.push(validated);
    if (out.length >= limits.maxEvidenceQuotes) break;
  }
  return out;
}

function parseConfidence(raw: unknown): 'low' | 'medium' | 'high' {
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'low';
}

export function parseAnswer(
  structure: DocumentStructureView,
  question: string,
  raw: Record<string, unknown>,
  limits: ReasoningLimits,
): DocumentAnswerView {
  const answer = str(raw.answer, limits.maxAnswerChars).trim();
  if (!answer)
    throw new DocumentIntelligenceError('DOCUMENT_PROVIDER_ERROR', 'Provider answer was empty.');
  const claimed = Array.isArray(raw.evidence) ? raw.evidence.length : 0;
  const evidence = parseEvidence(structure, raw.evidence, limits);
  // Claimed evidence that does not exist in the document is never shown as
  // support: the answer is annotated and its confidence is forced low.
  const unverified = claimed > 0 && evidence.length === 0;
  return {
    fileId: structure.fileId,
    question: truncateText(question, 2000),
    answer: unverified
      ? `${answer} (No quoted passage could be verified in the document, so this answer cannot be treated as confirmed.)`
      : answer,
    evidence,
    confidence: unverified ? 'low' : parseConfidence(raw.confidence),
    trustTag: 'ai_generated',
  };
}

export function parseSummary(
  structure: DocumentStructureView,
  mode: DocumentSummaryMode,
  raw: Record<string, unknown>,
  limits: ReasoningLimits,
): DocumentSummaryView {
  const summary = str(raw.summary, limits.maxAnswerChars).trim();
  if (!summary)
    throw new DocumentIntelligenceError('DOCUMENT_PROVIDER_ERROR', 'Provider summary was empty.');
  return {
    fileId: structure.fileId,
    mode,
    summary,
    trustTag: 'ai_generated',
  };
}

export function parseEntities(
  structure: DocumentStructureView,
  raw: Record<string, unknown>,
  limits: ReasoningLimits,
): DocumentEntitiesView {
  const out: DocumentEntity[] = [];
  if (Array.isArray(raw.entities)) {
    for (const item of raw.entities.slice(0, limits.maxEntities * 2)) {
      if (typeof item !== 'object' || item === null) continue;
      const name = str((item as Record<string, unknown>).name, 200).trim();
      const rawType = str((item as Record<string, unknown>).type, 60, 'unknown');
      const type = ENTITY_TYPES.includes(rawType as (typeof ENTITY_TYPES)[number])
        ? (rawType as (typeof ENTITY_TYPES)[number])
        : 'unknown';
      if (name) out.push({ name, type });
      if (out.length >= limits.maxEntities) break;
    }
  }
  return { fileId: structure.fileId, entities: out, trustTag: 'ai_generated' };
}

export function parseComparison(
  left: DocumentStructureView,
  right: DocumentStructureView,
  raw: Record<string, unknown>,
  limits: ReasoningLimits,
): DocumentComparisonView {
  const summary = str(raw.summary, limits.maxAnswerChars).trim();
  if (!summary)
    throw new DocumentIntelligenceError(
      'DOCUMENT_PROVIDER_ERROR',
      'Provider comparison was empty.',
    );
  const points: DocumentComparisonPoint[] = [];
  if (Array.isArray(raw.points)) {
    for (const item of raw.points.slice(0, MAX_ITEMS)) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const label = str(record.label, 200);
      const leftValue = str(record.left, 2000);
      const rightValue = str(record.right, 2000);
      if (label && leftValue && rightValue)
        points.push({ label, left: leftValue, right: rightValue });
      if (points.length >= 20) break;
    }
  }
  return {
    leftFileId: left.fileId,
    rightFileId: right.fileId,
    summary,
    points,
    trustTag: 'ai_generated',
  };
}

export function parseSemanticSearch(
  structure: DocumentStructureView,
  raw: Record<string, unknown>,
  limits: ReasoningLimits,
): readonly DocumentSearchMatch[] {
  const out: DocumentSearchMatch[] = [];
  if (Array.isArray(raw.matches)) {
    for (const item of raw.matches.slice(0, limits.maxSearchMatches * 2)) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const elementId = typeof record.elementId === 'string' ? record.elementId : '';
      const element = structure.elements.find((e) => e.id === elementId);
      if (!element) continue; // forged id dropped
      const snippet = str(record.snippet, 600, element.text.slice(0, 600));
      const score = typeof record.score === 'number' && record.score >= 0 ? record.score : 0;
      out.push({ elementId: element.id, snippet, score });
      if (out.length >= limits.maxSearchMatches) break;
    }
  }
  return out;
}

export const REASONING_OMIT_MARKER = OMIT;
export const REASONING_MAX_STRING = MAX_STRING;
