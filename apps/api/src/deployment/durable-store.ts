import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Durable collections for state that must survive a restart.
 *
 * A single JSON file per collection, rewritten atomically (temporary file then
 * rename, so a crash mid-write cannot leave a half file), with writes serialised
 * behind one promise chain. Bounded by design: a collection that grows without
 * limit would rewrite a huge file on every change, so each store states its cap.
 *
 * This is a staging-grade adapter, not a database. It is one process, one disk,
 * no transactions across collections, and no concurrent writers. Anything that
 * needs more than that belongs in a real database, which is what the ports below
 * exist to make possible later.
 */

export interface JsonCollectionOptions<T> {
  readonly dir: string;
  /** File name without extension, e.g. "provider-credentials". */
  readonly name: string;
  /** Stable identity of one record, used for put/get/delete. */
  readonly keyOf: (record: T) => string;
  /** Hard cap; the oldest records beyond it are dropped. */
  readonly maxRecords: number;
  readonly now?: () => Date;
}

interface Envelope<T> {
  readonly version: 1;
  readonly savedAt: string;
  readonly records: readonly T[];
}

export class CollectionCorruptError extends Error {
  constructor(name: string) {
    // The collection name only; never the path or any record contents.
    super(`Stored collection "${name}" could not be read. Refusing to overwrite it.`);
    this.name = 'CollectionCorruptError';
  }
}

export class JsonCollection<T> {
  private loaded = false;
  private records: T[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: JsonCollectionOptions<T>;

  constructor(options: JsonCollectionOptions<T>) {
    this.options = options;
  }

  private get file(): string {
    return join(this.options.dir, `${this.options.name}.json`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Envelope<T>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new CollectionCorruptError(this.options.name);
      }
      this.records = [...parsed.records];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = [];
      } else if (error instanceof CollectionCorruptError) {
        throw error;
      } else {
        // Unreadable or unparseable: refuse rather than start empty and silently
        // overwrite a file that might still hold recoverable data.
        throw new CollectionCorruptError(this.options.name);
      }
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    const envelope: Envelope<T> = {
      version: 1,
      savedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      records: this.records,
    };
    const file = this.file;
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }

  /** Runs one mutation at a time so two requests cannot interleave a rewrite. */
  private write(mutate: () => void): Promise<void> {
    const next = this.queue.then(async () => {
      await this.load();
      mutate();
      await this.flush();
    });
    // A failed write must not poison the queue for every later call.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async readAll(): Promise<readonly T[]> {
    await this.load();
    return [...this.records];
  }

  async get(key: string): Promise<T | undefined> {
    await this.load();
    return this.records.find((record) => this.options.keyOf(record) === key);
  }

  async put(record: T): Promise<void> {
    const key = this.options.keyOf(record);
    await this.write(() => {
      const index = this.records.findIndex((existing) => this.options.keyOf(existing) === key);
      if (index === -1) this.records.push(record);
      else this.records[index] = record;
      const overflow = this.records.length - this.options.maxRecords;
      if (overflow > 0) this.records.splice(0, overflow);
    });
  }

  async delete(key: string): Promise<void> {
    await this.write(() => {
      this.records = this.records.filter((record) => this.options.keyOf(record) !== key);
    });
  }

  /** Removes every record owned by one owner (used for full disconnects). */
  async deleteWhere(predicate: (record: T) => boolean): Promise<void> {
    await this.write(() => {
      this.records = this.records.filter((record) => !predicate(record));
    });
  }

  /** Proves the file can be written, without leaving a record behind. */
  async verifyWritable(): Promise<void> {
    await this.write(() => undefined);
  }
}
