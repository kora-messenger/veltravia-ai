import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApp } from '../server.js';

const docx = readFileSync(
  new URL('../../../../document-intelligence/core/src/fixtures/report.docx', import.meta.url),
).toString('base64');
const md = readFileSync(
  new URL('../../../../document-intelligence/core/src/fixtures/handbook.md', import.meta.url),
).toString('base64');
const xlsx = readFileSync(
  new URL('../../../../document-intelligence/core/src/fixtures/sales.xlsx', import.meta.url),
).toString('base64');
const pptx = readFileSync(
  new URL('../../../../document-intelligence/core/src/fixtures/launch.pptx', import.meta.url),
).toString('base64');

type App = ReturnType<typeof buildApp>;

async function upload(
  app: App,
  filename: string,
  contentBase64: string,
  mimeType: string,
): Promise<string> {
  const up = await app.inject({
    method: 'POST',
    url: '/api/files',
    payload: {
      filename,
      contentBase64,
      mimeType,
      source: 'user_upload',
      projectId: null,
      workspaceId: null,
    },
  });
  expect(up.statusCode).toBe(201);
  return up.json().id as string;
}

async function processed(app: App, id: string, status = 200) {
  const p = await app.inject({ method: 'POST', url: `/api/documents/${id}/process`, payload: {} });
  expect(p.statusCode).toBe(status);
  if (status !== 200) return p;
  expect(p.json().status).toBe('completed');
  expect(p.json().ownerRef).toBeUndefined();
  return p;
}

describe('document API', () => {
  it('declares an honest simulation and the closed artifact set', async () => {
    const app = buildApp();
    try {
      const c = await app.inject({ method: 'GET', url: '/api/documents/capabilities' });
      expect(c.statusCode).toBe(200);
      expect(c.json().providerIsSimulation).toBe(true);
      expect(c.json().artifactKinds).toContain('document_text_md');
      expect(c.json().summaryModes).toEqual(['brief', 'bullets', 'executive']);
    } finally {
      await app.close();
    }
  });

  it('inspects a DOCX from magic bytes and leaks no internal fields', async () => {
    const app = buildApp();
    try {
      const id = await upload(
        app,
        'report.docx',
        docx,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      const inspect = await app.inject({ method: 'GET', url: `/api/documents/${id}/inspect` });
      expect(inspect.statusCode).toBe(200);
      const view = inspect.json();
      expect(view.format).toBe('docx');
      expect(view.detectedFrom).toBe('magic-bytes');
      expect(view.simulated).toBe(true);
      expect(JSON.stringify(view)).not.toContain('storageKey');
    } finally {
      await app.close();
    }
  });

  it('processes, exposes structure and answers with verified evidence', async () => {
    const app = buildApp();
    try {
      const id = await upload(
        app,
        'report.docx',
        docx,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      await processed(app, id);
      const structure = await app.inject({
        method: 'GET',
        url: `/api/documents/${id}/structure`,
      });
      expect(structure.statusCode).toBe(200);
      expect(structure.json().elements.length).toBeGreaterThan(0);
      expect(structure.json().trustTag).toBe('untrusted_data');
      const answer = await app.inject({
        method: 'POST',
        url: `/api/documents/${id}/ask`,
        payload: { question: 'What is the revenue growth?' },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json().trustTag).toBe('ai_generated');
      expect(Array.isArray(answer.json().evidence)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('refuses reasoning before processing and rejects unknown bodies', async () => {
    const app = buildApp();
    try {
      const id = await upload(app, 'handbook.md', md, 'text/markdown');
      const early = await app.inject({ method: 'GET', url: `/api/documents/${id}/structure` });
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe('DOCUMENT_NOT_PROCESSED');
      const bad = await app.inject({
        method: 'POST',
        url: `/api/documents/${id}/ask`,
        payload: { question: 'x', extra: 1 },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('serves spreadsheet and presentation views with guards', async () => {
    const app = buildApp();
    try {
      const sheetId = await upload(
        app,
        'sales.xlsx',
        xlsx,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      await processed(app, sheetId);
      const sheet = await app.inject({
        method: 'GET',
        url: `/api/documents/${sheetId}/spreadsheet`,
      });
      expect(sheet.statusCode).toBe(200);
      expect(sheet.json().sheets.length).toBeGreaterThan(0);

      const deckId = await upload(
        app,
        'launch.pptx',
        pptx,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      await processed(app, deckId);
      const deck = await app.inject({
        method: 'GET',
        url: `/api/documents/${deckId}/presentation`,
      });
      expect(deck.statusCode).toBe(200);
      expect(deck.json().slides.length).toBeGreaterThan(0);

      const wrong = await app.inject({
        method: 'GET',
        url: `/api/documents/${deckId}/spreadsheet`,
      });
      expect(wrong.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('publishes a derived artifact through the file system', async () => {
    const app = buildApp();
    try {
      const id = await upload(
        app,
        'report.docx',
        docx,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      await processed(app, id);
      const art = await app.inject({
        method: 'POST',
        url: `/api/documents/${id}/artifact`,
        payload: { kind: 'document_text_md' },
      });
      expect(art.statusCode).toBe(201);
      expect(art.json().mimeType).toBe('text/markdown');
      const badKind = await app.inject({
        method: 'POST',
        url: `/api/documents/${id}/artifact`,
        payload: { kind: 'document_exe' },
      });
      expect(badKind.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('scopes jobs to the caller and rejects a foreign owner header', async () => {
    const app = buildApp();
    try {
      const id = await upload(app, 'handbook.md', md, 'text/markdown');
      const job = await processed(app, id);
      const list = await app.inject({ method: 'GET', url: '/api/documents/jobs' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);
      const single = await app.inject({
        method: 'GET',
        url: `/api/documents/jobs/${job.json().jobId}`,
      });
      expect(single.statusCode).toBe(200);
      const foreign = await app.inject({
        method: 'GET',
        url: `/api/documents/${id}/inspect`,
        headers: { 'x-veltravia-owner-ref': 'someone-else' },
      });
      expect(foreign.statusCode).toBe(403);
      const unknownJob = await app.inject({
        method: 'GET',
        url: '/api/documents/jobs/docjob_missing',
      });
      expect(unknownJob.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
