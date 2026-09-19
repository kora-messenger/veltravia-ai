import { describe, expect, it, vi } from 'vitest';

import {
  archiveMemory,
  approveMemoryCandidate,
  createMemory,
  deleteMemory,
  getMemoryStats,
  listMemories,
  rejectMemoryCandidate,
  restoreMemory,
  searchMemories,
  verifyMemory,
  markMemoryStale,
} from './memories';
import type { MemoryView } from './memories';

/** A complete, valid memory payload as the API returns it. */
const MEMORY_PAYLOAD = {
  id: 'mem-1',
  projectId: 'prj-1',
  workspaceId: null,
  type: 'technology',
  title: 'Tech stack',
  content: 'The app uses React with Vite.',
  status: 'active',
  confidence: 'high',
  verificationStatus: 'unverified',
  source: { kind: 'user' },
  revision: 1,
  createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-18T10:00:00.000Z',
  lastVerifiedAt: null,
};

function stubFetch(payload: unknown, status = 200) {
  const fetchImpl = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }));
  return fetchImpl;
}

describe('listMemories', () => {
  it('requests the project-scoped list and maps a safe view', async () => {
    const fetchImpl = stubFetch({ memories: [MEMORY_PAYLOAD] });
    const memories = await listMemories('prj 1', { status: 'active', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/projects/prj%201/memories?status=active',
      expect.anything(),
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]).toEqual({
      id: 'mem-1',
      projectId: 'prj-1',
      workspaceId: null,
      type: 'technology',
      title: 'Tech stack',
      content: 'The app uses React with Vite.',
      status: 'active',
      confidence: 'high',
      verificationStatus: 'unverified',
      source: { kind: 'user', referenceId: null },
      revision: 1,
      createdAt: '2026-09-18T10:00:00.000Z',
      updatedAt: '2026-09-18T10:00:00.000Z',
      lastVerifiedAt: null,
    } satisfies MemoryView);
  });

  it('rejects malformed payloads instead of rendering them', async () => {
    const fetchImpl = stubFetch({ memories: [{ id: 'mem-1', title: 42 }] });
    await expect(listMemories('prj-1', { status: 'active', fetchImpl })).rejects.toThrow(
      /Invalid memory payload/,
    );
  });

  it('rejects unknown statuses', async () => {
    const fetchImpl = stubFetch({
      memories: [{ ...MEMORY_PAYLOAD, status: 'superuser' }],
    });
    await expect(listMemories('prj-1', { fetchImpl })).rejects.toThrow(/Invalid memory payload/);
  });
});

describe('searchMemories', () => {
  it('posts the bounded search and reads active memories only', async () => {
    const fetchImpl = stubFetch({ memories: [] });
    await searchMemories('prj-1', 'React', { fetchImpl });
    const [path, init] = fetchImpl.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/api/projects/prj-1/memories/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'React', status: 'active' });
  });
});

describe('createMemory', () => {
  it('sends exactly the typed create body', async () => {
    const fetchImpl = stubFetch(MEMORY_PAYLOAD, 201);
    await createMemory('prj-1', {
      title: 'Tech stack',
      content: 'The app uses React with Vite.',
      type: 'technology',
      confidence: 'high',
      fetchImpl,
    });
    const [path, init] = fetchImpl.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/api/projects/prj-1/memories');
    expect(JSON.parse(init.body)).toEqual({
      title: 'Tech stack',
      content: 'The app uses React with Vite.',
      type: 'technology',
      confidence: 'high',
    });
  });
});

describe('memory actions', () => {
  it('targets the exact action endpoint for each lifecycle operation', async () => {
    const actions: Array<[string, (fetchImpl: typeof fetch) => Promise<unknown>, string]> = [
      ['archive', (f) => archiveMemory('prj-1', 'mem-1', f), 'archive'],
      ['restore', (f) => restoreMemory('prj-1', 'mem-1', f), 'restore'],
      ['verify', (f) => verifyMemory('prj-1', 'mem-1', f), 'verify'],
      ['stale', (f) => markMemoryStale('prj-1', 'mem-1', f), 'stale'],
      ['approve', (f) => approveMemoryCandidate('prj-1', 'mem-1', f), 'approve'],
      ['reject', (f) => rejectMemoryCandidate('prj-1', 'mem-1', f), 'reject'],
    ];
    for (const [label, run, action] of actions) {
      const fetchImpl = stubFetch(MEMORY_PAYLOAD);
      await run(fetchImpl);
      const [path, init] = fetchImpl.mock.calls[0] as [string, { method: string }];
      expect(path, label).toBe(`/api/projects/prj-1/memories/mem-1/${action}`);
      expect(init.method, label).toBe('POST');
    }
  });

  it('deletes with DELETE and expects no body', async () => {
    const fetchImpl = stubFetch(undefined, 204);
    await expect(deleteMemory('prj-1', 'mem-1', fetchImpl)).resolves.toBeUndefined();
    const [path, init] = fetchImpl.mock.calls[0] as [string, { method: string }];
    expect(path).toBe('/api/projects/prj-1/memories/mem-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('getMemoryStats', () => {
  it('maps the stats payload', async () => {
    const fetchImpl = stubFetch({
      total: 4,
      active: 2,
      archived: 1,
      candidates: 1,
      rejected: 0,
      stale: 0,
    });
    const stats = await getMemoryStats('prj-1', { fetchImpl });
    expect(stats).toEqual({
      total: 4,
      active: 2,
      archived: 1,
      candidates: 1,
      rejected: 0,
      stale: 0,
    });
  });

  it('rejects malformed stats', async () => {
    const fetchImpl = stubFetch({ total: 'lots' });
    await expect(getMemoryStats('prj-1', { fetchImpl })).rejects.toThrow(
      /Invalid memory stats payload/,
    );
  });
});
