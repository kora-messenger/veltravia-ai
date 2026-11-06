import type { ArchiveStore, StoredArchive } from './ports.js';

/**
 * In-memory archive store.
 *
 * This is DEVELOPMENT storage and says so: archives vanish when the API
 * restarts, exactly like the projects they came from. The `ArchiveStore` port
 * is what a durable store (object storage, a database) would implement.
 */
export class InMemoryArchiveStore implements ArchiveStore {
  private readonly entries = new Map<string, StoredArchive>();

  put(entry: StoredArchive): void {
    this.entries.set(entry.exportId, entry);
  }

  get(exportId: string): StoredArchive | undefined {
    return this.entries.get(exportId);
  }

  delete(exportId: string): void {
    this.entries.delete(exportId);
  }

  idsFor(ownerRef: string): readonly string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.ownerRef === ownerRef)
      .map((entry) => entry.exportId);
  }

  size(): number {
    return this.entries.size;
  }
}
