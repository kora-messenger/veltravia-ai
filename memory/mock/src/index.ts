/**
 * Deterministic in-memory MemoryRepository.
 *
 * Fully offline: no database, no network, no credentials, no host
 * filesystem. Implements the core interface exactly - including the
 * revision check on update and the project-scoped get/delete contract
 * (cross-project ids resolve to null/false; existence is never leaked).
 */

import {
  MemoryStorageError,
  type CreateMemoryInput,
  type MemoryListQuery,
  type MemoryRecordPatch,
  type MemoryRepository,
  type MemorySearchQuery,
  type MemorySearchResult,
  type ProjectMemory,
} from '@veltravia/memory-core';

interface StoredMemory {
  record: ProjectMemory;
}

export interface InMemoryMemoryRepositoryOptions {
  readonly now?: () => Date;
  /** Deterministic id seed (tests); defaults to a monotonic counter. */
  readonly idPrefix?: string;
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records = new Map<string, StoredMemory>();
  private readonly now: () => Date;
  private readonly idPrefix: string;
  private counter = 0;

  constructor(options: InMemoryMemoryRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idPrefix = options.idPrefix ?? 'mem';
  }

  async create(input: CreateMemoryInput): Promise<ProjectMemory> {
    this.counter += 1;
    const id = `${this.idPrefix}_${this.counter.toString().padStart(6, '0')}`;
    if (this.records.has(id)) throw new MemoryStorageError('Memory id collision.');
    const at = this.now().toISOString();
    const record: ProjectMemory = {
      id,
      projectId: input.projectId,
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      title: input.title,
      content: input.content,
      source: input.source,
      confidence: input.confidence ?? 'medium',
      status: input.status ?? 'active',
      verificationStatus: input.verificationStatus ?? 'unverified',
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(id, { record });
    return clone(record);
  }

  async get(memoryId: string, projectId: string): Promise<ProjectMemory | null> {
    const stored = this.records.get(memoryId);
    if (stored === undefined || stored.record.projectId !== projectId) return null;
    return clone(stored.record);
  }

  async update(
    memoryId: string,
    projectId: string,
    expectedRevision: number,
    patch: MemoryRecordPatch,
  ): Promise<ProjectMemory | null> {
    const stored = this.records.get(memoryId);
    if (stored === undefined || stored.record.projectId !== projectId) return null;
    if (stored.record.revision !== expectedRevision) return null;
    const at = this.now().toISOString();
    const updated: ProjectMemory = {
      ...stored.record,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.verificationStatus !== undefined
        ? { verificationStatus: patch.verificationStatus }
        : {}),
      ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
      revision: stored.record.revision + 1,
      updatedAt: at,
    };
    stored.record = updated;
    return clone(updated);
  }

  async list(query: MemoryListQuery): Promise<readonly ProjectMemory[]> {
    const matched: ProjectMemory[] = [];
    for (const { record } of this.records.values()) {
      if (record.projectId !== query.projectId) continue;
      if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) continue;
      if (query.type !== undefined && record.type !== query.type) continue;
      if (query.status !== undefined && record.status !== query.status) continue;
      matched.push(record);
    }
    sortMemories(matched, query.sort ?? 'recent');
    const limit = query.limit ?? 50;
    return matched.slice(0, limit).map(clone);
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    const text = query.text?.toLowerCase();
    const matched: ProjectMemory[] = [];
    for (const { record } of this.records.values()) {
      if (record.projectId !== query.projectId) continue;
      if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) continue;
      if (query.type !== undefined && record.type !== query.type) continue;
      if (query.status !== undefined && record.status !== query.status) continue;
      if (query.sourceKind !== undefined && record.source.kind !== query.sourceKind) continue;
      if (text !== undefined && text !== '') {
        const haystack = `${record.title}\n${record.content}`.toLowerCase();
        if (!haystack.includes(text)) continue;
      }
      matched.push(record);
    }
    const totalMatched = matched.length;
    const limit = query.limit ?? 50;
    // Manager applies the ranked ordering; repository bounds the raw set.
    return { memories: matched.slice(0, limit).map(clone), totalMatched };
  }

  async count(projectId: string): Promise<number> {
    let total = 0;
    for (const { record } of this.records.values()) {
      if (record.projectId === projectId) total += 1;
    }
    return total;
  }

  async delete(memoryId: string, projectId: string): Promise<boolean> {
    const stored = this.records.get(memoryId);
    if (stored === undefined || stored.record.projectId !== projectId) return false;
    return this.records.delete(memoryId);
  }
}

function sortMemories(memories: ProjectMemory[], sort: string): void {
  switch (sort) {
    case 'created':
      memories.sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
      );
      break;
    case 'confidence':
      memories.sort(
        (a, b) =>
          confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.id.localeCompare(b.id),
      );
      break;
    case 'title':
      memories.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      break;
    case 'recent':
    default:
      memories.sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
      );
      break;
  }
}

function confidenceRank(confidence: ProjectMemory['confidence']): number {
  switch (confidence) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
}

function clone(record: ProjectMemory): ProjectMemory {
  return { ...record, source: { ...record.source } };
}

/** Convenience factory: a deterministic repository with default settings. */
export function createInMemoryMemoryRepository(
  options: InMemoryMemoryRepositoryOptions = {},
): InMemoryMemoryRepository {
  return new InMemoryMemoryRepository(options);
}
