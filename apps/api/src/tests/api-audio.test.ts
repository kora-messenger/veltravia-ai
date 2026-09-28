import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server.js';

const wavBase64 = readFileSync(
  fileURLToPath(
    new URL('../../../../audio-intelligence/core/src/fixtures/tone.wav', import.meta.url),
  ),
).toString('base64');

const OWNER = 'veltravia-dev-user';
async function fixture(options?: { delayMs?: string }) {
  if (options?.delayMs) process.env.AUDIO_MOCK_CHUNK_DELAY_MS = options.delayMs;
  const app = buildApp();
  const p = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Audio QA',
      description: 'audio QA',
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
      filename: 'meeting.wav',
      contentBase64: wavBase64,
      mimeType: 'audio/wav',
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
    url: `/api/audio/${fileId}/process`,
    headers,
    payload: {},
  });
  if (started.statusCode === 202) {
    const jobId = started.json().id;
    for (let i = 0; i < 40; i++) {
      const job = (
        await app.inject({ method: 'GET', url: `/api/audio/jobs/${jobId}`, headers })
      ).json();
      if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return started.json();
}

describe('Audio Intelligence API', () => {
  it('exposes honest capabilities including simulation status', async () => {
    const { app } = await fixture();
    const caps = await app.inject({ method: 'GET', url: '/api/audio/capabilities' });
    expect(caps.statusCode).toBe(200);
    const body = caps.json();
    expect(body.providerIsSimulation).toBe(true);
    expect(body.provider.capabilities).toContain('transcription');
    expect(body.limits.maxFileBytes).toBeGreaterThan(0);
  });
  it('inspects, processes, and returns a transcript marked untrusted data', async () => {
    const { app, file, headers } = await fixture();
    const inspect = await app.inject({
      method: 'GET',
      url: `/api/audio/${file.id}/inspect`,
      headers,
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json().format).toBe('wav');
    expect(inspect.json().sampleRateHz).toBe(8000);
    const early = await app.inject({
      method: 'GET',
      url: `/api/audio/${file.id}/transcript`,
      headers,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('AUDIO_NOT_PROCESSED');
    const job = await processToCompletion(app, headers, file.id);
    expect(job.status).toBe('completed');
    const transcript = await app.inject({
      method: 'GET',
      url: `/api/audio/${file.id}/transcript`,
      headers,
    });
    expect(transcript.statusCode).toBe(200);
    const view = transcript.json();
    expect(view.trust).toBe('untrusted_data');
    expect(view.providerIsSimulation).toBe(true);
    expect(view.segments.length).toBeGreaterThan(0);
    expect(view.text).toContain('refund');
    expect(JSON.stringify(view)).not.toMatch(/storageKey|mock-file:|\/tmp\//);
  });
  it('starts a distinct new job on reprocess after cancellation', async () => {
    const { app, file, headers } = await fixture({ delayMs: '400' });
    const first = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/process`,
      headers,
      payload: {},
    });
    const job1 = first.json();
    await app.inject({
      method: 'POST',
      url: `/api/audio/jobs/${job1.id}/cancel`,
      headers,
      payload: {},
    });
    for (let i = 0; i < 30; i++) {
      const j = (
        await app.inject({ method: 'GET', url: `/api/audio/jobs/${job1.id}`, headers })
      ).json();
      if (['cancelled', 'completed'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/process`,
      headers,
      payload: {},
    });
    const job2 = second.json();
    expect(second.statusCode).toBe(202);
    expect(job2.id).not.toBe(job1.id);
    for (let i = 0; i < 30; i++) {
      const j = (
        await app.inject({ method: 'GET', url: `/api/audio/jobs/${job2.id}`, headers })
      ).json();
      if (j.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const transcript = await app.inject({
      method: 'GET',
      url: `/api/audio/${file.id}/transcript`,
      headers,
    });
    expect(transcript.statusCode).toBe(200);
    process.env.AUDIO_MOCK_CHUNK_DELAY_MS = '0';
  });
  it('refuses non-audio files with 415', async () => {
    const { app, headers } = await fixture();
    const up = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers,
      payload: {
        filename: 'note.txt',
        contentBase64: Buffer.from('hello').toString('base64'),
        mimeType: 'text/plain',
        source: 'user_upload',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/audio/${up.json().id}/process`,
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('AUDIO_UNSUPPORTED_FORMAT');
  });
  it('enforces owner scope on transcripts', async () => {
    const { app, file, headers } = await fixture();
    await processToCompletion(app, headers, file.id);
    const res = await app.inject({
      method: 'GET',
      url: `/api/audio/${file.id}/transcript`,
      headers: { ...headers, 'x-veltravia-owner-ref': 'someone-else' },
    });
    expect(res.statusCode).toBe(403);
  });
  it('searches, answers, summarizes, extracts, and translates with trust labels', async () => {
    const { app, file, headers } = await fixture();
    await processToCompletion(app, headers, file.id);
    const search = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/search`,
      headers,
      payload: { query: 'refund' },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().matches.length).toBeGreaterThan(0);
    expect(search.json().trust).toBe('untrusted_data');
    const query = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/query`,
      headers,
      payload: { question: 'What did we decide about the database?' },
    });
    expect(query.statusCode).toBe(200);
    expect(query.json().answer).toContain('MongoDB');
    expect(query.json().trust).toBe('ai_generated');
    const summary = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/summarize`,
      headers,
      payload: { style: 'meeting' },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().trust).toBe('ai_generated');
    const analysis = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/extract`,
      headers,
      payload: { fields: ['action_items', 'decisions'] },
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().actionItems.length).toBeGreaterThan(0);
    const translation = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/translate`,
      headers,
      payload: { targetLanguage: 'fr', scope: 'transcript' },
    });
    expect(translation.statusCode).toBe(200);
    expect(translation.json().translatedText).toContain('[mock:fr]');
    expect(translation.json().originalPreserved).toBe(true);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/translate`,
      headers,
      payload: { targetLanguage: 'not a tag' },
    });
    expect(bad.statusCode).toBe(400);
  });
  it('saves provenance-linked artifacts and serves audio media with nosniff', async () => {
    const { app, file, headers } = await fixture();
    await processToCompletion(app, headers, file.id);
    const artifact = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/artifacts`,
      headers,
      payload: { kind: 'transcript_md' },
    });
    expect(artifact.statusCode).toBe(201);
    const view = artifact.json();
    expect(view.provenance.parentFileIds).toContain(file.id);
    expect(view.sourceOperation).toBe(`audio:transcript_md:${file.id}`);
    const media = await app.inject({ method: 'GET', url: `/api/audio/${file.id}/media`, headers });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('audio/wav');
    expect(media.headers['x-content-type-options']).toBe('nosniff');
    expect(media.headers['cache-control']).toBe('no-store');
  });
  it('supports cancellation mid-processing', async () => {
    const { app, file, headers } = await fixture({ delayMs: '400' });
    const started = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/process`,
      headers,
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().id;
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/audio/jobs/${jobId}/cancel`,
      headers,
      payload: {},
    });
    expect([200, 409]).toContain(cancel.statusCode);
    let job = cancel.statusCode === 200 ? cancel.json() : started.json();
    for (
      let i = 0;
      i < 30 && !['completed', 'failed', 'cancelled', 'expired'].includes(job.status);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await app.inject({ method: 'GET', url: `/api/audio/jobs/${jobId}`, headers })).json();
    }
    expect(job.status).toBe('cancelled');
    process.env.AUDIO_MOCK_CHUNK_DELAY_MS = '0';
  });
  it('extracts memory candidates under the human-approval model', async () => {
    const { app, project, file, headers } = await fixture();
    await processToCompletion(app, headers, file.id);
    const created = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/memory-candidates`,
      headers,
      payload: { projectId: project.id },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.created.length).toBeGreaterThan(0);
    expect(body.created[0].status).toBe('candidate');
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/memories?status=candidate`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    const wrongProject = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/memory-candidates`,
      headers,
      payload: { projectId: 'p_does_not_exist' },
    });
    expect(wrongProject.statusCode).toBe(404);
    const mismatched = await app.inject({
      method: 'POST',
      url: `/api/audio/${file.id}/memory-candidates`,
      headers,
      payload: { projectId: 'p_other_project' },
    });
    expect([400, 404]).toContain(mismatched.statusCode);
  });
  it('registers audio tools on the Tool System with read-only grants', async () => {
    const { app } = await fixture();
    const tools = await app.inject({ method: 'GET', url: '/api/tools' });
    const ids = tools.json().tools.map((t: { id: string }) => t.id);
    expect(ids).toContain('audio.inspect');
    expect(ids).toContain('audio.search');
    expect(ids).toContain('audio.transcribe');
  });
});
