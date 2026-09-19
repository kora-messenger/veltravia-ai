import { describe, expect, it } from 'vitest';

import { MemoryManager, type CreateMemoryInput } from '@veltravia/memory-core';
import { InMemoryMemoryRepository } from '@veltravia/memory-mock';

let tick = 0;
const fixedNow = () => new Date(Date.UTC(2026, 8, 18, 12, 0, 0) + tick++ * 1000);

const input = (overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput => ({
  projectId: 'prj_a',
  type: 'convention',
  title: 'Commit style',
  content: 'Use conventional commits.',
  source: { kind: 'user' },
  ...overrides,
});

describe('InMemoryMemoryRepository', () => {
  it('assigns deterministic sequential ids', async () => {
    const repository = new InMemoryMemoryRepository({ now: fixedNow, idPrefix: 'mem' });
    const first = await repository.create(input());
    const second = await repository.create(input());
    expect(first.id).toBe('mem_000001');
    expect(second.id).toBe('mem_000002');
  });

  it('enforces the revision check: nothing written on mismatch', async () => {
    const repository = new InMemoryMemoryRepository({ now: fixedNow });
    const created = await repository.create(input());
    const updated = await repository.update(created.id, 'prj_a', 1, { title: 'New title' });
    expect(updated?.revision).toBe(2);
    const stale = await repository.update(created.id, 'prj_a', 1, { title: 'Stale title' });
    expect(stale).toBeNull();
    const current = await repository.get(created.id, 'prj_a');
    expect(current?.title).toBe('New title');
  });

  it('cross-project get/update/delete resolve to nothing', async () => {
    const repository = new InMemoryMemoryRepository({ now: fixedNow });
    const created = await repository.create(input());
    expect(await repository.get(created.id, 'prj_other')).toBeNull();
    expect(await repository.update(created.id, 'prj_other', 1, { title: 'X' })).toBeNull();
    expect(await repository.delete(created.id, 'prj_other')).toBe(false);
    expect(await repository.get(created.id, 'prj_a')).not.toBeNull();
  });

  it('returns immutable clones (mutation cannot corrupt state)', async () => {
    const repository = new InMemoryMemoryRepository({ now: fixedNow });
    const created = await repository.create(input());
    created.source.kind = 'system_derived';
    const fetched = await repository.get(created.id, 'prj_a');
    expect(fetched?.source.kind).toBe('user');
  });

  it('search reports totalMatched and respects the limit', async () => {
    const repository = new InMemoryMemoryRepository({ now: fixedNow });
    const manager = new MemoryManager({ repository, now: fixedNow });
    for (let index = 0; index < 5; index += 1) {
      await manager.create(input({ title: `Auth note ${index}`, content: 'Token flow' }));
    }
    const result = await repository.search({ projectId: 'prj_a', text: 'token', limit: 2 });
    expect(result.totalMatched).toBe(5);
    expect(result.memories).toHaveLength(2);
  });
});
