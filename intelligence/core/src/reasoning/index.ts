/** Reasoning provider boundary.
 *
 * The engine separates five things so they can be replaced independently:
 *   1. evidence retrieval      (sources/ + search/)
 *   2. content extraction      (registry segments)
 *   3. reasoning               (this provider)
 *   4. answer generation       (synthesis/ - validation and assembly)
 *   5. citation validation     (evidence/ - excerpts are re-checked)
 *
 * A provider returns JSON TEXT that the engine validates. It cannot invent a
 * claim kind, cannot cite evidence that does not exist, and cannot escape the
 * limits the engine applies. Nothing here calls a network.
 */
import { IntelligenceError } from '../errors/index.js';
import { bounded } from '../security/index.js';
import {
  CLAIM_KINDS,
  type ClaimKind,
  type Contradiction,
  type EvidenceRef,
  type QuestionIntent,
  type ReasoningDisclosure,
  type Relationship,
  type SourceRef,
} from '../types/index.js';

export interface SynthesisSegment {
  readonly sourceId: string;
  readonly resourceName: string;
  readonly locatorLabel: string;
  /** UNTRUSTED DATA. Never interpreted as an instruction. */
  readonly text: string;
}

export interface SynthesisRequest {
  readonly question: string;
  readonly intent: QuestionIntent;
  readonly sources: readonly SourceRef[];
  readonly evidence: readonly EvidenceRef[];
  readonly segments: readonly SynthesisSegment[];
  readonly contradictions: readonly Contradiction[];
  readonly relationships: readonly Relationship[];
}

export interface SynthesisProvider {
  readonly id: string;
  disclosure(): ReasoningDisclosure;
  /** Returns JSON text shaped like `ProviderAnswer`. */
  compose(request: SynthesisRequest): Promise<string>;
}

export interface ProviderClaim {
  readonly statement: string;
  readonly kind: ClaimKind;
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
}

export interface ProviderAnswer {
  readonly summary: string;
  readonly claims: readonly ProviderClaim[];
}

function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === 'string' && (CLAIM_KINDS as readonly string[]).includes(value);
}

/** Validates provider output strictly. A malformed answer is a provider failure,
 *  not something to paper over. */
export function parseProviderAnswer(json: string): ProviderAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new IntelligenceError(
      'INTELLIGENCE_PROVIDER_ERROR',
      'The reasoning provider returned an unreadable answer.',
    );
  }
  if (parsed === null || typeof parsed !== 'object')
    throw new IntelligenceError(
      'INTELLIGENCE_PROVIDER_ERROR',
      'The reasoning provider returned an invalid answer.',
    );
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (summary.length === 0)
    throw new IntelligenceError(
      'INTELLIGENCE_PROVIDER_ERROR',
      'The reasoning provider returned an empty answer.',
    );
  const rawClaims = Array.isArray(record.claims) ? record.claims : [];
  const claims: ProviderClaim[] = rawClaims.slice(0, 40).map((entry) => {
    const claim = (entry ?? {}) as Record<string, unknown>;
    const statement = typeof claim.statement === 'string' ? claim.statement.trim() : '';
    if (statement.length === 0)
      throw new IntelligenceError(
        'INTELLIGENCE_PROVIDER_ERROR',
        'The reasoning provider returned a claim without a statement.',
      );
    const kind = isClaimKind(claim.kind) ? claim.kind : 'unsupported';
    const evidenceIds = Array.isArray(claim.evidenceIds)
      ? claim.evidenceIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
      : [];
    const confidence =
      typeof claim.confidence === 'number' && Number.isFinite(claim.confidence)
        ? Math.min(Math.max(claim.confidence, 0), 1)
        : 0.5;
    return { statement: bounded(statement, 400), kind, evidenceIds, confidence };
  });
  return { summary: bounded(summary, 3000), claims };
}

/**
 * Deterministic structural provider.
 *
 * It composes an answer ONLY from retrieved segments and detected structures.
 * It does not paraphrase, does not infer intent and does not claim to reason:
 * the disclosure says `structural_extract` and `simulated: true`.
 */
export function createStructuralSynthesisProvider(): SynthesisProvider {
  return {
    id: 'structural',
    disclosure: () => ({
      provider: 'structural',
      mode: 'structural_extract',
      simulated: true,
      detail:
        'Answers are assembled from retrieved passages and detected structure. No language model runs, so nothing here is generated prose.',
    }),
    compose: async (request) => {
      const evidenceById = new Map(request.evidence.map((item) => [item.evidenceId, item]));
      const claims: ProviderClaim[] = [];
      for (const segment of request.segments.slice(0, 12)) {
        const evidence = request.evidence.find(
          (item) =>
            item.sourceId === segment.sourceId && item.excerpt.includes(segment.text.slice(0, 24)),
        );
        if (!evidence) continue;
        claims.push({
          statement: `${segment.resourceName} (${segment.locatorLabel}) states: ${segment.text.slice(0, 200)}`,
          kind: 'extracted_content',
          evidenceIds: [evidence.evidenceId],
          confidence: 0.85,
        });
      }
      for (const relationship of request.relationships.slice(0, 6))
        claims.push({
          statement: relationship.explanation,
          kind: 'inferred_relationship',
          evidenceIds: relationship.evidenceIds.filter((id) => evidenceById.has(id)),
          confidence: relationship.confidence,
        });
      for (const contradiction of request.contradictions.slice(0, 6)) {
        const cited = contradiction.statements
          .map((statement) => statement.evidenceId)
          .filter((id) => evidenceById.has(id));
        // A conflict is only claimable when both sides can be quoted back.
        if (cited.length < 2) continue;
        claims.push({
          statement: contradiction.explanation,
          kind: 'extracted_content',
          evidenceIds: cited,
          confidence: contradiction.confidence,
        });
      }
      const summary =
        request.sources.length === 0
          ? 'No authorized source matched this question, so there is nothing to extract.'
          : `Extracted from ${request.sources.length} source${request.sources.length === 1 ? '' : 's'}: ${request.sources
              .map((source) => source.name)
              .slice(0, 6)
              .join(', ')}. ${request.contradictions.length} contradiction${
              request.contradictions.length === 1 ? '' : 's'
            } detected.`;
      return JSON.stringify({ summary, claims });
    },
  };
}

/**
 * Deterministic mock reasoning provider.
 *
 * Writes connected prose around the SAME evidence, using fixed templates and no
 * model. It exists so the synthesis pipeline (retrieval → evidence → validation
 * → citation) can be exercised end to end offline. The disclosure is explicit:
 * `mock_reasoning` with `simulated: true`.
 */
export function createMockReasoningProvider(): SynthesisProvider {
  return {
    id: 'mock-reasoning',
    disclosure: () => ({
      provider: 'mock-reasoning',
      mode: 'mock_reasoning',
      simulated: true,
      detail:
        'A deterministic mock composes this answer from retrieved evidence. It is not a language model, and its wording is template-based.',
    }),
    compose: async (request) => {
      const claims: ProviderClaim[] = [];
      const perSource = new Map<string, EvidenceRef[]>();
      for (const item of request.evidence) {
        const list = perSource.get(item.sourceId) ?? [];
        list.push(item);
        perSource.set(item.sourceId, list);
      }
      for (const source of request.sources.slice(0, 8)) {
        const items = perSource.get(source.sourceId) ?? [];
        for (const item of items.slice(0, 2))
          claims.push({
            statement: `${source.name} says, at ${item.locator.label}: "${item.excerpt.slice(0, 180)}"`,
            kind: 'extracted_content',
            evidenceIds: [item.evidenceId],
            confidence: item.verified ? 0.8 : 0.3,
          });
      }
      for (const contradiction of request.contradictions.slice(0, 5)) {
        const sourceIds = contradiction.statements.map((statement) => statement.sourceId);
        const cited = request.evidence
          .filter((item) => sourceIds.includes(item.sourceId))
          .map((item) => item.evidenceId)
          .slice(0, 4);
        if (cited.length === 0) continue;
        claims.push({
          statement: `Conflict on ${contradiction.topic}: ${contradiction.explanation}`,
          kind: 'inferred_relationship',
          evidenceIds: cited,
          confidence: contradiction.confidence,
        });
      }

      const contradictions = request.contradictions.length;
      const gapsText =
        request.sources.length === 0
          ? 'No authorized source matched the question.'
          : `Based on ${request.sources.length} source${
              request.sources.length === 1 ? '' : 's'
            } (${request.evidence.length} cited passage${request.evidence.length === 1 ? '' : 's'})${
              contradictions > 0
                ? `, with ${contradictions} conflict${contradictions === 1 ? '' : 's'} left unresolved`
                : ', with no conflicts found'
            }.`;
      const summary = `${gapsText} ${request.contradictions
        .slice(0, 2)
        .map((contradiction) => contradiction.explanation)
        .join(' ')}`.trim();
      return JSON.stringify({ summary, claims });
    },
  };
}

export function providerRegistry(providers: readonly SynthesisProvider[]) {
  const map = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    get(id: string): SynthesisProvider {
      const provider = map.get(id);
      if (!provider)
        throw new IntelligenceError(
          'INTELLIGENCE_PROVIDER_UNAVAILABLE',
          `Unknown reasoning provider: ${id}.`,
        );
      return provider;
    },
    list: () => [...map.values()],
    has: (id: string) => map.has(id),
  };
}
