/**
 * Export metadata and stored objects.
 *
 * The ZIP archive itself never goes in the database. `export_jobs` holds the
 * job, its status and its expiry; `stored_objects` holds the metadata of an
 * archive and a `storage_ref` pointing at wherever the bytes live. Today that
 * is `LocalObjectStore` on a mounted volume; moving to S3/R2/GCS means
 * implementing `ObjectStore` and pointing the server at it. Nothing in the API
 * layer knows which one is in use.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

export interface ExportJobRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly body: Record<string, unknown>;
}

export interface SaveExportJobInput {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string | null;
  readonly body: Record<string, unknown>;
}

interface ExportRow {
  id: string;
  owner_ref: string;
  project_id: string;
  status: string;
  payload: unknown;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}

function toExport(row: ExportRow): ExportJobRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    projectId: row.project_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    body: (row.payload ?? {}) as Record<string, unknown>,
  };
}

export class PostgresExportJobStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async save(input: SaveExportJobInput): Promise<ExportJobRecord> {
    const owner = requireOwner();
    const rows = await this.query.query<ExportRow>(
      `insert into export_jobs
         (id, owner_ref, project_id, status, payload, created_at, updated_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update
         set status = excluded.status,
             payload = excluded.payload,
             updated_at = excluded.updated_at,
             expires_at = excluded.expires_at
         where export_jobs.owner_ref = $2
       returning *`,
      [
        input.id,
        owner,
        input.projectId,
        input.status,
        JSON.stringify(input.body),
        input.createdAt,
        input.updatedAt,
        input.expiresAt ?? null,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw Object.assign(new Error('No export job found for the calling owner.'), {
        name: 'EXPORT_NOT_FOUND',
        code: 'EXPORT_NOT_FOUND',
      });
    }
    return toExport(row);
  }

  async get(exportId: string): Promise<ExportJobRecord | null> {
    const owner = requireOwner();
    const rows = await this.query.query<ExportRow>(
      'select * from export_jobs where id = $1 and owner_ref = $2',
      [exportId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toExport(row);
  }

  async listByProject(projectId: string, limit = 50): Promise<ExportJobRecord[]> {
    const owner = requireOwner();
    const rows = await this.query.query<ExportRow>(
      `select * from export_jobs where project_id = $1 and owner_ref = $2
        order by created_at desc limit $3`,
      [projectId, owner, Math.min(limit, 200)],
    );
    return rows.rows.map(toExport);
  }

  /** Retention sweep. Returns how many expired jobs were removed. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const owner = requireOwner();
    const rows = await this.query.query(
      'delete from export_jobs where owner_ref = $1 and expires_at is not null and expires_at < $2',
      [owner, now],
    );
    return rows.rowCount;
  }
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export interface StoredObjectRecord {
  readonly key: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly contentType: string;
  readonly bytes: number;
  readonly storageRef: string;
  readonly checksum: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface PutObjectInput {
  readonly key: string;
  readonly projectId?: string | null;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly expiresAt?: string | null;
}

/**
 * The port for large/binary artifacts. Implementations write bytes somewhere
 * durable and return a reference; the database only ever holds metadata.
 */
export interface ObjectStore {
  put(input: PutObjectInput): Promise<StoredObjectRecord>;
  get(key: string): Promise<{ record: StoredObjectRecord; bytes: Uint8Array } | null>;
  delete(key: string): Promise<boolean>;
  /** Removes objects past their expiry, including their bytes. */
  sweep(now?: Date): Promise<number>;
}

interface ObjectRow {
  key: string;
  owner_ref: string;
  project_id: string | null;
  content_type: string;
  bytes: string | number;
  storage_ref: string;
  checksum: string;
  created_at: Date;
  expires_at: Date | null;
}

function toObject(row: ObjectRow): StoredObjectRecord {
  return {
    key: row.key,
    ownerRef: row.owner_ref,
    projectId: row.project_id,
    contentType: row.content_type,
    bytes: Number(row.bytes),
    storageRef: row.storage_ref,
    checksum: row.checksum,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
  };
}

export interface LocalObjectStoreOptions {
  /** Directory the bytes are written under. Its parent must be durable. */
  readonly directory: string;
  readonly now?: () => Date;
}

/**
 * Filesystem-backed object store: one file per object, named by the caller's
 * key after validation, so a crafted key cannot escape the directory.
 */
export class LocalObjectStore implements ObjectStore {
  private readonly database: Queryable;
  private readonly directory: string;
  private readonly now: () => Date;

  constructor(database: Queryable, options: LocalObjectStoreOptions) {
    this.database = database;
    this.directory = resolve(options.directory);
    this.now = options.now ?? (() => new Date());
  }

  private pathFor(key: string): string {
    // Keys are generated by the platform (`exports/<id>.zip`), never user text.
    // Reject anything that could traverse or collide with a separator.
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
      throw Object.assign(new Error('Invalid object key.'), { name: 'OBJECT_KEY_INVALID' });
    }
    const path = resolve(join(this.directory, key));
    if (!path.startsWith(`${this.directory}/`) && path !== this.directory) {
      throw Object.assign(new Error('Invalid object key.'), { name: 'OBJECT_KEY_INVALID' });
    }
    return path;
  }

  async put(input: PutObjectInput): Promise<StoredObjectRecord> {
    const owner = requireOwner();
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    const at = this.now().toISOString();
    const rows = await this.database.query<ObjectRow>(
      `insert into stored_objects
         (key, owner_ref, project_id, content_type, bytes, storage_ref, checksum, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (key) do update
         set bytes = excluded.bytes,
             content_type = excluded.content_type,
             storage_ref = excluded.storage_ref,
             checksum = excluded.checksum,
             expires_at = excluded.expires_at
         where stored_objects.owner_ref = $2
       returning *`,
      [
        input.key,
        owner,
        input.projectId ?? null,
        input.contentType,
        input.bytes.byteLength,
        input.key,
        checksum,
        at,
        input.expiresAt ?? null,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      // Someone else owns this key: remove the bytes we just wrote and refuse.
      await rm(path, { force: true });
      throw Object.assign(new Error('The object key is not available.'), {
        name: 'OBJECT_KEY_UNAVAILABLE',
      });
    }
    return toObject(row);
  }

  async get(key: string): Promise<{ record: StoredObjectRecord; bytes: Uint8Array } | null> {
    const owner = requireOwner();
    const rows = await this.database.query<ObjectRow>(
      'select * from stored_objects where key = $1 and owner_ref = $2',
      [key, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    try {
      const bytes = await readFile(this.pathFor(row.storage_ref));
      return { record: toObject(row), bytes: new Uint8Array(bytes) };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    const owner = requireOwner();
    const rows = await this.database.query<{ storage_ref: string }>(
      'delete from stored_objects where key = $1 and owner_ref = $2 returning storage_ref',
      [key, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return false;
    await rm(this.pathFor(row.storage_ref), { force: true });
    return true;
  }

  async sweep(now: Date = this.now()): Promise<number> {
    const owner = requireOwner();
    const rows = await this.database.query<{ storage_ref: string }>(
      `delete from stored_objects
        where owner_ref = $1 and expires_at is not null and expires_at < $2
      returning storage_ref`,
      [owner, now],
    );
    for (const row of rows.rows) {
      await rm(this.pathFor(row.storage_ref), { force: true });
    }
    return rows.rows.length;
  }
}

/** Reads one object's metadata without touching its bytes. */
export async function objectSizeBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Stable id helper for generated archive keys. */
export function archiveKey(projectId: string): string {
  return `exports/${projectId}/${randomUUID()}.zip`;
}
