/**
 * Content-addressed blob store (Step 31).
 *
 * Project source files live in the project engine's tree; snapshots need
 * somewhere durable to keep the CONTENT they captured. That is what this store
 * is: blobs keyed by `sha256:<hex>`, so identical content is stored once and a
 * snapshot can be restored without reading the working tree.
 *
 * The interface is deliberately narrow (put/get/has/delete/stats) because the
 * in-memory implementation here is a DEVELOPMENT store, not the production
 * answer. The documented migration is one adapter: the same four calls against
 * S3/GCS/R2 with the hash as the object key. Nothing above this layer knows
 * which one is in use.
 */

import { createHash } from 'node:crypto';

import { SourceError } from '../errors/index.js';
import { SOURCE_LIMITS } from '../types/index.js';

/** Stable content hash for a UTF-8 string. */
export function contentHashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Byte length of a UTF-8 string without allocating a second copy. */
export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** The storage boundary. Production swaps the implementation, not the model. */
export interface ContentStore {
  put(content: string): Promise<{ readonly hash: string; readonly size: number }>;
  get(hash: string): Promise<string | null>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
  stats(): ContentStoreStatsView;
}

export interface ContentStoreStatsView {
  readonly implementation: string;
  readonly durable: boolean;
  readonly blobs: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
}

/**
 * In-memory content store: deterministic, dependency-free, and honest about
 * being non-durable. The `durable: false` flag travels to the API and the UI so
 * nobody mistakes it for permanent storage.
 */
export class InMemoryContentStore implements ContentStore {
  private readonly blobs = new Map<string, string>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxBytes: number = SOURCE_LIMITS.maxRepositoryBytes) {}

  async put(content: string): Promise<{ readonly hash: string; readonly size: number }> {
    const size = byteLength(content);
    if (size > SOURCE_LIMITS.maxBlobBytes) {
      throw new SourceError(
        'SOURCE_FILE_TOO_LARGE',
        'That file is larger than a snapshot blob may be.',
        {
          size,
          limit: SOURCE_LIMITS.maxBlobBytes,
        },
      );
    }
    const hash = contentHashOf(content);
    if (this.blobs.has(hash)) return { hash, size };
    if (this.bytes + size > this.maxBytes) {
      throw new SourceError(
        'SOURCE_LIMIT_EXCEEDED',
        'Snapshot storage for this repository is full.',
        {
          limit: this.maxBytes,
        },
      );
    }
    this.blobs.set(hash, content);
    this.bytes += size;
    return { hash, size };
  }

  async get(hash: string): Promise<string | null> {
    const content = this.blobs.get(hash);
    if (content === undefined) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return content;
  }

  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async delete(hash: string): Promise<void> {
    const content = this.blobs.get(hash);
    if (content === undefined) return;
    this.bytes -= byteLength(content);
    this.blobs.delete(hash);
  }

  stats(): ContentStoreStatsView {
    return {
      implementation: 'in-memory',
      durable: false,
      blobs: this.blobs.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

/**
 * Build a deterministic tree manifest. The hash covers paths, content hashes
 * and sizes, so two trees with the same files yield the same manifest hash and
 * a single differing byte changes it.
 */
export function buildManifest(
  files: readonly { readonly path: string; readonly contentHash: string; readonly size: number }[],
): {
  readonly files: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly size: number;
  }[];
  readonly hash: string;
  readonly bytes: number;
} {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const canonical = sorted
    .map((file) => `${file.path}\u0000${file.contentHash}\u0000${file.size}`)
    .join('\n');
  return {
    files: sorted,
    hash: contentHashOf(canonical),
    bytes: sorted.reduce((total, file) => total + file.size, 0),
  };
}
