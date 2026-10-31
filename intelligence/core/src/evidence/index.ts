/** Evidence extraction and citation validation.
 *
 * An evidence reference is only ever created from text that appears verbatim in
 * the retrieved source. Before an answer is returned, every excerpt is
 * re-checked against that source; a quote that does not appear is marked
 * unverified and the claim that relied on it is downgraded. Nothing is invented.
 */
import { bounded, excerptAppearsIn, normalizeForMatch, redactSecrets } from '../security/index.js';
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  UNTRUSTED,
  type Claim,
  type EvidenceRef,
  type IntelligenceLimits,
  type SourceContent,
} from '../types/index.js';

export function selectExcerpt(
  content: SourceContent,
  terms: readonly string[],
  maxChars: number,
): { text: string; index: number } | null {
  for (const [index, segment] of content.segments.entries()) {
    const lower = segment.text.toLowerCase();
    if (terms.some((term) => lower.includes(term)))
      return { text: bounded(segment.text, maxChars), index };
  }
  const first = content.segments[0];
  return first ? { text: bounded(first.text, maxChars), index: 0 } : null;
}

export interface EvidenceExtractionOptions {
  readonly limits?: Partial<IntelligenceLimits>;
  readonly secretCheck?: boolean;
}

export class EvidenceCollector {
  readonly #limits: IntelligenceLimits;
  readonly #items: EvidenceRef[] = [];
  readonly #byId = new Map<string, EvidenceRef>();
  readonly #contents = new Map<string, SourceContent>();

  constructor(options: EvidenceExtractionOptions = {}) {
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
  }

  get size(): number {
    return this.#items.length;
  }

  /** Adds up to `maxPerSource` excerpts from one source that contain the query
   *  terms. Returns the created references. */
  add(content: SourceContent, terms: readonly string[], maxPerSource = 2): readonly EvidenceRef[] {
    if (!this.#contents.has(content.source.sourceId))
      this.#contents.set(content.source.sourceId, content);
    const added: EvidenceRef[] = [];
    const used = new Set<string>();
    for (const segment of content.segments) {
      if (added.length >= maxPerSource) break;
      if (this.#items.length >= this.#limits.maxEvidence) break;
      const lower = segment.text.toLowerCase();
      const relevant = terms.length === 0 || terms.some((term) => lower.includes(term));
      if (!relevant) continue;
      if (used.has(segment.segmentId)) continue;
      used.add(segment.segmentId);
      const evidenceId = `ev:${content.source.sourceId}:${segment.segmentId}`;
      const existing = this.#byId.get(evidenceId);
      if (existing) {
        added.push(existing);
        continue;
      }
      const ref: EvidenceRef = {
        evidenceId,
        sourceId: content.source.sourceId,
        provider: content.source.provider,
        resourceName: content.source.name,
        locator: segment.locator,
        excerpt: redactSecrets(bounded(segment.text, this.#limits.maxExcerptChars)),
        revision: content.source.contentVersion,
        retrievedAt: content.source.retrievedAt,
        trustTag: UNTRUSTED,
        verified: true,
      };
      this.#items.push(ref);
      this.#byId.set(evidenceId, ref);
      added.push(ref);
    }
    // Fall back to the first segment so a source can still be cited honestly.
    if (added.length === 0 && this.#items.length < this.#limits.maxEvidence) {
      const first = content.segments[0];
      if (first) {
        const evidenceId = `ev:${content.source.sourceId}:${first.segmentId}`;
        const existing = this.#byId.get(evidenceId);
        if (existing) return [existing];
        const ref: EvidenceRef = {
          evidenceId,
          sourceId: content.source.sourceId,
          provider: content.source.provider,
          resourceName: content.source.name,
          locator: first.locator,
          excerpt: redactSecrets(bounded(first.text, this.#limits.maxExcerptChars)),
          revision: content.source.contentVersion,
          retrievedAt: content.source.retrievedAt,
          trustTag: UNTRUSTED,
          verified: true,
        };
        this.#items.push(ref);
        this.#byId.set(evidenceId, ref);
        return [ref];
      }
    }
    return added;
  }

  get(evidenceId: string): EvidenceRef | null {
    return this.#byId.get(evidenceId) ?? null;
  }

  all(): readonly EvidenceRef[] {
    return [...this.#items];
  }

  contentFor(sourceId: string): SourceContent | null {
    return this.#contents.get(sourceId) ?? null;
  }

  /** Re-checks every excerpt against the retrieved text. Returns the verified
   *  set; unverified references are dropped from answers (never shown as fact). */
  verify(): { readonly verified: readonly EvidenceRef[]; readonly rejected: number } {
    const verified: EvidenceRef[] = [];
    let rejected = 0;
    for (const item of this.#items) {
      const content = this.#contents.get(item.sourceId);
      if (!content) {
        rejected += 1;
        continue;
      }
      if (excerptAppearsIn(content.text, item.excerpt)) verified.push(item);
      else rejected += 1;
    }
    return { verified, rejected };
  }
}

/** Claim construction: a claim can only cite evidence that exists, and a claim
 *  built from evidence is never labelled verified without it. */
export function buildClaim(input: {
  readonly claimId: string;
  readonly statement: string;
  readonly kind: Claim['kind'];
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
  readonly knownEvidence: ReadonlySet<string>;
}): Claim {
  const kept = input.evidenceIds.filter((id) => input.knownEvidence.has(id));
  const kind: Claim['kind'] =
    input.kind === 'unsupported' || kept.length > 0 ? input.kind : 'unsupported';
  return {
    claimId: input.claimId,
    statement: bounded(redactSecrets(input.statement), 600),
    kind,
    evidenceIds: kept,
    confidence: kind === 'unsupported' ? Math.min(input.confidence, 0.25) : input.confidence,
  };
}

export function dedupeStatements(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalizeForMatch(value);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
