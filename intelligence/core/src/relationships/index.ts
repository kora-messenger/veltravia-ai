/** A bounded source relationship graph.
 *
 * No graph database: relationships are derived on demand from the retrieved
 * sources themselves and kept in a small in-memory map for the lifetime of one
 * analysis. Every edge is `inferred: true` and explains why it exists.
 */
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  type IntelligenceLimits,
  type Relationship,
  type RelationshipGraphView,
  type SourceContent,
  type SourceRef,
} from '../types/index.js';

const SUPERSEDE_PATTERN =
  /\b(supersed(?:e|es|ed|ing)|replaces?|replaced by|obsoletes?|in place of|this version replaces)\b/i;
const IMPLEMENTATION_HINT =
  /\b(implement(?:s|ed|ing)?|src\/|\.ts\b|\.tsx\b|\.js\b|function|export const|class )\b/i;

export interface RelationshipGraphOptions {
  readonly limits?: Partial<IntelligenceLimits>;
}

export class RelationshipGraph {
  readonly #limits: IntelligenceLimits;
  readonly #nodes = new Map<string, SourceRef>();
  readonly #edges: Relationship[] = [];
  #truncated = false;

  constructor(options: RelationshipGraphOptions = {}) {
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  addNode(source: SourceRef): void {
    if (this.#nodes.size >= this.#limits.maxGraphNodes) {
      if (!this.#nodes.has(source.sourceId)) this.#truncated = true;
      return;
    }
    this.#nodes.set(source.sourceId, source);
  }

  addEdge(edge: Omit<Relationship, 'relationshipId' | 'inferred'>): void {
    if (this.#edges.length >= this.#limits.maxGraphEdges) {
      this.#truncated = true;
      return;
    }
    if (edge.fromSourceId === edge.toSourceId) return;
    const duplicate = this.#edges.find(
      (candidate) =>
        candidate.kind === edge.kind &&
        candidate.fromSourceId === edge.fromSourceId &&
        candidate.toSourceId === edge.toSourceId,
    );
    if (duplicate) return;
    this.#edges.push({
      ...edge,
      relationshipId: `rel:${edge.kind}:${edge.fromSourceId}->${edge.toSourceId}`,
      inferred: true,
    });
  }

  relationships(): readonly Relationship[] {
    return [...this.#edges].sort((a, b) => a.relationshipId.localeCompare(b.relationshipId));
  }

  view(): RelationshipGraphView {
    return {
      nodes: [...this.#nodes.values()],
      relationships: this.relationships(),
      truncated: this.#truncated,
    };
  }

  /** Neighbours of one source, bounded by depth (max 2) and edge count. */
  neighbours(sourceId: string, depth = 2): RelationshipGraphView {
    const boundedDepth = Math.min(Math.max(depth, 1), 2);
    const wanted = new Set<string>([sourceId]);
    for (let level = 0; level < boundedDepth; level += 1) {
      for (const edge of this.#edges) {
        if (wanted.has(edge.fromSourceId)) wanted.add(edge.toSourceId);
        if (wanted.has(edge.toSourceId)) wanted.add(edge.fromSourceId);
      }
    }
    return {
      nodes: [...this.#nodes.values()].filter((node) => wanted.has(node.sourceId)),
      relationships: this.#edges.filter(
        (edge) => wanted.has(edge.fromSourceId) && wanted.has(edge.toSourceId),
      ),
      truncated: this.#truncated,
    };
  }
}

function nameTokens(name: string): readonly string[] {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

/**
 * Derives relationships from the retrieved contents.
 *
 * Rules are deterministic and explainable:
 *  - `references`: one source's text names another source (its name or its
 *    path/filename).
 *  - `same_project`: two sources were captured from the same project.
 *  - `implements`: a code/project source contains the term a document's heading
 *    describes (a specification describing what the code implements).
 *  - `supersedes`: one source's text explicitly says it supersedes/replaces the
 *    other, or it is a strictly newer revision of the same document family with
 *    explicit version wording. The newer-dated-only case is NOT called
 *    supersession: that would be a guess.
 */
export function buildRelationships(
  contents: readonly SourceContent[],
  graph: RelationshipGraph,
): RelationshipGraph {
  for (const content of contents) graph.addNode(content.source);

  for (const a of contents) {
    for (const b of contents) {
      if (a === b) continue;
      const aText = a.text.toLowerCase();
      const aSource = a.source;
      const bSource = b.source;

      const bTokens = nameTokens(bSource.name);
      const referenced = bTokens.length > 0 && bTokens.every((token) => aText.includes(token));
      if (referenced && aSource.sourceType !== bSource.sourceType) {
        graph.addEdge({
          kind: 'references',
          fromSourceId: aSource.sourceId,
          toSourceId: bSource.sourceId,
          explanation: `${aSource.name} mentions "${bSource.name}".`,
          confidence: 0.6,
          evidenceIds: [],
        });
      }

      if (aSource.projectId !== null && aSource.projectId === bSource.projectId)
        graph.addEdge({
          kind: 'same_project',
          fromSourceId: aSource.sourceId,
          toSourceId: bSource.sourceId,
          explanation: `Both sources belong to project ${aSource.projectId}.`,
          confidence: 0.8,
          evidenceIds: [],
        });

      if (IMPLEMENTATION_HINT.test(a.text) && aSource.sourceType === 'project_file') {
        const heading = b.segments.find((segment) => segment.heading !== null)?.heading;
        if (heading && aText.includes(heading.toLowerCase()))
          graph.addEdge({
            kind: 'implements',
            fromSourceId: aSource.sourceId,
            toSourceId: bSource.sourceId,
            explanation: `${aSource.name} contains "${heading}", which ${bSource.name} describes.`,
            confidence: 0.55,
            evidenceIds: [],
          });
      }

      const supersedeSentence = a.segments.find((segment) => SUPERSEDE_PATTERN.test(segment.text));
      const bBaseName = bSource.name.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '');
      if (
        supersedeSentence &&
        bBaseName.length > 3 &&
        supersedeSentence.text.toLowerCase().includes(bBaseName)
      )
        graph.addEdge({
          kind: 'supersedes',
          fromSourceId: aSource.sourceId,
          toSourceId: bSource.sourceId,
          explanation: `${aSource.name} states it supersedes or replaces ${bSource.name}.`,
          confidence: 0.85,
          evidenceIds: [],
        });
    }
  }
  return graph;
}
