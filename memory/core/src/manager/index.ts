/**
 * The MemoryManager: typed, project-scoped CRUD + search + lifecycle for
 * project memory.
 *
 * Every operation enforces:
 * - project ownership (cross-project ids resolve to NOT_FOUND - never leaked)
 * - workspace boundaries (workspace-scoped memory stays in its workspace)
 * - validation (typed taxonomy, provenance, confidence, size limits)
 * - secret rejection (content, titles, references - value never echoed)
 * - per-project capacity ceilings
 * - optimistic revisions (typed conflicts, no silent overwrites)
 * - scrubbed audit events (ids, counts, revisions - never content)
 *
 * The manager NEVER interprets memory content as instructions. Memory text
 * is opaque reference data end to end.
 */

import {
  MEMORY_AUDIT_EVENT_TYPES,
  nullMemoryAuditSink,
  type MemoryAuditEvent,
  type MemoryAuditSink,
} from '../audit/index.js';
import {
  InvalidMemoryRequestError,
  InvalidMemoryTransitionError,
  isSecretShaped,
  MemoryLimitReachedError,
  MemoryNotFoundError,
  MemoryRevisionConflictError,
  MemorySearchTooLargeError,
  MemorySecretRejectedError,
} from '../errors/index.js';
import type { MemoryRecordPatch, MemoryRepository } from '../repositories/index.js';
import {
  MEMORY_CONFIDENCE_LEVELS,
  MEMORY_CONFIDENCE_RANK,
  MEMORY_EXTENSION_TYPE_PATTERN,
  MEMORY_LIMITS,
  MEMORY_SORT_KEYS,
  MEMORY_SOURCE_KINDS,
  MEMORY_TYPES,
  MEMORY_VERIFICATION_STATUSES,
  type CreateMemoryInput,
  type MemoryConfidence,
  type MemoryListQuery,
  type MemorySearchQuery,
  type MemorySortKey,
  type MemorySourceKind,
  type MemoryStatus,
  type MemoryVerificationStatus,
  type ProjectMemory,
  type UpdateMemoryInput,
} from '../types/index.js';

export interface MemoryManagerOptions {
  readonly repository: MemoryRepository;
  readonly now?: () => Date;
  readonly auditSink?: MemoryAuditSink;
  /** Deployment-registered extension types (validated against the pattern). */
  readonly extensionTypes?: readonly string[];
}

export interface MemoryStats {
  readonly projectId: string;
  readonly total: number;
  readonly active: number;
  readonly archived: number;
  readonly candidates: number;
  readonly rejected: number;
  readonly stale: number;
  readonly byType: Readonly<Record<string, number>>;
}

/** Bounded memory context built for one AI run (Phase 11). */
export interface BuiltMemoryContext {
  readonly text: string;
  readonly included: number;
  readonly totalMatched: number;
  readonly truncated: boolean;
  readonly memoryIds: readonly string[];
}

const DEFAULT_CONFIDENCE: MemoryConfidence = 'medium';

export class MemoryManager {
  private readonly repository: MemoryRepository;
  private readonly now: () => Date;
  private readonly audit: MemoryAuditSink;
  private readonly types: ReadonlySet<string>;

  constructor(options: MemoryManagerOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.audit = options.auditSink ?? nullMemoryAuditSink;
    const types = new Set<string>(MEMORY_TYPES as readonly string[]);
    for (const extension of options.extensionTypes ?? []) {
      if (!MEMORY_EXTENSION_TYPE_PATTERN.test(extension)) {
        throw new InvalidMemoryRequestError(
          `Extension memory type "${extension}" is invalid (expected kebab-case, 2-40 chars).`,
        );
      }
      if (types.has(extension)) {
        throw new InvalidMemoryRequestError(
          `Extension memory type "${extension}" collides with a built-in type.`,
        );
      }
      types.add(extension);
    }
    this.types = types;
  }

  /** The validated type vocabulary (built-in + registered extensions). */
  get knownTypes(): readonly string[] {
    return [...this.types];
  }

  async create(input: CreateMemoryInput): Promise<ProjectMemory> {
    const validated = this.validateCreate(input);
    const count = await this.repository.count(input.projectId);
    if (count >= MEMORY_LIMITS.maxMemoriesPerProject) {
      throw new MemoryLimitReachedError(MEMORY_LIMITS.maxMemoriesPerProject, input.projectId);
    }
    const memory = await this.repository.create(validated);
    this.emit('memory_created', memory.id, memory.projectId, {
      type: memory.type,
      sourceKind: memory.source.kind,
      confidence: memory.confidence,
    });
    return memory;
  }

  async get(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const memory = await this.repository.get(memoryId, projectId);
    if (memory === null) throw new MemoryNotFoundError(memoryId, projectId);
    return memory;
  }

  async update(
    memoryId: string,
    projectId: string,
    input: UpdateMemoryInput,
  ): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status === 'rejected') {
      throw new InvalidMemoryTransitionError(
        'Rejected candidate memories are terminal and cannot be updated.',
      );
    }
    if (existing.status === 'archived') {
      throw new InvalidMemoryTransitionError(
        'Archived memories are historical records; restore them before editing.',
      );
    }
    const patch = this.validateUpdate(existing, input);
    const updated = await this.repository.update(
      memoryId,
      projectId,
      input.expectedRevision,
      patch,
    );
    if (updated === null) {
      // Revision mismatch (or concurrent delete) - reload to report honestly.
      const current = await this.repository.get(memoryId, projectId);
      if (current === null) throw new MemoryNotFoundError(memoryId, projectId);
      throw new MemoryRevisionConflictError(memoryId, current.revision);
    }
    this.emit('memory_updated', updated.id, updated.projectId, {
      revision: updated.revision,
      fields: [...Object.keys(patch)],
    });
    return updated;
  }

  async archive(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status !== 'active') {
      throw new InvalidMemoryTransitionError(
        `Only active memories can be archived (current status: ${existing.status}).`,
      );
    }
    const updated = await this.repository.update(memoryId, projectId, existing.revision, {
      status: 'archived',
    });
    if (updated === null) throw new MemoryRevisionConflictError(memoryId, existing.revision + 1);
    this.emit('memory_archived', updated.id, updated.projectId, {});
    return updated;
  }

  async restore(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status !== 'archived') {
      throw new InvalidMemoryTransitionError(
        `Only archived memories can be restored (current status: ${existing.status}).`,
      );
    }
    const updated = await this.repository.update(memoryId, projectId, existing.revision, {
      status: 'active',
    });
    if (updated === null) throw new MemoryRevisionConflictError(memoryId, existing.revision + 1);
    this.emit('memory_restored', updated.id, updated.projectId, {});
    return updated;
  }

  async delete(memoryId: string, projectId: string): Promise<void> {
    const removed = await this.repository.delete(memoryId, projectId);
    if (!removed) throw new MemoryNotFoundError(memoryId, projectId);
    this.emit('memory_deleted', memoryId, projectId, {});
  }

  async list(query: MemoryListQuery): Promise<readonly ProjectMemory[]> {
    this.assertProjectId(query.projectId);
    const limit = this.boundLimit(query.limit, MEMORY_LIMITS.maxSearchResults);
    const sort =
      query.sort !== undefined && MEMORY_SORT_KEYS.includes(query.sort) ? query.sort : 'recent';
    return this.repository.list({ ...query, limit, sort });
  }

  async search(query: MemorySearchQuery): Promise<readonly ProjectMemory[]> {
    this.assertProjectId(query.projectId);
    if (query.text !== undefined && query.text.length > MEMORY_LIMITS.maxQueryChars) {
      throw new MemorySearchTooLargeError(MEMORY_LIMITS.maxQueryChars);
    }
    if (query.text !== undefined && isSecretShaped(query.text)) {
      throw new MemorySecretRejectedError('Search text appears to contain secret-shaped values.');
    }
    const limit = this.boundLimit(query.limit, MEMORY_LIMITS.maxSearchResults);
    const { memories, totalMatched } = await this.repository.search({ ...query, limit: limit * 4 });
    const ranked = rankMemories(memories, query.text);
    void totalMatched; // ranking preserves the matched set; the slice bounds it
    return ranked.slice(0, limit);
  }

  async markVerified(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status === 'rejected') {
      throw new InvalidMemoryTransitionError('Rejected candidate memories are terminal.');
    }
    const at = this.now().toISOString();
    const updated = await this.repository.update(memoryId, projectId, existing.revision, {
      verificationStatus: 'verified',
      lastVerifiedAt: at,
    });
    if (updated === null) throw new MemoryRevisionConflictError(memoryId, existing.revision + 1);
    this.emit('memory_verified', updated.id, updated.projectId, {});
    return updated;
  }

  async markStale(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status === 'rejected') {
      throw new InvalidMemoryTransitionError('Rejected candidate memories are terminal.');
    }
    const updated = await this.repository.update(memoryId, projectId, existing.revision, {
      verificationStatus: 'stale',
    });
    if (updated === null) throw new MemoryRevisionConflictError(memoryId, existing.revision + 1);
    this.emit('memory_marked_stale', updated.id, updated.projectId, {});
    return updated;
  }

  /** Stores an extraction product as a NON-AUTHORITATIVE candidate. */
  async createCandidate(input: CreateMemoryInput): Promise<ProjectMemory> {
    const candidate = await this.create({ ...input, status: 'candidate' });
    this.emit('memory_candidate_created', candidate.id, candidate.projectId, {
      type: candidate.type,
      sourceKind: candidate.source.kind,
    });
    return candidate;
  }

  /** Human approval promotes a candidate to an ACTIVE memory. */
  async approveCandidate(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status !== 'candidate') {
      throw new InvalidMemoryTransitionError(
        `Only candidate memories can be approved (current status: ${existing.status}).`,
      );
    }
    const updated = await this.repository.update(memoryId, projectId, existing.revision, {
      status: 'active',
    });
    if (updated === null) throw new MemoryRevisionConflictError(memoryId, existing.revision + 1);
    this.emit('memory_candidate_approved', updated.id, updated.projectId, {});
    return updated;
  }

  /** Human rejection makes a candidate terminal (kept for auditability). */
  async rejectCandidate(memoryId: string, projectId: string): Promise<ProjectMemory> {
    const existing = await this.repository.get(memoryId, projectId);
    if (existing === null) throw new MemoryNotFoundError(memoryId, projectId);
    if (existing.status !== 'candidate') {
      throw new InvalidMemoryTransitionError(
        `Only candidate memories can be rejected (current status: ${existing.status}).`,
      );
    }
    const updated = await this.repository.update(memoryId, projectId, existing.revision, {
      status: 'rejected',
    });
    if (updated === null) throw new MemoryRevisionConflictError(memoryId, existing.revision + 1);
    this.emit('memory_candidate_rejected', updated.id, updated.projectId, {});
    return updated;
  }

  /** Bounded stats for one project (counts only - no content). */
  async stats(projectId: string): Promise<MemoryStats> {
    this.assertProjectId(projectId);
    const memories = await this.repository.list({
      projectId,
      limit: MEMORY_LIMITS.maxMemoriesPerProject,
    });
    const byType: Record<string, number> = {};
    let active = 0;
    let archived = 0;
    let candidates = 0;
    let rejected = 0;
    let stale = 0;
    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] ?? 0) + 1;
      if (memory.status === 'active') active += 1;
      else if (memory.status === 'archived') archived += 1;
      else if (memory.status === 'candidate') candidates += 1;
      else if (memory.status === 'rejected') rejected += 1;
      if (memory.verificationStatus === 'stale') stale += 1;
    }
    return {
      projectId,
      total: memories.length,
      active,
      archived,
      candidates,
      rejected,
      stale,
      byType,
    };
  }

  // -- validation helpers ---------------------------------------------------

  private validateCreate(input: CreateMemoryInput): CreateMemoryInput {
    this.assertProjectId(input.projectId);
    if (!isNonEmptyString(input.title, 1, MEMORY_LIMITS.maxTitleChars)) {
      throw new InvalidMemoryRequestError(
        `Memory title must be 1-${MEMORY_LIMITS.maxTitleChars} characters.`,
      );
    }
    if (!isNonEmptyString(input.content, 1, MEMORY_LIMITS.maxContentChars)) {
      throw new InvalidMemoryRequestError(
        `Memory content must be 1-${MEMORY_LIMITS.maxContentChars} characters.`,
      );
    }
    this.assertIsKnownType(input.type);
    // workspaceId is optional; when present the API layer validates it
    // against the Project Engine (the manager keeps it opaque).
    const source = this.validateProvenance(input.source);
    const confidence: MemoryConfidence =
      input.confidence !== undefined ? this.assertConfidence(input.confidence) : DEFAULT_CONFIDENCE;
    const verificationStatus: MemoryVerificationStatus =
      input.verificationStatus !== undefined
        ? this.assertVerification(input.verificationStatus)
        : 'unverified';
    if (
      input.lastVerifiedAt !== undefined &&
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.lastVerifiedAt)
    ) {
      throw new InvalidMemoryRequestError('lastVerifiedAt must be an ISO-8601 UTC timestamp.');
    }
    // Secret rejection: field is named, the value is NEVER echoed.
    if (isSecretShaped(input.title))
      throw new MemorySecretRejectedError('Memory title appears to be secret-shaped.');
    if (isSecretShaped(input.content))
      throw new MemorySecretRejectedError('Memory content appears to be secret-shaped.');
    if (input.status !== undefined && input.status !== 'candidate' && input.status !== 'active') {
      throw new InvalidMemoryRequestError('Initial status may only be candidate or active.');
    }
    return { ...input, source, confidence, verificationStatus };
  }

  private validateUpdate(existing: ProjectMemory, input: UpdateMemoryInput): MemoryRecordPatch {
    const patch: Record<string, string> = {};
    if (input.title !== undefined) {
      if (!isNonEmptyString(input.title, 1, MEMORY_LIMITS.maxTitleChars)) {
        throw new InvalidMemoryRequestError(
          `Memory title must be 1-${MEMORY_LIMITS.maxTitleChars} characters.`,
        );
      }
      if (isSecretShaped(input.title))
        throw new MemorySecretRejectedError('Memory title appears to be secret-shaped.');
      patch['title'] = input.title;
    }
    if (input.content !== undefined) {
      if (!isNonEmptyString(input.content, 1, MEMORY_LIMITS.maxContentChars)) {
        throw new InvalidMemoryRequestError(
          `Memory content must be 1-${MEMORY_LIMITS.maxContentChars} characters.`,
        );
      }
      if (isSecretShaped(input.content))
        throw new MemorySecretRejectedError('Memory content appears to be secret-shaped.');
      patch['content'] = input.content;
    }
    if (input.type !== undefined) {
      this.assertIsKnownType(input.type);
      patch['type'] = input.type;
    }
    if (input.confidence !== undefined) {
      patch['confidence'] = this.assertConfidence(input.confidence);
    }
    // Provenance and source are IMMUTABLE after creation: history is never rewritten.
    if (Object.keys(patch).length === 0) {
      throw new InvalidMemoryRequestError('Update contains no fields to change.');
    }
    return patch;
  }

  private validateProvenance(source: CreateMemoryInput['source']): CreateMemoryInput['source'] {
    if (
      source === null ||
      typeof source !== 'object' ||
      !MEMORY_SOURCE_KINDS.includes(source.kind)
    ) {
      throw new InvalidMemoryRequestError('Memory provenance must name a known source kind.');
    }
    if (source.referenceId !== undefined) {
      if (
        !isNonEmptyString(source.referenceId, 1, MEMORY_LIMITS.maxReferenceIdChars) ||
        isSecretShaped(source.referenceId)
      ) {
        throw new MemorySecretRejectedError(
          'Provenance reference is invalid or appears secret-shaped.',
        );
      }
    }
    return source;
  }

  private assertIsKnownType(type: string): string {
    if (!this.types.has(type)) {
      throw new InvalidMemoryRequestError(
        `Unknown memory type "${type}". Known types: ${[...this.types].join(', ')}.`,
      );
    }
    return type;
  }

  private assertConfidence(confidence: string): MemoryConfidence {
    if (!MEMORY_CONFIDENCE_LEVELS.includes(confidence as MemoryConfidence)) {
      throw new InvalidMemoryRequestError('Confidence must be high, medium, or low.');
    }
    return confidence as MemoryConfidence;
  }

  private assertVerification(status: string): MemoryVerificationStatus {
    if (!MEMORY_VERIFICATION_STATUSES.includes(status as MemoryVerificationStatus)) {
      throw new InvalidMemoryRequestError(
        'Verification status must be unverified, verified, or stale.',
      );
    }
    return status as MemoryVerificationStatus;
  }

  private assertProjectId(projectId: string): void {
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128) {
      throw new InvalidMemoryRequestError('A valid projectId is required.');
    }
  }

  private boundLimit(limit: number | undefined, max: number): number {
    if (limit === undefined) return max;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidMemoryRequestError('Limit must be a positive integer.');
    }
    return Math.min(limit, max);
  }

  private emit(
    type: (typeof MEMORY_AUDIT_EVENT_TYPES)[number],
    memoryId: string | null,
    projectId: string,
    data: Readonly<Record<string, unknown>>,
  ): void {
    const event: MemoryAuditEvent = {
      type,
      memoryId,
      projectId,
      at: this.now().toISOString(),
      data,
    };
    this.audit(event);
  }
}

/** Deterministic ranking: relevance > confidence > recency (stable ids last). */
export function rankMemories(
  memories: readonly ProjectMemory[],
  text: string | undefined,
): readonly ProjectMemory[] {
  const tokens = text !== undefined ? tokenize(text) : new Set<string>();
  return [...memories].sort((a, b) => {
    const scoreDelta = relevanceScore(b, tokens) - relevanceScore(a, tokens);
    if (scoreDelta !== 0) return scoreDelta;
    const confidenceDelta =
      (MEMORY_CONFIDENCE_RANK[b.confidence] ?? 0) - (MEMORY_CONFIDENCE_RANK[a.confidence] ?? 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    const timeDelta = Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0');
    if (timeDelta !== 0) return timeDelta;
    return a.id.localeCompare(b.id);
  });
}

function relevanceScore(memory: ProjectMemory, tokens: ReadonlySet<string>): number {
  if (tokens.size === 0) return 0;
  const titleTokens = tokenize(memory.title);
  const contentTokens = tokenize(memory.content);
  let score = 0;
  for (const token of tokens) {
    if (titleTokens.has(token)) score += 3;
    if (contentTokens.has(token)) score += 1;
  }
  return score;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2 && token.length <= 32),
  );
}

function isNonEmptyString(value: string, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

export type { MemoryStatus, MemorySortKey, MemorySourceKind };
