/** Deterministic contradiction detection.
 *
 * Three rules run over retrieved contents:
 *  1. `value_conflict`   - two sources state different values for the same topic.
 *  2. `presence_conflict`- one source says a feature exists, another says it does not.
 *  3. `superseded`       - an older source is explicitly replaced by a newer one.
 *
 * The detector NEVER picks a winner. Every statement is reported with its source,
 * revision and date, and `resolvable` is only true when the evidence itself
 * settles the question.
 */
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  type Contradiction,
  type ContradictingStatement,
  type EvidenceRef,
  type IntelligenceLimits,
  type SourceContent,
} from '../types/index.js';
import { bounded, normalizeForMatch, redactSecrets } from '../security/index.js';

const TOPIC_WORDS = [
  'deadline',
  'launch',
  'release',
  'budget',
  'cost',
  'price',
  'total',
  'duration',
  'retention',
  'quota',
  'limit',
  'revision',
  'version',
  'sla',
  'headcount',
  'capacity',
  'fee',
  'rate',
] as const;

const ABSENCE_PATTERN =
  /\b(not (?:yet )?(?:implemented|available|supported|present|included)|does not (?:support|implement|exist)|doesn't (?:support|implement|exist)|missing|absent|no plan to)\b/i;
const PRESENCE_PATTERN =
  /\b(?:is|are|now|already|fully) (?:implemented|available|supported|shipped|included|live)\b|\bimplements?\b|\bsupports?\b|\binclud(?:es|ed)\b|\bin scope\b/i;
const SUPERSEDE_PATTERN = /\b(?:supersed(?:e|es|ed)|replaces?|replaced by|obsoletes?)\b/i;

interface StatementHit {
  readonly sentence: string;
  readonly content: SourceContent;
  readonly locator: { readonly label: string; readonly line: number | null };
}

function sentencesOf(content: SourceContent): readonly StatementHit[] {
  const out: StatementHit[] = [];
  for (const segment of content.segments) {
    for (const sentence of segment.text.split(/(?<=[.!?])\s+|\n+/)) {
      const trimmed = sentence.trim();
      if (trimmed.length < 12 || trimmed.length > 400) continue;
      out.push({
        sentence: trimmed,
        content,
        locator: { label: segment.locator.label, line: segment.locator.line },
      });
    }
  }
  return out;
}

function topicOf(sentence: string): string | null {
  const lower = sentence.toLowerCase();
  for (const topic of TOPIC_WORDS) if (lower.includes(topic)) return topic;
  return null;
}

const DATE_PATTERN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|Q[1-4]\s+\d{4})\b/gi;
const NUMBER_PATTERN =
  /(?:[$€£₦]\s?)?\b\d[\d,]*(?:\.\d+)?\s?(?:%|k|m|bn|days?|weeks?|months?|years?|hours?)?\b/gi;

export function extractValues(sentence: string): readonly string[] {
  const dates = [...sentence.matchAll(DATE_PATTERN)].map((match) =>
    normalizeForMatch(match[0]).replace(/\s+/g, ' '),
  );
  const numbers = [...sentence.matchAll(NUMBER_PATTERN)]
    .map((match) => normalizeForMatch(match[0]).replace(/\s+/g, ' '))
    .filter((value) => value.length > 0);
  return [...new Set([...dates, ...numbers])];
}

export interface ContradictionDetectorOptions {
  readonly limits?: Partial<IntelligenceLimits>;
}

export class ContradictionDetector {
  readonly #limits: IntelligenceLimits;

  constructor(options: ContradictionDetectorOptions = {}) {
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
  }

  detect(
    contents: readonly SourceContent[],
    evidence: readonly EvidenceRef[] = [],
  ): readonly Contradiction[] {
    const out: Contradiction[] = [];
    const all: StatementHit[] = contents.flatMap((content) => sentencesOf(content));

    const evidenceFor = (hit: StatementHit): string => {
      const match = evidence.find(
        (item) =>
          item.sourceId === hit.content.source.sourceId &&
          (item.locator.line === null || item.locator.line === hit.locator.line),
      );
      return match?.evidenceId ?? `ev:${hit.content.source.sourceId}:unlocated`;
    };

    const statement = (hit: StatementHit): ContradictingStatement => ({
      text: redactSecrets(bounded(hit.sentence, 320)),
      sourceId: hit.content.source.sourceId,
      resourceName: hit.content.source.name,
      evidenceId: evidenceFor(hit),
      revision: hit.content.source.contentVersion,
      modifiedAt: hit.content.source.modifiedAt,
    });

    // 1. Value conflicts: same topic, different values, different sources.
    const byTopic = new Map<string, StatementHit[]>();
    for (const hit of all) {
      const topic = topicOf(hit.sentence);
      if (!topic) continue;
      if (extractValues(hit.sentence).length === 0) continue;
      const list = byTopic.get(topic) ?? [];
      if (!list.some((entry) => entry.content.source.sourceId === hit.content.source.sourceId))
        list.push(hit);
      byTopic.set(topic, list);
    }
    for (const [topic, hits] of byTopic) {
      if (out.length >= this.#limits.maxContradictions) break;
      if (hits.length < 2) continue;
      const valueSets = hits.map((hit) => new Set(extractValues(hit.sentence)));
      const differs = valueSets.some((values, index) =>
        valueSets.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            [...values].some((value) => !other.has(value)) &&
            [...values].some((value) => /[a-z0-9]/.test(value)),
        ),
      );
      if (!differs) continue;
      const supersedeHit = hits.find((hit) => SUPERSEDE_PATTERN.test(hit.sentence));
      const newest = [...hits].sort((a, b) =>
        (b.content.source.modifiedAt ?? '').localeCompare(a.content.source.modifiedAt ?? ''),
      )[0];
      out.push({
        contradictionId: `con:value:${topic}:${hits.map((hit) => hit.content.source.sourceId).join('|')}`,
        kind: 'value_conflict',
        topic,
        statements: hits.map(statement),
        explanation: `${hits.length} sources state different ${topic} values. The engine does not choose one: compare the dates and revisions before relying on any of them.`,
        confidence: 0.7,
        resolvable: supersedeHit !== undefined,
        resolution:
          supersedeHit !== undefined
            ? `A source explicitly supersedes another, so the replacement should win: verify the superseding revision before using it.`
            : newest !== undefined && newest.content.source.modifiedAt !== null
              ? `The most recently modified source is ${newest.content.source.name} (${newest.content.source.modifiedAt}), but recency alone does not settle the value.`
              : null,
        detectedBy: 'deterministic_rule',
      });
    }

    // 2. Presence conflicts: feature present in one source, absent in another.
    const featurePatterns = [
      /\b(?:feature|capability|function|endpoint|screen|module)\s+["“]?([a-z0-9][a-z0-9 _-]{2,40}?)["”]?\s+(?:is|are|has been)\b/i,
      /\bthe\s+([a-z0-9][a-z0-9 _-]{2,40}?)\s+(?:feature|screen|endpoint|module)\b/i,
    ];
    const featureOf = (sentence: string): string | null => {
      for (const pattern of featurePatterns) {
        const match = pattern.exec(sentence);
        if (match?.[1]) return normalizeForMatch(match[1]).trim();
      }
      return null;
    };
    const negative = all.filter((hit) => ABSENCE_PATTERN.test(hit.sentence));
    const positive = all.filter((hit) => PRESENCE_PATTERN.test(hit.sentence));
    for (const absent of negative) {
      if (out.length >= this.#limits.maxContradictions) break;
      const feature =
        featureOf(absent.sentence) ??
        [...normalizeForMatch(absent.sentence).matchAll(/\b([a-z]{4,20})\b/g)]
          .map((match) => match[1]!)
          .find((token) => positive.some((hit) => hit.sentence.toLowerCase().includes(token)));
      if (!feature) continue;
      const conflicting = positive.find(
        (hit) =>
          hit.content.source.sourceId !== absent.content.source.sourceId &&
          hit.sentence.toLowerCase().includes(feature),
      );
      if (!conflicting) continue;
      out.push({
        contradictionId: `con:presence:${feature}:${absent.content.source.sourceId}:${conflicting.content.source.sourceId}`,
        kind: 'presence_conflict',
        topic: `feature:${feature}`,
        statements: [statement(conflicting), statement(absent)],
        explanation: `One source states "${feature}" exists while another states it is missing or unimplemented. Both are reported; neither is treated as the truth.`,
        confidence: 0.6,
        resolvable: false,
        resolution: null,
        detectedBy: 'deterministic_rule',
      });
    }

    // 3. Supersession: explicit replacement statements.
    for (const hit of all) {
      if (out.length >= this.#limits.maxContradictions) break;
      if (!SUPERSEDE_PATTERN.test(hit.sentence)) continue;
      const replaced = contents.find(
        (content) =>
          content.source.sourceId !== hit.content.source.sourceId &&
          hit.sentence.toLowerCase().includes(content.source.name.toLowerCase().split('.')[0]!),
      );
      if (!replaced) continue;
      const older = sentencesOf(replaced)[0];
      if (!older) continue;
      out.push({
        contradictionId: `con:superseded:${hit.content.source.sourceId}:${replaced.source.sourceId}`,
        kind: 'superseded',
        topic: 'document_version',
        statements: [statement(hit), statement(older)],
        explanation: `${hit.content.source.name} states it replaces ${replaced.source.name}. The older source is still shown so the change can be reviewed.`,
        confidence: 0.8,
        resolvable: true,
        resolution: `Use ${hit.content.source.name} (revision ${hit.content.source.contentVersion}) as the current source; ${replaced.source.name} is superseded.`,
        detectedBy: 'deterministic_rule',
      });
    }

    return out.slice(0, this.#limits.maxContradictions);
  }
}
