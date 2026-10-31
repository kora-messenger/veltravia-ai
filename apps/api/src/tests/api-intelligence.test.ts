import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../server.js';

type App = ReturnType<typeof buildApp>;

const OWNER = { 'x-veltravia-owner': 'owner-a' };

/** Creates a project, a workspace and two files, everything through the public
 *  API so the test exercises the same path a user does. */
async function seed(app: App) {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Kora Messenger',
      projectType: 'web',
      description: 'Messaging app',
      ownerRef: 'owner-a',
    },
  });
  const projectId = (project.json() as { id: string }).id;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = (workspace.json() as { id: string }).id;
  const create = async (path: string, content: string) =>
    app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path, content },
    });
  await create('spec.md', '# Specification\n\n## Authentication\nEmail sign-in is implemented.\n');
  await create('notes.md', '# Delivery notes\n\n## Deadline\nProject deadline is 2026-12-15.\n');
  return { projectId, workspaceId };
}

describe('GET /api/intelligence/capabilities', () => {
  it('states the reasoning mode honestly and never claims a model', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/intelligence/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      reasoning: { mode: string; simulated: boolean; detail: string };
    };
    expect(['mock_reasoning', 'structural_extract']).toContain(body.reasoning.mode);
    expect(body.reasoning.simulated).toBe(true);
    expect(body.reasoning.detail.length).toBeGreaterThan(10);
  });
});

describe('owner identity', () => {
  it("gives a project the caller's owner when the body omits ownerRef", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'owner-a' },
      payload: { name: 'Header owned', projectType: 'web', description: 'Owned by the header' },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { ownerRef: string }).ownerRef).toBe('owner-a');

    const workspace = await app.inject({
      method: 'POST',
      url: `/api/projects/${(created.json() as { id: string }).id}/workspaces`,
      payload: { name: 'main' },
    });
    const workspaceId = (workspace.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path: 'plan.md', content: '# Plan\n\nDeadline is 2026-12-15.\n' },
    });

    const sources = await app.inject({
      method: 'GET',
      url: '/api/intelligence/sources',
      headers: { 'x-veltravia-owner-ref': 'owner-a' },
    });
    expect(
      (sources.json() as { sources: { name: string }[] }).sources.some(
        (source) => source.name === 'plan.md',
      ),
    ).toBe(true);

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/intelligence/sources',
      headers: { 'x-veltravia-owner-ref': 'owner-b' },
    });
    expect((foreign.json() as { sources: unknown[] }).sources).toHaveLength(0);
  });
});

describe('GET /api/intelligence/sources', () => {
  let app: App;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('lists workspace sources for the owner and reports provider availability', async () => {
    const { projectId } = await seed(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/intelligence/sources?projectId=${projectId}`,
      headers: OWNER,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sources: { sourceId: string; provider: string; name: string; trustTag: string }[];
      providers: { provider: string; available: boolean }[];
    };
    expect(body.sources.some((source) => source.provider === 'workspace')).toBe(true);
    expect(body.sources.every((source) => source.trustTag === 'untrusted_data')).toBe(true);
    const notion = body.providers.find((provider) => provider.provider === 'notion');
    expect(notion?.available).toBe(false);
  });

  it('rejects an unknown provider filter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/sources?provider=dropbox',
      headers: OWNER,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/intelligence/search', () => {
  let app: App;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('finds workspace content with locators and provenance', async () => {
    await seed(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/search?q=deadline',
      headers: OWNER,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      hits: { source: { sourceId: string; contentVersion: string }; locator: { label: string } }[];
    };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]!.locator.label.length).toBeGreaterThan(0);
    expect(body.hits[0]!.source.contentVersion.length).toBeGreaterThan(0);
  });

  it('does not leak another owner’s sources', async () => {
    await seed(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/search?q=deadline',
      headers: { 'x-veltravia-owner': 'owner-b' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { hits: unknown[] }).hits).toHaveLength(0);
  });

  it('rejects a secret-shaped query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/search?q=sk-abcdefghijklmnopqrstuvwx',
      headers: OWNER,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INTELLIGENCE_SECRET_REJECTED',
    );
  });
});

describe('POST /api/intelligence/analyze', () => {
  let app: App;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('answers with cited evidence and a disclosed reasoning mode', async () => {
    await seed(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/analyze',
      headers: OWNER,
      payload: { question: 'What does the specification say about authentication?' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      evidence: { evidenceId: string; locator: { label: string } }[];
      claims: { evidenceIds: string[] }[];
      reasoning: { simulated: boolean; mode: string };
    };
    expect(['answered', 'partial']).toContain(body.status);
    expect(body.evidence.length).toBeGreaterThan(0);
    for (const claim of body.claims)
      for (const id of claim.evidenceIds)
        expect(body.evidence.some((item) => item.evidenceId === id)).toBe(true);
    expect(body.reasoning.simulated).toBe(true);
  });

  it('returns no_evidence rather than inventing an answer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/analyze',
      headers: OWNER,
      payload: { question: 'xylophone zeppelin marmalade' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; gaps: { kind: string }[] };
    expect(body.status).toBe('no_evidence');
    expect(body.gaps.some((gap) => gap.kind === 'no_source')).toBe(true);
  });

  it('requires a question', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/analyze',
      headers: OWNER,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/intelligence/compare', () => {
  it('compares two owner sources and reports the reasoning mode', async () => {
    const app = await buildApp();
    await seed(app);
    const sources = await app.inject({
      method: 'GET',
      url: '/api/intelligence/sources',
      headers: OWNER,
    });
    const ids = (sources.json() as { sources: { sourceId: string }[] }).sources.map(
      (source) => source.sourceId,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/compare',
      headers: OWNER,
      payload: { sourceIds: ids.slice(0, 2) },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      participants: unknown[];
      contradictions: { statements: unknown[] }[];
      reasoning: { simulated: boolean };
    };
    expect(body.participants).toHaveLength(2);
    expect(body.reasoning.simulated).toBe(true);
  });

  it('rejects a comparison of fewer than two sources', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/compare',
      headers: OWNER,
      payload: { sourceIds: ['workspace:one'] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('synthesis jobs', () => {
  it('creates a job, completes it and exposes the result only to its owner', async () => {
    const app = await buildApp();
    await seed(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/intelligence/jobs',
      headers: OWNER,
      payload: { question: 'Summarize the specification' },
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { jobId: string }).jobId;
    let status = 'queued';
    for (let attempt = 0; attempt < 20 && status !== 'completed'; attempt += 1) {
      const poll = await app.inject({
        method: 'GET',
        url: `/api/intelligence/jobs/${jobId}`,
        headers: OWNER,
      });
      status = (poll.json() as { status: string }).status;
      if (status === 'queued' || status === 'running')
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe('completed');
    const result = await app.inject({
      method: 'GET',
      url: `/api/intelligence/jobs/${jobId}/result`,
      headers: OWNER,
    });
    expect(result.statusCode).toBe(200);
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/intelligence/jobs/${jobId}`,
      headers: { 'x-veltravia-owner': 'owner-b' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('rejects an empty question', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/jobs',
      headers: OWNER,
      payload: { question: '  ' },
    });
    expect(response.statusCode).toBe(400);
  });
});
