// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, getWorkspaceTree, listWorkspaces } from './workspaces';

afterEach(() => {
  vi.unstubAllGlobals();
});

const WORKSPACE = {
  id: 'ws-1',
  projectId: 'prj-1',
  name: 'Main',
  status: 'active',
  root: 'workspace://ws-1/',
  revision: 1,
  createdAt: '2026-09-13T10:00:00.000Z',
  metadata: {},
};

function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async () => ({
    ok: status < 300,
    status,
    json: async () => body,
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

describe('workspaces api', () => {
  it('lists project workspaces as safe view models', async () => {
    stubFetch({ workspaces: [WORKSPACE] });
    const workspaces = await listWorkspaces('prj-1');
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ id: 'ws-1', name: 'Main', status: 'active' });
    // The logical root is engine-internal; the UI model drops it.
    expect(workspaces[0]).not.toHaveProperty('root');
  });

  it('rejects malformed workspace payloads', async () => {
    stubFetch({ workspaces: [{ id: 'ws-1', status: 'active' }] });
    await expect(listWorkspaces('prj-1')).rejects.toThrow(/invalid workspace payload/i);
  });

  it('fetches the workspace file tree as safe node metadata (11C-4)', async () => {
    stubFetch({
      nodes: [
        { path: 'README.md', name: 'README.md', type: 'file' },
        { path: 'src', name: 'src', type: 'directory' },
      ],
    });
    const tree = await getWorkspaceTree('ws-1');
    expect(tree).toHaveLength(2);
    expect(tree[0]).toEqual({ path: 'README.md', name: 'README.md', type: 'file' });
    expect(tree[1]).toEqual({ path: 'src', name: 'src', type: 'directory' });
  });

  it('rejects malformed tree nodes (contents never reach the view)', async () => {
    stubFetch({ nodes: [{ path: 'a.md', name: 'a.md', type: 'symlink' }] });
    await expect(getWorkspaceTree('ws-1')).rejects.toThrow(/invalid file tree payload/i);
    stubFetch({ nodes: 'nope' });
    await expect(getWorkspaceTree('ws-1')).rejects.toThrow(/invalid file tree payload/i);
  });

  it('creates a workspace with a name only', async () => {
    const fetchImpl = stubFetch(WORKSPACE, 201);
    await createWorkspace('prj-1', { name: 'Main' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/projects/prj-1/workspaces');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Main' });
  });
});
