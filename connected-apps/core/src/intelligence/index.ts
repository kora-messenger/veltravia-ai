/** Connected resource intelligence: bridges retrieved connected-app content to
 *  Document Intelligence through a narrow port, so this package never depends
 *  on a parser implementation and the analyzer can never widen access.
 *
 *  Every result keeps the resource provenance. When a provider served a cached
 *  copy, the age travels with the analysis instead of being hidden. */
import { ConnectedAppError } from '../errors/index.js';
import { bounded } from '../security/index.js';
import type { ConnectedAppManager, OwnerPrincipal } from '../manager/index.js';
import type { AnalyzedResource, SourceProvenance } from '../types/index.js';

export interface AnalyzerInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface AnalyzerStructure {
  readonly format: string;
  readonly elementCount: number;
  readonly tableCount: number;
  readonly headings: readonly string[];
  readonly textPreview: string;
  readonly truncated: boolean;
}

export interface AnalyzerSummary {
  readonly summary: string;
  /** Always 'ai_generated': a summary is interpretation, never a source. */
  readonly trustTag: string;
}

/** Implemented in the API layer over the Step 23 Document Intelligence manager. */
export interface ResourceAnalyzer {
  analyze(input: AnalyzerInput): Promise<AnalyzerStructure>;
  summarize(
    input: AnalyzerInput & { readonly mode: 'brief' | 'bullets' | 'executive' },
  ): Promise<AnalyzerSummary>;
}

export interface ResourceSummary {
  readonly provenance: SourceProvenance;
  readonly summary: string;
  readonly trustTag: string;
  readonly fromCache: boolean;
  readonly ageSeconds: number | null;
}

export interface ResourceComparison {
  readonly left: AnalyzedResource;
  readonly right: AnalyzedResource;
  readonly sharedHeadings: readonly string[];
  readonly leftOnlyHeadings: readonly string[];
  readonly rightOnlyHeadings: readonly string[];
  readonly summary: string;
}

export class ConnectedResourceIntelligence {
  readonly #manager: ConnectedAppManager;
  readonly #analyzer: ResourceAnalyzer;

  constructor(manager: ConnectedAppManager, analyzer: ResourceAnalyzer) {
    this.#manager = manager;
    this.#analyzer = analyzer;
  }

  async analyze(
    principal: OwnerPrincipal,
    providerId: string,
    resourceId: string,
  ): Promise<AnalyzedResource> {
    const content = await this.#manager.content(principal, providerId, resourceId);
    if (content.encoding === 'binary')
      throw new ConnectedAppError(
        'CONNECTED_CONTENT_UNSUPPORTED',
        'That resource is binary and cannot be analyzed as a document.',
      );
    const structure = await this.#guard(() =>
      this.#analyzer.analyze({
        filename: content.resource.name,
        mimeType: content.mimeType,
        bytes: content.bytes,
      }),
    );
    return {
      provenance: content.provenance,
      format: structure.format,
      byteSize: content.bytes.byteLength,
      elementCount: structure.elementCount,
      tableCount: structure.tableCount,
      headings: structure.headings.slice(0, 40),
      textPreview: bounded(structure.textPreview, 2000),
      truncated: structure.truncated,
      fromCache: content.fromCache,
      ageSeconds: content.ageSeconds,
    };
  }

  async summarize(
    principal: OwnerPrincipal,
    providerId: string,
    resourceId: string,
    mode: 'brief' | 'bullets' | 'executive' = 'brief',
  ): Promise<ResourceSummary> {
    const content = await this.#manager.content(principal, providerId, resourceId);
    if (content.encoding === 'binary')
      throw new ConnectedAppError(
        'CONNECTED_CONTENT_UNSUPPORTED',
        'That resource is binary and cannot be summarized.',
      );
    const result = await this.#guard(() =>
      this.#analyzer.summarize({
        filename: content.resource.name,
        mimeType: content.mimeType,
        bytes: content.bytes,
        mode,
      }),
    );
    return {
      provenance: content.provenance,
      summary: bounded(result.summary, 4000),
      trustTag: 'ai_generated',
      fromCache: content.fromCache,
      ageSeconds: content.ageSeconds,
    };
  }

  /** Deterministic structural comparison. It compares the parsed heading
   *  structure and shapes, and says so - it never claims to have read a
   *  semantic difference it did not compute. */
  async compare(
    principal: OwnerPrincipal,
    left: { providerId: string; resourceId: string },
    right: { providerId: string; resourceId: string },
  ): Promise<ResourceComparison> {
    const a = await this.analyze(principal, left.providerId, left.resourceId);
    const b = await this.analyze(principal, right.providerId, right.resourceId);
    const norm = (values: readonly string[]): string[] =>
      values.map((value) => value.trim().toLowerCase()).filter(Boolean);
    const leftHeadings = new Set(norm(a.headings));
    const rightHeadings = new Set(norm(b.headings));
    const shared = [...leftHeadings].filter((heading) => rightHeadings.has(heading)).sort();
    const leftOnly = [...leftHeadings].filter((heading) => !rightHeadings.has(heading)).sort();
    const rightOnly = [...rightHeadings].filter((heading) => !leftHeadings.has(heading)).sort();
    const sameFormat = a.format === b.format;
    const summary =
      `${a.provenance.resourceName} (${a.format}, ${a.elementCount} elements) vs ` +
      `${b.provenance.resourceName} (${b.format}, ${b.elementCount} elements). ` +
      `${shared.length} shared headings, ${leftOnly.length} only in the first, ` +
      `${rightOnly.length} only in the second. Formats ${sameFormat ? 'match' : 'differ'}. ` +
      'This is a structural comparison only.';
    return {
      left: a,
      right: b,
      sharedHeadings: shared,
      leftOnlyHeadings: leftOnly,
      rightOnlyHeadings: rightOnly,
      summary,
    };
  }

  async #guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ConnectedAppError) throw error;
      throw new ConnectedAppError(
        'CONNECTED_PARSE_FAILED',
        'That resource could not be parsed as a document.',
      );
    }
  }
}
