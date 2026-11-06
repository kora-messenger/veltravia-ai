/**
 * Project memory storage.
 *
 * The row carries the fields used for filtering and ordering plus the full
 * record in `jsonb`, so the repository can honour every list/search/sort shape
 * the manager defines without a migration each time memory gains a field.
 * Ownership comes from the scope; the project FK makes a cross-owner write
 * impossible.
 */

import { randomUUID } from 'node:crypto';

import {
  type CreateMemoryInput,
  type MemoryListQuery,
  type MemoryRepository,
  type MemorySearchQuery,
  type MemorySearchResult,
  type ProjectMemory,
} from '@veltravia/memory-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';
import type { MemoryRecordPatch } from '@veltravia/memory-core';

interface MemoryRow {
  payload: unknown;
  revision: number;
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function orderBy(sort: MemoryListQuery['sort']): string {
  switch (sort) {
    case 'created':
      return 'created_at desc, id asc';
    case 'title':
      return 'title asc, id asc';
    case 'confidence':
      return `case payload->>'confidence' when 'high' then 3 when 'medium' then 2 else 1 end desc,
              updated_at desc, id asc`;
    case 'recent':
    default:
      return 'updated_at desc, id asc';
  }
}

export class PostgresMemoryRepository implements MemoryRepository {
  private readonly query: Queryable;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(query: Queryable, options: { generateId?: () => string; now?: () => Date } = {}) {
    this.query = query;
    this.generateId = options.generateId ?? (() => `mem_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateMemoryInput): Promise<ProjectMemory> {
    const owner = requireOwner();
    const at = this.now().toISOString();
    const record: ProjectMemory = {
      id: this.generateId(),
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
    await this.query.query(
      `insert into memories
         (id, project_id, owner_ref, workspace_id, type, title, content, status,
          revision, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $10)`,
      [
        record.id,
        record.projectId,
        owner,
        record.workspaceId,
        record.type,
        record.title,
        record.content,
        record.status,
        JSON.stringify(record),
        at,
      ],
    );
    return record;
  }

  async get(memoryId: string, projectId: string): Promise<ProjectMemory | null> {
    const owner = requireOwner();
    const rows = await this.query.query<MemoryRow>(
      `select payload, revision from memories
        where id = $1 and project_id = $2 and owner_ref = $3`,
      [memoryId, projectId, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return { ...(row.payload as ProjectMemory), revision: row.revision };
  }

  async update(
    memoryId: string,
    projectId: string,
    expectedRevision: number,
    patch: MemoryRecordPatch,
  ): Promise<ProjectMemory | null> {
    const owner = requireOwner();
    const existing = await this.get(memoryId, projectId);
    if (existing === null || existing.revision !== expectedRevision) return null;
    const at = this.now().toISOString();
    const updated: ProjectMemory = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.verificationStatus !== undefined
        ? { verificationStatus: patch.verificationStatus }
        : {}),
      ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
      revision: existing.revision + 1,
      updatedAt: at,
    };
    // Compare-and-swap: the row only changes if nobody else moved it first.
    const rows = await this.query.query<{ revision: number }>(
      `update memories
          set title = $2, content = $3, type = $4, status = $5,
              revision = revision + 1, payload = $6, updated_at = $7
        where id = $1 and project_id = $8 and owner_ref = $9 and revision = $10
      returning revision`,
      [
        memoryId,
        updated.title,
        updated.content,
        updated.type,
        updated.status,
        JSON.stringify(updated),
        at,
        projectId,
        owner,
        expectedRevision,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return { ...updated, revision: row.revision };
  }

  async list(query: MemoryListQuery): Promise<readonly ProjectMemory[]> {
    const owner = requireOwner();
    const conditions = ['project_id = $1', 'owner_ref = $2'];
    const values: unknown[] = [query.projectId, owner];
    if (query.workspaceId !== undefined) {
      values.push(query.workspaceId);
      conditions.push(`workspace_id = $${values.length}`);
    }
    if (query.type !== undefined) {
      values.push(query.type);
      conditions.push(`type = $${values.length}`);
    }
    if (query.status !== undefined) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    values.push(query.limit ?? 50);
    const rows = await this.query.query<MemoryRow>(
      `select payload, revision from memories
        where ${conditions.join(' and ')}
        order by ${orderBy(query.sort)}
        limit $${values.length}`,
      values,
    );
    return rows.rows.map((row) => ({ ...(row.payload as ProjectMemory), revision: row.revision }));
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    const owner = requireOwner();
    const conditions = ['project_id = $1', 'owner_ref = $2'];
    const values: unknown[] = [query.projectId, owner];
    if (query.workspaceId !== undefined) {
      values.push(query.workspaceId);
      conditions.push(`workspace_id = $${values.length}`);
    }
    if (query.type !== undefined) {
      values.push(query.type);
      conditions.push(`type = $${values.length}`);
    }
    if (query.status !== undefined) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    if (query.sourceKind !== undefined) {
      values.push(query.sourceKind);
      conditions.push(`payload->'source'->>'kind' = $${values.length}`);
    }
    if (query.text !== undefined && query.text !== '') {
      values.push(`%${query.text.toLowerCase()}%`);
      conditions.push(`lower(title || E'\\n' || content) like $${values.length}`);
    }
    const where = conditions.join(' and ');
    const total = await this.query.query<{ total: number }>(
      `select count(*)::int as total from memories where ${where}`,
      values,
    );
    values.push(query.limit ?? 50);
    const rows = await this.query.query<MemoryRow>(
      `select payload, revision from memories
        where ${where}
        order by updated_at desc, id asc
        limit $${values.length}`,
      values,
    );
    return {
      memories: rows.rows.map((row) => ({
        ...(row.payload as ProjectMemory),
        revision: row.revision,
      })),
      totalMatched: Number(total.rows[0]?.total ?? 0),
    };
  }

  async count(projectId: string): Promise<number> {
    const owner = requireOwner();
    const rows = await this.query.query<{ total: number }>(
      'select count(*)::int as total from memories where project_id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    return Number(rows.rows[0]?.total ?? 0);
  }

  async delete(memoryId: string, projectId: string): Promise<boolean> {
    const owner = requireOwner();
    const rows = await this.query.query(
      'delete from memories where id = $1 and project_id = $2 and owner_ref = $3',
      [memoryId, projectId, owner],
    );
    return rows.rowCount > 0;
  }
}

/** Ordering helper kept exported for parity checks against the in-memory repo. */
export function confidenceRankOf(confidence: string): number {
  return CONFIDENCE_RANK[confidence] ?? 1;
}
