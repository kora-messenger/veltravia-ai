import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server.js';

const pngBase64 = readFileSync(
  fileURLToPath(
    new URL('../../../../image-intelligence/core/src/fixtures/app.png', import.meta.url),
  ),
).toString('base64');

const OWNER = 'veltravia-dev-user';
async function fixture(options?: { delayMs?: string }) {
  if (options?.delayMs) process.env.IMAGE_MOCK_LATENCY_MS = options.delayMs;
  const app = buildApp();
  const p = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Image QA',
      description: 'image QA',
      projectType: 'web',
      ownerRef: OWNER,
    },
  });
  const project = p.json();
  const w = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/workspaces`,
    payload: { name: 'main' },
  });
  const workspace = w.json();
  const headers = {
    'x-veltravia-owner-ref': OWNER,
    'x-veltravia-project-id': project.id,
    'x-veltravia-workspace-id': workspace.id,
  };
  const up = await app.inject({
    method: 'POST',
    url: '/api/files',
    headers,
    payload: {
      filename: 'app.png',
      contentBase64: pngBase64,
      mimeType: 'image/png',
      source: 'user_upload',
      projectId: project.id,
      workspaceId: workspace.id,
    },
  });
  expect(up.statusCode).toBe(201);
  return { app, project, workspace, headers, file: up.json() };
}
async function processToCompletion(
  app: ReturnType<typeof buildApp>,
  headers: object,
  fileId: string,
) {
  const started = await app.inject({
    method: 'POST',
    url: `/api/image/${fileId}/process`,
    headers,
    payload: {},
  });
  if (started.statusCode === 202) {
    const jobId = started.json().id;
    for (let i = 0; i < 40; i++) {
      const job = (
        await app.inject({ method: 'GET', url: `/api/image/jobs/${jobId}`, headers })
      ).json();
      if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return started.json();
}

describe('Image Intelligence API', () => {
  it('exposes honest capabilities including simulation status', async () => {
    const { app } = await fixture();
    const caps = await app.inject({ method: 'GET', url: '/api/image/capabilities' });
    expect(caps.statusCode).toBe(200);
    const body = caps.json();
    expect(body.providerIsSimulation).toBe(true);
    expect(body.providers[0].capabilities).toContain('image_understanding');
    expect(body.operations).toContain('describe');
    expect(body.limits.maxFileBytes).toBeGreaterThan(0);
  });

  it('inspects, processes, and returns analysis with trust labels', async () => {
    const { app, file, headers } = await fixture();
    const inspect = await app.inject({
      method: 'GET',
      url: `/api/image/${file.id}/inspect`,
      headers,
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json().format).toBe('png');
    const early = await app.inject({
      method: 'GET',
      url: `/api/image/${file.id}/analysis`,
      headers,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('IMAGE_NOT_PROCESSED');
    const job = await processToCompletion(app, headers, file.id);
    expect(job.status).toBe('completed');
    const analysis = await app.inject({
      method: 'GET',
      url: `/api/image/${file.id}/analysis`,
      headers,
    });
    expect(analysis.statusCode).toBe(200);
    const view = analysis.json();
    expect(view.providerIsSimulation).toBe(true);
    expect(view.description.trust).toBe('ai_generated');
    expect(view.ocr.trust).toBe('untrusted_data');
    expect(view.ocr.text).toContain('Veltravia');
    // Safe views only: no storage paths leak.
    expect(JSON.stringify(view)).not.toMatch(/storageKey|mock-file:|\/tmp\//);
  });

  it('refuses non-image files with 415', async () => {
    const { app, headers, project, workspace } = await fixture();
    const up = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers,
      payload: {
        filename: 'note.txt',
        contentBase64: Buffer.from('hello world').toString('base64'),
        mimeType: 'text/plain',
        source: 'user_upload',
        projectId: project.id,
        workspaceId: workspace.id,
      },
    });
    expect(up.statusCode).toBe(201);
    const res = await app.inject({
      method: 'GET',
      url: `/api/image/${up.json().id}/inspect`,
      headers,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('IMAGE_UNSUPPORTED_FORMAT');
  });

  it('enforces owner scope on image analysis', async () => {
    const { app, file } = await fixture();
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/image/${file.id}/inspect`,
      headers: { 'x-veltravia-owner-ref': 'someone-else' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('IMAGE_UNAUTHORIZED');
  });

  it('answers queries, runs screenshot/chart/diagram/extract/compare with trust labels', async () => {
    const { app, file, headers, project, workspace } = await fixture();
    await processToCompletion(app, headers, file.id);
    const query = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/query`,
      headers,
      payload: { question: 'What is shown?' },
    });
    expect(query.statusCode).toBe(200);
    expect(query.json().trust).toBe('ai_generated');
    expect(query.json().providerIsSimulation).toBe(true);
    const badQuery = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/query`,
      headers,
      payload: { question: '' },
    });
    expect(badQuery.statusCode).toBe(400);
    const shot = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/screenshot`,
      headers,
      payload: {},
    });
    expect(shot.statusCode).toBe(200);
    expect(shot.json().issues.length).toBeGreaterThan(0);
    // The mock provider claims a forged region id; it must be neutralized.
    expect(shot.json().issues.some((i: { regionId: string }) => i.regionId === 'r_FORGED')).toBe(
      false,
    );
    const ui = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/ui-structure`,
      headers,
      payload: {},
    });
    expect(ui.statusCode).toBe(200);
    expect(ui.json().elements.length).toBeGreaterThan(0);
    const chart = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/chart`,
      headers,
      payload: {},
    });
    expect(chart.statusCode).toBe(200);
    expect(chart.json().chartType).toBe('bar');
    const diagram = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/diagram`,
      headers,
      payload: {},
    });
    expect(diagram.statusCode).toBe(200);
    expect(diagram.json().relationships).toHaveLength(2);
    const extract = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/extract`,
      headers,
      payload: { fields: ['title', 'projectCount'] },
    });
    expect(extract.statusCode).toBe(200);
    expect(extract.json().fields).toHaveLength(2);
    const other = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers,
      payload: {
        filename: 'purple.png',
        contentBase64: readFileSync(
          fileURLToPath(
            new URL('../../../../image-intelligence/core/src/fixtures/purple.png', import.meta.url),
          ),
        ).toString('base64'),
        mimeType: 'image/png',
        source: 'user_upload',
        projectId: project.id,
        workspaceId: workspace.id,
      },
    });
    const compare = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/compare`,
      headers,
      payload: { otherFileId: other.json().id },
    });
    expect(compare.statusCode).toBe(200);
    expect(compare.json().differences.length).toBeGreaterThan(0);
  });

  it('searches stored OCR deterministically', async () => {
    const { app, file, headers } = await fixture();
    await processToCompletion(app, headers, file.id);
    const within = await app.inject({
      method: 'GET',
      url: `/api/image/${file.id}/search?q=dashboard`,
      headers,
    });
    expect(within.statusCode).toBe(200);
    expect(within.json().trust).toBe('untrusted_data');
    expect(within.json().matches.length).toBeGreaterThan(0);
    const across = await app.inject({
      method: 'POST',
      url: '/api/image/search',
      headers,
      payload: { query: 'Projects', projectId: undefined },
    });
    expect(across.statusCode).toBe(200);
    expect(across.json().matches.length).toBeGreaterThan(0);
  });

  it('saves provenance-linked artifacts and serves media with nosniff', async () => {
    const { app, file, headers } = await fixture();
    await processToCompletion(app, headers, file.id);
    const artifact = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/artifact`,
      headers,
      payload: { kind: 'image_analysis_json' },
    });
    expect(artifact.statusCode).toBe(201);
    expect(artifact.json().filename.endsWith('-analysis.json')).toBe(true);
    expect(artifact.json().projectId).toBeTruthy();
    const unprocessed = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/artifact`,
      headers,
      payload: { kind: 'image_comparison_json' },
    });
    expect(unprocessed.statusCode).toBe(400);
    expect(unprocessed.json().error.code).toBe('IMAGE_ARTIFACT_INVALID');
    const media = await app.inject({
      method: 'GET',
      url: `/api/image/${file.id}/media`,
      headers,
    });
    expect(media.statusCode).toBe(200);
    expect(media.headers['x-content-type-options']).toBe('nosniff');
    expect(media.headers['cache-control']).toBe('no-store');
  });

  it('supports cancellation mid-processing', async () => {
    const { app, file, headers } = await fixture({ delayMs: '600' });
    const started = await app.inject({
      method: 'POST',
      url: `/api/image/${file.id}/process`,
      headers,
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().id;
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/image/jobs/${jobId}/cancel`,
      headers,
    });
    expect([200, 409]).toContain(cancelled.statusCode);
    let final: { status: string } = { status: 'unknown' };
    for (let i = 0; i < 40; i++) {
      final = (
        await app.inject({ method: 'GET', url: `/api/image/jobs/${jobId}`, headers })
      ).json();
      if (['completed', 'failed', 'cancelled', 'expired'].includes(final.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(['cancelled', 'failed']).toContain(final.status);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/image/jobs/imagejob_missing',
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('registers image tools on the Tool System with read-only grants', async () => {
    const { app } = await fixture();
    const tools = await app.inject({ method: 'GET', url: '/api/tools' });
    const ids = tools.json().tools.map((t: { id: string }) => t.id);
    expect(ids).toContain('image.inspect');
    expect(ids).toContain('image.search');
    expect(ids).toContain('image.analyze');
  });
});
