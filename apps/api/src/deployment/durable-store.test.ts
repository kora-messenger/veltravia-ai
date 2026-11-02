import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionCorruptError, JsonCollection } from './durable-store.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'veltravia-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Row {
  readonly id: string;
  readonly value: string;
  readonly ownerRef: string;
}

function collection(dir: string, maxRecords = 100) {
  return new JsonCollection<Row>({ dir, name: 'rows', keyOf: (row) => row.id, maxRecords });
}

describe('durable collections', () => {
  it('keeps records across a fresh instance, which is what a restart is', async () => {
    const dir = await tempDir();
    await collection(dir).put({ id: 'a', value: 'one', ownerRef: 'owner-1' });

    const reopened = collection(dir);
    expect(await reopened.get('a')).toEqual({ id: 'a', value: 'one', ownerRef: 'owner-1' });
  });

  it('replaces a record with the same key instead of duplicating it', async () => {
    const dir = await tempDir();
    const store = collection(dir);
    await store.put({ id: 'a', value: 'one', ownerRef: 'o' });
    await store.put({ id: 'a', value: 'two', ownerRef: 'o' });
    const all = await store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.value).toBe('two');
  });

  it('does not lose a write when two land at once', async () => {
    const dir = await tempDir();
    const store = collection(dir);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.put({ id: `id-${index}`, value: 'v', ownerRef: 'o' }),
      ),
    );
    expect(await store.readAll()).toHaveLength(12);
    // and the file itself holds all twelve, not just the last one
    const onDisk = JSON.parse(await readFile(join(dir, 'rows.json'), 'utf8')) as {
      records: unknown[];
    };
    expect(onDisk.records).toHaveLength(12);
  });

  it('drops the oldest records when the cap is reached', async () => {
    const dir = await tempDir();
    const store = collection(dir, 2);
    await store.put({ id: 'a', value: '1', ownerRef: 'o' });
    await store.put({ id: 'b', value: '2', ownerRef: 'o' });
    await store.put({ id: 'c', value: '3', ownerRef: 'o' });
    expect((await store.readAll()).map((row) => row.id)).toEqual(['b', 'c']);
  });

  it('writes a private file', async () => {
    const dir = await tempDir();
    await collection(dir).put({ id: 'a', value: '1', ownerRef: 'o' });
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(join(dir, 'rows.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('refuses to overwrite a file it cannot read', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'rows.json'), 'not json at all', 'utf8');
    const store = collection(dir);
    await expect(store.readAll()).rejects.toBeInstanceOf(CollectionCorruptError);
    // and the unreadable file is still there, byte for byte
    expect(await readFile(join(dir, 'rows.json'), 'utf8')).toBe('not json at all');
  });

  it('names no path or contents in the corruption error', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'rows.json'), '{oops', 'utf8');
    const error = await collection(dir)
      .readAll()
      .catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(dir);
  });

  it('proves it can write without leaving a record behind', async () => {
    const dir = await tempDir();
    const store = collection(dir);
    await store.verifyWritable();
    expect(await store.readAll()).toEqual([]);
  });

  it('starts empty when the file has never existed', async () => {
    const dir = await tempDir();
    expect(await collection(dir).readAll()).toEqual([]);
  });
});
