import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApp } from '../server.js';
const contentBase64 = readFileSync(
  new URL('../../../../video-intelligence/core/src/fixtures/demo.mp4', import.meta.url),
).toString('base64');
async function fixture() {
  const app = buildApp();
  const up = await app.inject({
    method: 'POST',
    url: '/api/files',
    payload: {
      filename: 'demo.mp4',
      contentBase64,
      mimeType: 'video/mp4',
      source: 'user_upload',
      projectId: null,
      workspaceId: null,
    },
  });
  expect(up.statusCode).toBe(201);
  return { app, id: up.json().id as string };
}
describe('video API', () => {
  it('declares simulation and container facts', async () => {
    const { app, id } = await fixture();
    try {
      const c = await app.inject({ method: 'GET', url: '/api/video/capabilities' });
      expect(c.json().providerIsSimulation).toBe(true);
      const m = await app.inject({ method: 'GET', url: `/api/video/${id}/inspect` });
      expect(m.statusCode).toBe(200);
      expect(m.json().container.hasAudio).toBe(true);
      expect(m.json().container.width).toBe(320);
      expect(m.json().scope).toBeUndefined();
    } finally {
      await app.close();
    }
  });
  it('processes and exposes trust-tagged analysis', async () => {
    const { app, id } = await fixture();
    try {
      const start = await app.inject({
        method: 'POST',
        url: `/api/video/${id}/process`,
        payload: {},
      });
      expect(start.statusCode).toBe(202);
      expect(start.json().ownerRef).toBeUndefined();
      for (let n = 0; n < 50; n++) {
        const j = await app.inject({ method: 'GET', url: `/api/video/jobs/${start.json().id}` });
        if (j.json().status === 'completed') break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const a = await app.inject({ method: 'GET', url: `/api/video/${id}/analysis` });
      expect(a.statusCode).toBe(200);
      expect(a.json().transcript.trust).toBe('untrusted_data');
      expect(a.json().description.trust).toBe('ai_generated');
    } finally {
      await app.close();
    }
  });
  it.each(['frames', 'scenes', 'transcript', 'ocr', 'timeline', 'summarize', 'extract'])(
    'provides bounded %s operation',
    async (op) => {
      const { app, id } = await fixture();
      try {
        const r = await app.inject({ method: 'POST', url: `/api/video/${id}/${op}`, payload: {} });
        expect(r.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    },
  );
  it('refuses identity spoofing and unknown body fields', async () => {
    const { app, id } = await fixture();
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/video/${id}/inspect`,
        headers: { 'x-veltravia-owner-ref': 'stranger' },
      });
      expect(r.statusCode).toBe(403);
      const bad = await app.inject({
        method: 'POST',
        url: `/api/video/${id}/ask`,
        payload: { question: 'hi', execute: true },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('serves playback with safe headers', async () => {
    const { app, id } = await fixture();
    try {
      const r = await app.inject({ method: 'GET', url: `/api/video/${id}/media` });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.rawPayload.length).toBeGreaterThan(10000);
    } finally {
      await app.close();
    }
  });
  it('returns failure without waiting for process timeout', async () => {
    const app = buildApp();
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/video/missing/process',
        payload: {},
      });
      expect(r.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
