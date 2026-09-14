import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  restoreProject,
  updateProject,
} from './projects';

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECT = {
  id: 'prj-1',
  name: 'Alpha',
  description: 'First project',
  status: 'active',
  projectType: 'web',
  ownerRef: 'user-1',
  workspaceId: null,
  version: '1.0.0',
  revision: 3,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
  metadata: { note: 'internal' },
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

describe('projects api', () => {
  it('lists projects and maps them to safe view models', async () => {
    const fetchImpl = stubFetch({ projects: [PROJECT] });
    const projects = await listProjects();
    expect(fetchImpl).toHaveBeenCalledWith('/api/projects', expect.anything());
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: 'prj-1',
      name: 'Alpha',
      status: 'active',
      projectType: 'web',
      revision: 3,
    });
    // Raw metadata must not pass through to the UI layer.
    expect(projects[0]).not.toHaveProperty('metadata');
    expect(projects[0]).not.toHaveProperty('ownerRef');
  });

  it('rejects malformed project payloads', async () => {
    stubFetch({ projects: [{ id: 'prj-1', status: 'active' }] });
    await expect(listProjects()).rejects.toThrow(/invalid project payload/i);
  });

  it('rejects unknown project statuses', async () => {
    stubFetch({ projects: [{ ...PROJECT, status: 'deleted' }] });
    await expect(listProjects()).rejects.toThrow(/invalid project payload/i);
  });

  it('creates a project WITHOUT a frontend-owned identity', async () => {
    const fetchImpl = stubFetch(PROJECT, 201);
    await createProject({
      name: 'Alpha',
      description: 'First project',
      projectType: 'web',
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // ownerRef is assigned SERVER-SIDE (development default / future auth).
    expect(body.ownerRef).toBeUndefined();
    expect(body).toMatchObject({ name: 'Alpha', description: 'First project', projectType: 'web' });
  });

  it('loads a single project', async () => {
    stubFetch(PROJECT);
    const project = await getProject('prj-1');
    expect(project.id).toBe('prj-1');
  });

  it('sends expectedRevision with updates (revision safety)', async () => {
    const fetchImpl = stubFetch({ ...PROJECT, revision: 4 });
    await updateProject('prj-1', { name: 'Renamed' }, 3);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/projects/prj-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed', expectedRevision: 3 });
  });

  it('archives and restores projects', async () => {
    const archiveFetch = stubFetch({ ...PROJECT, status: 'archived' });
    await archiveProject('prj-1');
    expect((archiveFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      '/api/projects/prj-1/archive',
    );

    const restoreFetch = stubFetch({ ...PROJECT, status: 'active', revision: 4 });
    await restoreProject('prj-1');
    expect((restoreFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      '/api/projects/prj-1/restore',
    );
  });
});
