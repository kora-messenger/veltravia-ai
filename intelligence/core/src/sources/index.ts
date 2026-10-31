/** The unified source registry.
 *
 * An adapter knows ONE provider's read-only access path (uploaded files, a
 * connected app, a project workspace). The registry is the only thing that
 * builds a `SourceRef`, so ownership, retrieval timestamps, freshness, trust
 * tagging and bounds are applied in one place and cannot be skipped.
 */
import { IntelligenceError } from '../errors/index.js';
import { bounded, detectInjectionRisk, sanitizeUntrustedText } from '../security/index.js';
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  UNTRUSTED,
  isSourceProvider,
  isSourceType,
  type IntelligenceLimits,
  type ProviderAvailability,
  type RawSource,
  type SourceContent,
  type SourceProvider,
  type SourceRef,
  type SourceSegment,
  type SourceType,
} from '../types/index.js';

export interface OwnerScope {
  readonly ownerRef: string;
  /** Optional narrowing: adapters receive this verbatim and must respect it. */
  readonly allowedProjectIds?: readonly string[];
}

export interface SourceListOptions {
  readonly limit: number;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly text?: string | null;
}

export interface SourceAdapter {
  readonly provider: SourceProvider;
  readonly providerName: string;
  readonly sourceType: SourceType;
  /** False when the capability behind this provider is not usable right now
   *  (no connection, no configured credentials). The reason is shown honestly. */
  availability(owner: OwnerScope): Promise<ProviderAvailability>;
  list(owner: OwnerScope, options: SourceListOptions): Promise<readonly RawSource[]>;
  read(owner: OwnerScope, resourceId: string): Promise<RawSource>;
}

export function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function sourceIdFor(provider: SourceProvider, resourceId: string): string {
  return `${provider}:${resourceId}`;
}

export function parseSourceId(value: string): { provider: SourceProvider; resourceId: string } {
  const index = value.indexOf(':');
  if (index <= 0) throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Invalid source id.');
  const provider = value.slice(0, index);
  const resourceId = value.slice(index + 1);
  if (!isSourceProvider(provider) || resourceId.length === 0)
    throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Invalid source id.');
  return { provider, resourceId };
}

const HEADING_PATTERN = /^(?:#{1,6}\s+|\d+(?:\.\d+)*[.)]\s+)(.{1,120})$/;

/** Splits canonical text into segments with verifiable locators. Line numbers
 *  are preserved so a citation can point at something a reader can open. */
export function segmentText(text: string, maxSegments: number): readonly SourceSegment[] {
  const segments: SourceSegment[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let heading: string | null = null;
  let buffer: { text: string; start: number; line: number } | null = null;

  const flush = () => {
    if (!buffer) return;
    const body = buffer.text.trim();
    if (body.length > 0 && segments.length < maxSegments) {
      segments.push({
        segmentId: `s${segments.length + 1}`,
        heading,
        text: body,
        locator: {
          kind: heading ? 'section' : 'line',
          label: heading ? heading : `line ${buffer.line}`,
          section: heading,
          path: null,
          line: buffer.line,
          start: buffer.start,
          end: buffer.start + buffer.text.length,
        },
      });
    }
    buffer = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const lineStart = offset;
    offset += raw.length + 1;
    if (raw.trim().length === 0) {
      flush();
      continue;
    }
    const headingMatch = HEADING_PATTERN.exec(raw.trim());
    if (headingMatch) {
      flush();
      heading = bounded(headingMatch[1]!.trim(), 120);
      continue;
    }
    if (!buffer) buffer = { text: raw, start: lineStart, line: index + 1 };
    else buffer.text += `\n${raw}`;
  }
  flush();
  return segments;
}

export interface SourceRegistryOptions {
  readonly now?: () => Date;
  readonly limits?: Partial<IntelligenceLimits>;
}

interface CacheEntry {
  readonly source: SourceRef;
  readonly content: SourceContent;
  readonly storedAt: number;
}

export class SourceRegistry {
  readonly #adapters = new Map<SourceProvider, SourceAdapter>();
  readonly #now: () => Date;
  readonly #limits: IntelligenceLimits;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: SourceRegistryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
  }

  get limits(): IntelligenceLimits {
    return this.#limits;
  }

  register(adapter: SourceAdapter): void {
    if (!isSourceProvider(adapter.provider))
      throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Unknown source provider.');
    if (!isSourceType(adapter.sourceType))
      throw new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', 'Unknown source type.');
    this.#adapters.set(adapter.provider, adapter);
  }

  adapters(): readonly SourceAdapter[] {
    return [...this.#adapters.values()];
  }

  async availability(owner: OwnerScope): Promise<readonly ProviderAvailability[]> {
    const out: ProviderAvailability[] = [];
    for (const adapter of this.#adapters.values()) {
      try {
        out.push(await adapter.availability(owner));
      } catch {
        out.push({
          provider: adapter.provider,
          available: false,
          detail: 'This source is unavailable right now.',
        });
      }
    }
    return out;
  }

  /** Owner-scoped discovery. Adapters only ever see the owner they were handed,
   *  and results are deduplicated by source id and bounded. */
  async discover(
    owner: OwnerScope,
    options: {
      readonly providers?: readonly SourceProvider[];
      readonly sourceTypes?: readonly SourceType[];
      readonly projectId?: string | null;
      readonly workspaceId?: string | null;
      readonly text?: string | null;
      readonly limit?: number;
    } = {},
  ): Promise<readonly SourceRef[]> {
    const limit = Math.min(
      options.limit ?? this.#limits.maxSourcesListed,
      this.#limits.maxSourcesListed,
    );
    const wanted =
      options.providers && options.providers.length > 0 ? new Set(options.providers) : null;
    const byId = new Map<string, SourceRef>();
    const availability = await this.availability(owner);
    const available = new Set(
      availability.filter((entry) => entry.available).map((e) => e.provider),
    );

    for (const adapter of this.#adapters.values()) {
      if (wanted && !wanted.has(adapter.provider)) continue;
      if (options.sourceTypes && options.sourceTypes.length > 0)
        if (!options.sourceTypes.includes(adapter.sourceType)) continue;
      if (!available.has(adapter.provider)) continue;
      let raws: readonly RawSource[];
      try {
        raws = await adapter.list(owner, {
          limit,
          projectId: options.projectId ?? null,
          workspaceId: options.workspaceId ?? null,
          text: options.text ?? null,
        });
      } catch {
        // A failing provider never sinks discovery: its sources are simply
        // absent, and availability already told the caller why.
        continue;
      }
      for (const raw of raws) {
        const ref = this.#toRef(owner, adapter, raw);
        if (!byId.has(ref.sourceId)) byId.set(ref.sourceId, ref);
        if (byId.size >= limit) break;
      }
      if (byId.size >= limit) break;
    }

    return [...byId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  }

  async read(owner: OwnerScope, sourceId: string): Promise<SourceContent> {
    const { provider, resourceId } = parseSourceId(sourceId);
    const adapter = this.#adapters.get(provider);
    if (!adapter)
      throw new IntelligenceError('INTELLIGENCE_SOURCE_NOT_FOUND', 'That source is not available.');
    const available = await adapter.availability(owner);
    if (!available.available)
      throw new IntelligenceError(
        'INTELLIGENCE_PROVIDER_UNAVAILABLE',
        available.detail || 'That source is not available right now.',
      );

    const cached = this.#cache.get(sourceId);
    if (
      cached &&
      this.#now().getTime() - cached.storedAt <= this.#limits.contentCacheSeconds * 1000
    )
      return cached.content;

    let raw: RawSource;
    try {
      raw = await adapter.read(owner, resourceId);
    } catch (error) {
      if (error instanceof IntelligenceError) throw error;
      throw new IntelligenceError(
        'INTELLIGENCE_SOURCE_NOT_FOUND',
        'That source could not be read. It may have been removed or may not be yours.',
      );
    }
    const ref = this.#toRef(owner, adapter, raw);
    const content = this.#toContent(ref, raw);
    this.#cache.set(sourceId, { source: ref, content, storedAt: this.#now().getTime() });
    return content;
  }

  #toRef(owner: OwnerScope, adapter: SourceAdapter, raw: RawSource): SourceRef {
    const now = this.#now();
    const retrievedAt = now.toISOString();
    const ageSeconds = 0;
    return {
      sourceId: sourceIdFor(adapter.provider, raw.resourceId),
      ownerRef: owner.ownerRef,
      provider: adapter.provider,
      providerName: adapter.providerName,
      sourceType: raw.sourceType,
      resourceId: raw.resourceId,
      name: bounded(raw.name, 300),
      mimeType: raw.mimeType,
      byteSize: raw.byteSize ?? null,
      projectId: raw.projectId ?? null,
      workspaceId: raw.workspaceId ?? null,
      contentVersion: raw.contentVersion,
      retrievedAt,
      modifiedAt: raw.modifiedAt ?? null,
      sourceUrl: raw.sourceUrl ?? null,
      permissions: [...(raw.permissions ?? [])],
      freshness: {
        retrievedAt,
        ageSeconds,
        staleAfterSeconds: this.#limits.staleAfterSeconds,
        stale: false,
      },
      trustTag: UNTRUSTED,
    };
  }

  #toContent(ref: SourceRef, raw: RawSource): SourceContent {
    const text = bounded(sanitizeUntrustedText(raw.text), this.#limits.maxContentBytes);
    return {
      source: ref,
      text,
      segments: segmentText(text, this.#limits.maxSegmentsPerSource),
      truncated: raw.truncated === true || text.length < raw.text.length,
      byteSize: raw.byteSize ?? utf8Length(raw.text),
      trustTag: UNTRUSTED,
      retrievedAt: ref.retrievedAt,
      injectionRisk: detectInjectionRisk(text),
    };
  }
}
