/** Bounded, ceiling-clamped limits for Document Intelligence. Nothing is
 *  unbounded; configured values are clamped, never trusted raw. */
import type { DocumentLimits } from '../types/index.js';

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxElements: 4000,
  maxSections: 300,
  maxTables: 100,
  maxTableRows: 200,
  maxSheetRows: 2000,
  maxSlides: 50,
  maxSearchMatches: 100,
  maxEvidenceQuotes: 6,
  maxAnswerChars: 6000,
  maxEntities: 60,
  maxOcrChars: 100_000,
  maxConcurrentProviderCalls: 4,
  maxProcessingMs: 120_000,
  jobExpiryMs: 86_400_000,
};

/** Hard ceilings. No configuration may exceed these. */
export const DOCUMENT_LIMIT_CEILINGS: DocumentLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxElements: 20_000,
  maxSections: 2000,
  maxTables: 500,
  maxTableRows: 2000,
  maxSheetRows: 20_000,
  maxSlides: 500,
  maxSearchMatches: 500,
  maxEvidenceQuotes: 20,
  maxAnswerChars: 50_000,
  maxEntities: 300,
  maxOcrChars: 500_000,
  maxConcurrentProviderCalls: 16,
  maxProcessingMs: 600_000,
  jobExpiryMs: 7 * 24 * 60 * 60 * 1000,
};

type LimitsKey = keyof DocumentLimits;

function clamp(key: LimitsKey, value: number | undefined): number {
  if (value === undefined) return DEFAULT_DOCUMENT_LIMITS[key];
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DOCUMENT_LIMITS[key];
  return Math.min(Math.floor(value), DOCUMENT_LIMIT_CEILINGS[key]);
}

export function resolveDocumentLimits(overrides?: Partial<DocumentLimits>): DocumentLimits {
  const keys = Object.keys(DEFAULT_DOCUMENT_LIMITS) as readonly LimitsKey[];
  const out = {} as Record<LimitsKey, number>;
  for (const key of keys) out[key] = clamp(key, overrides?.[key]);
  return out as DocumentLimits;
}
