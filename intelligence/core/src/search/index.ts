/** Cross-source search: one bounded query over every authorized source.
 *
 * Ranking is deterministic and explainable - a hit carries the terms it matched
 * and the reasons for its score, so a result never appears by magic. Identical
 * content collapses to a single hit (deduplication), and the duplicate count is
 * reported instead of hidden.
 */
import type { SourceRegistry } from '../sources/index.js';
import { assertNoSecretShape, bounded, normalizeForMatch } from '../security/index.js';
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  type IntelligenceLimits,
  type SearchHit,
  type SearchQuery,
  type SearchResponse,
  type SourceContent,
  type SourceProvider,
  type SourceType,
} from '../types/index.js';
import type { OwnerScope } from '../sources/index.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'compare',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'show',
  'summarize',
  'summarise',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
  'between',
  'about',
  'all',
  'find',
  'give',
  'list',
  'make',
  'report',
  'everything',
  'any',
  'each',
  'both',
  'more',
  'most',
  'should',
  'would',
  'could',
  'after',
  'before',
  'during',
  'over',
  'under',
  'again',
  'also',
  'than',
  'too',
  'very',
  'just',
  'only',
  'some',
]);

export function queryTerms(text: string): readonly string[] {
  const terms = normalizeForMatch(text)
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  return [...new Set(terms)].slice(0, 12);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 50) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Cheap content fingerprint for deduplication: length plus the first and last
 *  slice of the normalised text. Two sources with the same fingerprint and the
 *  same size are treated as the same content. */
export function contentFingerprint(text: string): string {
  const normalized = normalizeForMatch(text);
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

export interface CrossSourceSearchOptions {
  readonly now?: () => Date;
  readonly limits?: Partial<IntelligenceLimits>;
}

export class CrossSourceSearch {
  readonly #registry: SourceRegistry;
  readonly #limits: IntelligenceLimits;

  constructor(registry: SourceRegistry, options: CrossSourceSearchOptions = {}) {
    this.#registry = registry;
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
  }

  async search(owner: OwnerScope, query: SearchQuery): Promise<SearchResponse> {
    const text = (query.text ?? '').trim();
    assertNoSecretShape(text, 'The search query');
    const terms = queryTerms(text);
    const limit = Math.min(query.limit ?? 20, this.#limits.maxSearchResults);
    const availability = await this.#registry.availability(owner);
    const available = new Set(
      availability.filter((entry) => entry.available).map((e) => e.provider),
    );

    const sources = await this.#registry.discover(owner, {
      providers: query.providers,
      sourceTypes: query.sourceTypes,
      projectId: query.projectId,
      workspaceId: query.workspaceId,
      text: text.length > 0 ? text : null,
      limit: this.#limits.maxSourcesScanned,
    });

    const filtered = sources.filter((source) => {
      if (!available.has(source.provider)) return false;
      if (query.modifiedAfter && (!source.modifiedAt || source.modifiedAt < query.modifiedAfter))
        return false;
      if (query.modifiedBefore && (!source.modifiedAt || source.modifiedAt > query.modifiedBefore))
        return false;
      return true;
    });

    const candidates: SearchHit[] = [];
    const searchedProviders = new Set<SourceProvider>();
    let duplicatesRemoved = 0;
    let scanned = 0;

    for (const source of filtered) {
      let content: SourceContent;
      try {
        content = await this.#registry.read(owner, source.sourceId);
      } catch {
        continue;
      }
      scanned += 1;
      searchedProviders.add(source.provider);
      const hit = this.#score(content, terms, text);
      if (hit === null) continue;
      const fingerprint = contentFingerprint(content.text);
      const existing = candidates.find((candidate) => candidate.dedupeKey === fingerprint);
      if (existing) {
        duplicatesRemoved += 1;
        // Keep the better-ranked of the two, and say which one won.
        if (hit.score > existing.score) candidates[candidates.indexOf(existing)] = hit;
        continue;
      }
      candidates.push({ ...hit, dedupeKey: fingerprint });
    }

    candidates.sort(
      (a, b) => b.score - a.score || a.source.sourceId.localeCompare(b.source.sourceId),
    );
    const totalMatched = candidates.length;
    const offset = decodeCursor(query.cursor);
    const page = candidates.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      query: { ...query, text },
      hits: page,
      totalMatched,
      duplicatesRemoved,
      sourcesScanned: scanned,
      nextCursor: nextOffset < candidates.length ? encodeCursor(nextOffset) : null,
      truncated: scanned >= this.#limits.maxSourcesScanned,
      searchedProviders: [...searchedProviders],
      unavailableProviders: availability.filter((entry) => !entry.available),
    };
  }

  #score(content: SourceContent, terms: readonly string[], phrase: string): SearchHit | null {
    if (terms.length === 0) return null;
    const name = content.source.name.toLowerCase();
    const body = content.text.toLowerCase();
    const matched: string[] = [];
    const reasons: string[] = [];
    let score = 0;

    for (const term of terms) {
      const nameHits = countOccurrences(name, term);
      const bodyHits = countOccurrences(body, term);
      if (nameHits === 0 && bodyHits === 0) continue;
      matched.push(term);
      if (nameHits > 0) {
        score += 6 * nameHits;
        reasons.push(`name matches "${term}"`);
      }
      if (bodyHits > 0) {
        score += 1 + Math.log2(bodyHits + 1);
        reasons.push(`${bodyHits} occurrence${bodyHits === 1 ? '' : 's'} of "${term}"`);
      }
      const headingHit = content.segments.some(
        (segment) => segment.heading !== null && segment.heading.toLowerCase().includes(term),
      );
      if (headingHit) {
        score += 3;
        reasons.push(`heading matches "${term}"`);
      }
    }
    if (matched.length === 0) return null;

    const normalizedPhrase = normalizeForMatch(phrase);
    if (normalizedPhrase.length >= 4 && normalizeForMatch(body).includes(normalizedPhrase)) {
      score += 4;
      reasons.push('exact phrase match');
    }
    if (content.source.freshness.stale) {
      score -= 1;
      reasons.push('source is stale');
    }

    const located = this.#snippet(content, matched);
    return {
      source: content.source,
      score: Number(score.toFixed(3)),
      matchedTerms: matched,
      snippet: located.snippet,
      locator: located.locator,
      reasons,
      dedupeKey: '',
    };
  }

  #snippet(content: SourceContent, terms: readonly string[]) {
    const fallback = content.segments[0];
    for (const segment of content.segments) {
      const lower = segment.text.toLowerCase();
      if (terms.some((term) => lower.includes(term))) {
        return { snippet: bounded(segment.text, 240), locator: segment.locator };
      }
    }
    if (content.segments.length === 0)
      return {
        snippet: '',
        locator: {
          kind: 'line' as const,
          label: 'line 1',
          section: null,
          path: null,
          line: 1,
          start: 0,
          end: 0,
        },
      };
    return { snippet: bounded(fallback!.text, 240), locator: fallback!.locator };
  }
}

function encodeCursor(offset: number): string {
  return `o${offset}`;
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^o(\d{1,6})$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

export type { SourceType };
