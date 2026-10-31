/** The synthesis engine: question in, evidence-backed structured answer out.
 *
 * Pipeline (each step bounded and separately testable):
 *   question -> intent -> cross-source search -> content retrieval -> evidence
 *   -> relationships -> contradictions -> reasoning provider -> claim validation
 *   -> citation verification -> gaps -> answer
 *
 * The engine never fabricates evidence. A claim survives only if the evidence it
 * cites exists AND the quoted excerpt is found in the retrieved text.
 */
import { IntelligenceError, invalidRequest } from '../errors/index.js';
import { assertNoSecretShape, bounded, redactSecrets } from '../security/index.js';
import { CrossSourceSearch, queryTerms } from '../search/index.js';
import { EvidenceCollector, buildClaim } from '../evidence/index.js';
import { RelationshipGraph, buildRelationships } from '../relationships/index.js';
import { ContradictionDetector } from '../contradictions/index.js';
import {
  parseProviderAnswer,
  type SynthesisProvider,
  type SynthesisSegment,
} from '../reasoning/index.js';
import type { OwnerScope, SourceRegistry } from '../sources/index.js';
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  type InformationGap,
  type Claim,
  type ComparisonResult,
  type IntelligenceLimits,
  type QuestionIntent,
  type ReasoningDisclosure,
  type SourceContent,
  type SourceProvider,
  type SourceType,
  type SynthesisAnswer,
} from '../types/index.js';

const INTENT_RULES: readonly { readonly intent: QuestionIntent; readonly pattern: RegExp }[] = [
  { intent: 'compare', pattern: /\bcompare|difference|differ|versus|\bvs\.?\b|against\b/i },
  {
    intent: 'contradictions',
    pattern: /\bcontradict|conflict|inconsisten|disagree|contradiction|mismatch\b/i,
  },
  { intent: 'changes', pattern: /\bwhat changed|changed between|diff since|newer|updated\b/i },
  { intent: 'summarize', pattern: /\bsummar|overview|brief|everything (?:i|we) have\b/i },
];

export function detectIntent(question: string): QuestionIntent {
  for (const rule of INTENT_RULES) if (rule.pattern.test(question)) return rule.intent;
  return 'find';
}

export interface SynthesisRequestOptions {
  readonly providers?: readonly SourceProvider[];
  readonly sourceTypes?: readonly SourceType[];
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly sourceIds?: readonly string[];
  readonly limit?: number;
  readonly reasoningProviderId?: string;
}

export interface IntelligenceEngineOptions {
  readonly registry: SourceRegistry;
  readonly reasoning: SynthesisProvider;
  readonly limits?: Partial<IntelligenceLimits>;
  readonly now?: () => Date;
  readonly audit?: (event: {
    readonly type: string;
    readonly ownerRef: string;
    readonly detail: string | null;
    readonly count: number | null;
  }) => void;
}

export class IntelligenceEngine {
  readonly #registry: SourceRegistry;
  readonly #search: CrossSourceSearch;
  readonly #reasoning: SynthesisProvider;
  readonly #limits: IntelligenceLimits;
  readonly #now: () => Date;
  readonly #audit: IntelligenceEngineOptions['audit'];

  constructor(options: IntelligenceEngineOptions) {
    this.#registry = options.registry;
    this.#search = new CrossSourceSearch(options.registry, { limits: options.limits });
    this.#reasoning = options.reasoning;
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
    this.#now = options.now ?? (() => new Date());
    this.#audit = options.audit;
  }

  get registry(): SourceRegistry {
    return this.#registry;
  }

  get reasoning(): ReasoningDisclosure {
    return this.#reasoning.disclosure();
  }

  async search(owner: OwnerScope, query: Parameters<CrossSourceSearch['search']>[1]) {
    assertNoSecretShape(query.text ?? '', 'The search query');
    return this.#search.search(owner, query);
  }

  /** Loads contents for the sources a search selected, bounded in count and
   *  bytes. A source that cannot be read is skipped, never faked. */
  async #loadContents(
    owner: OwnerScope,
    sourceIds: readonly string[],
  ): Promise<readonly SourceContent[]> {
    const contents: SourceContent[] = [];
    for (const sourceId of sourceIds.slice(0, this.#limits.maxSourcesScanned)) {
      try {
        contents.push(await this.#registry.read(owner, sourceId));
      } catch {
        continue;
      }
    }
    return contents;
  }

  async synthesize(
    owner: OwnerScope,
    question: string,
    options: SynthesisRequestOptions = {},
  ): Promise<SynthesisAnswer> {
    const text = (question ?? '').trim();
    if (text.length === 0) throw invalidRequest('A question is required.');
    if (text.length > 500) throw invalidRequest('The question must be at most 500 characters.');
    assertNoSecretShape(text, 'The question');
    const started = Date.now();
    const intent = detectIntent(text);
    const terms = queryTerms(text);

    let sourceIds: readonly string[];
    let unavailableProviders: SynthesisAnswer['unavailableProviders'] = [];
    let searchedProviders: readonly SourceProvider[];
    let truncated = false;

    if (options.sourceIds && options.sourceIds.length > 0) {
      // Explicit selection: verify each id is discoverable for this owner.
      const scope = new Set(
        (await this.#registry.discover(owner, { limit: this.#limits.maxSourcesListed })).map(
          (source) => source.sourceId,
        ),
      );
      sourceIds = options.sourceIds.filter((id) => scope.has(id));
      if (sourceIds.length === 0)
        throw new IntelligenceError(
          'INTELLIGENCE_SOURCE_NOT_FOUND',
          'None of those sources belong to this owner.',
        );
      searchedProviders = [
        ...new Set(sourceIds.map((id) => id.slice(0, id.indexOf(':')) as SourceProvider)),
      ];
    } else {
      const response = await this.#search.search(owner, {
        text,
        providers: options.providers,
        sourceTypes: options.sourceTypes,
        projectId: options.projectId ?? null,
        workspaceId: options.workspaceId ?? null,
        limit: options.limit ?? 10,
      });
      sourceIds = response.hits.map((hit) => hit.source.sourceId);
      unavailableProviders = response.unavailableProviders;
      searchedProviders = response.searchedProviders;
      truncated = response.truncated;
    }

    const contents = await this.#loadContents(owner, sourceIds);
    const collector = new EvidenceCollector({ limits: this.#limits });
    for (const content of contents) {
      collector.add(content, terms, intent === 'compare' ? 3 : 2);
      if (Date.now() - started > this.#limits.synthesisTimeoutMs)
        throw new IntelligenceError(
          'INTELLIGENCE_TIMEOUT',
          'The analysis took longer than the allowed time. Narrow the question or the sources.',
        );
    }

    const graph = buildRelationships(contents, new RelationshipGraph({ limits: this.#limits }));
    const contradictions = new ContradictionDetector({ limits: this.#limits }).detect(
      contents,
      collector.all(),
    );
    const { verified, rejected } = collector.verify();

    const segments: SynthesisSegment[] = [];
    for (const content of contents) {
      for (const segment of content.segments.slice(0, 4))
        segments.push({
          sourceId: content.source.sourceId,
          resourceName: content.source.name,
          locatorLabel: segment.locator.label,
          text: bounded(segment.text, 400),
        });
    }
    segments.length = Math.min(segments.length, 16);

    let claims: readonly Claim[] = [];
    let summary: string;
    if (contents.length > 0) {
      const answerJson = await this.#reasoning.compose({
        question: text,
        intent,
        sources: contents.map((content) => content.source),
        evidence: verified,
        segments,
        contradictions,
        relationships: graph.relationships().slice(0, 12),
      });
      const parsed = parseProviderAnswer(answerJson);
      const known = new Set(verified.map((item) => item.evidenceId));
      claims = parsed.claims.slice(0, this.#limits.maxClaims).map((claim, index) =>
        buildClaim({
          claimId: `c${index + 1}`,
          statement: claim.statement,
          kind: claim.kind,
          evidenceIds: claim.evidenceIds,
          confidence: claim.confidence,
          knownEvidence: known,
        }),
      );
      summary = redactSecrets(parsed.summary);
    } else {
      summary =
        'No authorized source matched this question. Nothing is reported here because there is no evidence to cite.';
    }

    const gaps: InformationGap[] = [];
    if (contents.length === 0)
      gaps.push({
        gapId: 'gap:no-source',
        kind: 'no_source',
        description: 'No authorized source matched the question.',
        sourceIds: [],
      });
    if (truncated)
      gaps.push({
        gapId: 'gap:not-retrieved',
        kind: 'not_retrieved',
        description: 'Only the first page of matching sources was examined.',
        sourceIds: [],
      });
    for (const provider of unavailableProviders)
      gaps.push({
        gapId: `gap:provider:${provider.provider}`,
        kind: 'unavailable_provider',
        description: `${provider.provider} was not searched: ${provider.detail}`,
        sourceIds: [],
      });
    if (rejected > 0)
      gaps.push({
        gapId: 'gap:unsupported-claim',
        kind: 'unsupported_claim',
        description: `${rejected} extracted passage${rejected === 1 ? '' : 's'} could not be verified against the source and ${rejected === 1 ? 'was' : 'were'} withheld.`,
        sourceIds: [],
      });
    for (const content of contents)
      if (content.source.freshness.stale)
        gaps.push({
          gapId: `gap:stale:${content.source.sourceId}`,
          kind: 'stale_source',
          description: `${content.source.name} is older than the freshness window.`,
          sourceIds: [content.source.sourceId],
        });

    const hasEvidence = verified.length > 0 && claims.some((claim) => claim.kind !== 'unsupported');
    const status: SynthesisAnswer['status'] =
      contents.length === 0
        ? 'no_evidence'
        : hasEvidence && rejected === 0
          ? 'answered'
          : 'partial';

    this.#audit?.({
      type: 'intelligence_synthesis',
      ownerRef: owner.ownerRef,
      detail: `${intent}:${status}`,
      count: contents.length,
    });

    return {
      question: text,
      intent,
      status,
      summary: bounded(summary, 2000),
      claims,
      contradictions,
      relationships: graph.relationships(),
      gaps,
      sources: contents.map((content) => content.source),
      evidence: verified,
      reasoning: this.#reasoning.disclosure(),
      searchedProviders,
      unavailableProviders,
      generatedAt: this.#now().toISOString(),
      truncated: truncated || graph.truncated,
    };
  }

  /** Two-or-more document comparison. Agreements are shared headings; conflicts
   *  come from the same deterministic detector, never from a guess. */
  async compare(owner: OwnerScope, sourceIds: readonly string[]): Promise<ComparisonResult> {
    if (sourceIds.length < 2 || sourceIds.length > 5)
      throw invalidRequest('Compare between 2 and 5 sources.');
    const scope = new Set(
      (await this.#registry.discover(owner, { limit: this.#limits.maxSourcesListed })).map(
        (source) => source.sourceId,
      ),
    );
    const allowed = sourceIds.filter((id) => scope.has(id));
    if (allowed.length < 2)
      throw new IntelligenceError(
        'INTELLIGENCE_SOURCE_NOT_FOUND',
        'Those sources are not available to this owner.',
      );
    const contents = await this.#loadContents(owner, allowed);
    if (contents.length < 2)
      throw new IntelligenceError(
        'INTELLIGENCE_SOURCE_NOT_FOUND',
        'Those sources could not be read.',
      );

    const collector = new EvidenceCollector({ limits: this.#limits });
    for (const content of contents) collector.add(content, [], 2);
    const { verified } = collector.verify();
    const known = new Set(verified.map((item) => item.evidenceId));

    const outlineOf = (content: SourceContent) => {
      const headings = content.segments
        .map((segment) => segment.heading)
        .filter((heading): heading is string => heading !== null);
      return [...new Set(headings)].slice(0, 12);
    };
    const participants = contents.map((content) => ({
      source: content.source,
      evidence: verified.filter((item) => item.sourceId === content.source.sourceId),
      outline: outlineOf(content),
      wordCount: content.text.split(/\s+/).filter(Boolean).length,
    }));

    const headingCounts = new Map<string, string[]>();
    for (const participant of participants)
      for (const heading of participant.outline) {
        const key = heading.toLowerCase();
        const list = headingCounts.get(key) ?? [];
        if (!list.includes(participant.source.sourceId)) list.push(participant.source.sourceId);
        headingCounts.set(key, list);
      }
    const agreements: Claim[] = [];
    let index = 0;
    for (const [heading, sourceIdsWithHeading] of headingCounts) {
      if (sourceIdsWithHeading.length < 2) continue;
      index += 1;
      agreements.push({
        claimId: `a${index}`,
        statement: `All compared sources cover "${heading}".`,
        kind: 'extracted_content',
        evidenceIds: verified
          .filter(
            (item) =>
              sourceIdsWithHeading.includes(item.sourceId) &&
              item.excerpt.toLowerCase().includes(heading.slice(0, 24)),
          )
          .map((item) => item.evidenceId)
          .slice(0, 4),
        confidence: 0.7,
      });
      if (agreements.length >= 8) break;
    }
    // Drop agreements with no evidence: a shared heading is only an agreement
    // when it is actually quoted from each source.
    const evidencedAgreements = agreements
      .map((claim) =>
        buildClaim({
          claimId: claim.claimId,
          statement: claim.statement,
          kind: claim.kind,
          evidenceIds: claim.evidenceIds,
          confidence: claim.confidence,
          knownEvidence: known,
        }),
      )
      .filter((claim) => claim.evidenceIds.length > 0);

    const contradictions = new ContradictionDetector({ limits: this.#limits }).detect(
      contents,
      verified,
    );
    const onlyIn = participants.map((participant) => ({
      sourceId: participant.source.sourceId,
      headings: participant.outline.filter(
        (heading) => (headingCounts.get(heading.toLowerCase()) ?? []).length === 1,
      ),
    }));

    return {
      participants,
      agreements: evidencedAgreements,
      contradictions,
      onlyIn,
      reasoning: this.#reasoning.disclosure(),
      truncated: contents.some((content) => content.truncated),
    };
  }
}
