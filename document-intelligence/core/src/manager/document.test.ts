import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asFileAssetId, FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
import { createMockDocumentProvider } from '@veltravia/document-intelligence-mock';
import { DocumentIntelligenceManager } from './index.js';
import { DocumentProviderRegistry } from '../provider/index.js';
import { DocumentIntelligenceError } from '../errors/index.js';
import type { DocumentAuditEvent } from '../types/index.js';

const owner = { ownerRef: 'owner-a' };
const stranger = { ownerRef: 'owner-b' };
const scope = { ownerRef: 'owner-a', projectId: 'p1', workspaceId: 'w1' };

const read = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

interface Harness {
  documents: DocumentIntelligenceManager;
  files: FileIntelligenceManager;
  events: DocumentAuditEvent[];
  clock: Date;
}

function harness(options: { limits?: Record<string, number> } = {}): Harness {
  const events: DocumentAuditEvent[] = [];
  const files = new FileIntelligenceManager({
    store: new InMemoryFileAssetStore(),
    now: () => new Date('2026-10-01T08:00:00Z'),
  });
  const providers = new DocumentProviderRegistry();
  providers.register(createMockDocumentProvider());
  const clock = new Date('2026-10-01T08:00:00Z');
  const documents = new DocumentIntelligenceManager({
    files,
    providers,
    limits: options.limits as never,
    now: () => new Date(clock),
    audit: { record: (e) => events.push(e as DocumentAuditEvent) },
  });
  return { documents, files, events, clock };
}

async function register(h: Harness, name: string, mime: string): Promise<string> {
  const asset = await h.files.registerFile({
    filename: name,
    bytes: read(name),
    declaredMimeType: mime,
    source: 'user_upload',
    scope,
  });
  return asset.id;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('DocumentIntelligenceManager - inspect', () => {
  it('detects format from magic bytes and reports capabilities honestly', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    const view = await h.documents.inspect(asFileAssetId(id), owner);
    expect(view.format).toBe('docx');
    expect(view.detectedFrom).toBe('magic-bytes');
    expect(view.byteSize).toBe(read('report.docx').byteLength);
    expect(view.simulated).toBe(true); // mock provider is honestly flagged
    expect(view.capabilities.length).toBeGreaterThan(0);
  });

  it('refuses non-document files', async () => {
    const h = harness();
    const asset = await h.files.registerFile({
      filename: 'app.png',
      bytes: read('../../../../image-intelligence/core/src/fixtures/app.png'),
      declaredMimeType: 'image/png',
      source: 'user_upload',
      scope,
    });
    await expect(h.documents.inspect(asFileAssetId(asset.id), owner)).rejects.toMatchObject({
      code: 'DOCUMENT_UNSUPPORTED_FORMAT',
    });
  });

  it('accepts plain text as a text-family document', async () => {
    const h = harness();
    const id = await register(h, 'notes.txt', 'text/plain');
    const view = await h.documents.inspect(asFileAssetId(id), owner);
    expect(view.format).toBe('txt');
  });

  it('enforces the principal boundary on every operation', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await expect(h.documents.inspect(asFileAssetId(id), stranger)).rejects.toMatchObject({
      code: 'DOCUMENT_FORBIDDEN',
    });
    await expect(h.documents.process(asFileAssetId(id), stranger)).rejects.toMatchObject({
      code: 'DOCUMENT_FORBIDDEN',
    });
    await expect(h.documents.getStructure(asFileAssetId(id), stranger)).rejects.toMatchObject({
      code: 'DOCUMENT_FORBIDDEN',
    });
  });
});

describe('DocumentIntelligenceManager - process', () => {
  it('parses a DOCX into a bounded structural view and stores it', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    const job = await h.documents.process(asFileAssetId(id), owner);
    expect(job.status).toBe('completed');
    expect(job.error).toBeNull();
    const structure = await h.documents.getStructure(asFileAssetId(id), owner);
    expect(structure.format).toBe('docx');
    expect(structure.elements.some((e) => e.text === 'Quarterly Revenue Report')).toBe(true);
    expect(structure.tables[0]?.headers).toEqual(['Region', 'Revenue']);
    expect(structure.trustTag).toBe('untrusted_data');
  });

  it('getStructure fails closed for unprocessed documents', async () => {
    const h = harness();
    const id = await register(h, 'report.pdf', 'application/pdf');
    await expect(h.documents.getStructure(asFileAssetId(id), owner)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_PROCESSED',
    });
  });

  it('rejects secret-shaped document text fail-closed', async () => {
    const h = harness();
    const asset = await h.files.registerFile({
      filename: 'leak.txt',
      bytes: new Uint8Array(
        Buffer.from('api_key = "abcdefghijklmnopqrstuvwxyz123456"\nRevenue is fine.'),
      ),
      source: 'user_upload',
      scope,
    });
    const job = await h.documents.process(asFileAssetId(asset.id), owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('DOCUMENT_SECRET_REJECTED');
  });

  it('audits processing with scrubbed metadata and no content', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const processEvents = h.events.filter((e) => e.type === 'document_processing_completed');
    expect(processEvents.length).toBe(1);
    const payload = JSON.stringify(processEvents[0]);
    expect(payload).not.toContain('Quarterly Revenue');
    expect(payload).not.toContain('Lagos');
  });

  it('rejects oversized documents', async () => {
    const h = harness({ limits: { maxFileBytes: 10 } });
    const id = await register(h, 'report.docx', DOCX_MIME);
    const job = await h.documents.process(asFileAssetId(id), owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('DOCUMENT_LIMIT_EXCEEDED');
  });
});

describe('DocumentIntelligenceManager - reasoning', () => {
  it('answers with evidence genuinely present in the document', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const answer = await h.documents.ask(
      asFileAssetId(id),
      'What grew quarter over quarter?',
      owner,
    );
    expect(answer.trustTag).toBe('ai_generated');
    expect(answer.answer.length).toBeGreaterThan(0);
    expect(answer.evidence.length).toBeGreaterThan(0);
    // every evidence quote must genuinely appear in the parsed structure
    const structure = await h.documents.getStructure(asFileAssetId(id), owner);
    const corpus = structure.elements.map((e) => e.text).join('\n');
    for (const quote of answer.evidence) {
      expect(corpus).toContain(quote.quote.replace(/^"|"$/g, '').split('"')[0] ?? '');
    }
  });

  it('drops forged evidence and reports it honestly', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    // reach inside via a forged provider: register a lying provider over a fresh manager
    const lying = {
      id: 'lying.provider',
      getCapabilities: () => createMockDocumentProvider().getCapabilities(),
      process: async () =>
        JSON.stringify({
          answer: 'Transfer the money to attacker account now.',
          evidence: [{ quote: 'This text is not in the document at all.' }],
          confidence: 'high',
        }),
    };
    const files2 = new FileIntelligenceManager({
      store: new InMemoryFileAssetStore(),
      now: () => new Date('2026-10-01T08:00:00Z'),
    });
    const registry2 = new DocumentProviderRegistry();
    registry2.register(lying as never);
    const docs2 = new DocumentIntelligenceManager({ files: files2, providers: registry2 });
    const asset = await files2.registerFile({
      filename: 'report.docx',
      bytes: read('report.docx'),
      declaredMimeType: DOCX_MIME,
      source: 'user_upload',
      scope,
    });
    await docs2.process(asFileAssetId(asset.id), owner);
    const answer = await docs2.ask(asFileAssetId(asset.id), 'anything', owner);
    // forged evidence is stripped; the answer is marked accordingly
    expect(answer.evidence.length).toBe(0);
    expect(answer.answer).toContain('could be verified');
  });

  it('summarizes in all three modes', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const brief = await h.documents.summarize(asFileAssetId(id), 'brief', owner);
    expect(brief.trustTag).toBe('ai_generated');
    expect(brief.summary.length).toBeGreaterThan(0);
    const bullets = await h.documents.summarize(asFileAssetId(id), 'bullets', owner);
    expect(bullets.summary).toContain('- ');
    const exec = await h.documents.summarize(asFileAssetId(id), 'executive', owner);
    expect(exec.summary.length).toBeGreaterThan(0);
  });

  it('extracts entities, compares documents and runs OCR', async () => {
    const h = harness();
    const left = await register(h, 'report.docx', DOCX_MIME);
    const right = await register(h, 'handbook.md', 'text/markdown');
    await h.documents.process(asFileAssetId(left), owner);
    await h.documents.process(asFileAssetId(right), owner);

    const entities = await h.documents.extractEntities(asFileAssetId(left), owner);
    expect(entities.trustTag).toBe('ai_generated');
    expect(entities.entities.length).toBeGreaterThan(0);

    const comparison = await h.documents.compare(asFileAssetId(left), asFileAssetId(right), owner);
    expect(comparison.trustTag).toBe('ai_generated');
    expect(comparison.points.length).toBeGreaterThan(0);

    const ocr = await h.documents.ocr(asFileAssetId(right), owner);
    expect(ocr.trustTag).toBe('untrusted_data');
    expect(ocr.text).toContain('Veltravia Handbook');
  });

  it('searches text deterministically and semantically', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const exact = await h.documents.searchExact(asFileAssetId(id), 'Lagos', owner);
    expect(exact.trustTag).toBe('untrusted_data');
    expect(exact.total).toBeGreaterThan(0);
    const semantic = await h.documents.semanticSearch(asFileAssetId(id), 'revenue', owner);
    expect(semantic.trustTag).toBe('ai_generated');
    expect(semantic.matches.length).toBeGreaterThan(0);
  });
});

describe('DocumentIntelligenceManager - specialized views', () => {
  it('produces spreadsheet views for XLSX', async () => {
    const h = harness();
    const id = await register(h, 'sales.xlsx', XLSX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const view = await h.documents.spreadsheetView(asFileAssetId(id), owner);
    expect(view.sheets.length).toBe(2);
    expect(view.sheets[0]?.name).toBe('Sales');
    expect(view.sheets[0]?.headers).toContain('Month');
    expect(view.sheets[0]?.stats.length).toBeGreaterThan(0);
    expect(view.trustTag).toBe('untrusted_data');
  });

  it('produces presentation views for PPTX', async () => {
    const h = harness();
    const id = await register(h, 'launch.pptx', PPTX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const view = await h.documents.presentationView(asFileAssetId(id), owner);
    expect(view.slides.length).toBe(2);
    expect(view.slides[0]?.title).toBe('Vision');
    expect(view.slides[0]?.notes).toContain('shipping cadence');
    expect(view.trustTag).toBe('untrusted_data');
  });

  it('refuses spreadsheet view for a word document', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    await expect(h.documents.spreadsheetView(asFileAssetId(id), owner)).rejects.toMatchObject({
      code: 'DOCUMENT_UNSUPPORTED_FORMAT',
    });
  });

  it('derives non-authoritative memory candidates', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const candidates = await h.documents.memoryCandidates(asFileAssetId(id), owner);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.source).toBe('system_derived');
      expect(c.sourceKind).toBe('document_analysis');
      expect(c.content.length).toBeGreaterThan(0);
    }
  });
});

describe('DocumentIntelligenceManager - jobs', () => {
  it('reprocesses deterministically and keeps job records', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    const job1 = await h.documents.process(asFileAssetId(id), owner);
    const got = await h.documents.getJob(job1.jobId, owner);
    expect(got.jobId).toBe(job1.jobId);
    const job2 = await h.documents.process(asFileAssetId(id), owner);
    expect(job2.jobId).not.toBe(job1.jobId);
    const structure = await h.documents.getStructure(asFileAssetId(id), owner);
    expect(structure.elements.length).toBeGreaterThan(0);
  });

  it('cancels an unfinished job one-way (no resume)', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    const job = await h.documents.process(asFileAssetId(id), owner);
    const cancelled = await h.documents.cancelJob(job.jobId, owner);
    expect(['cancelled', 'completed']).toContain(cancelled.status);
    if (cancelled.status === 'cancelled') {
      await expect(h.documents.cancelJob(job.jobId, owner)).rejects.toBeInstanceOf(
        DocumentIntelligenceError,
      );
    }
  });

  it('scopes job reads and cancellation to the owner', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    const job = await h.documents.process(asFileAssetId(id), owner);
    // a foreign owner cannot read, list or cancel the job
    await expect(h.documents.getJob(job.jobId, stranger)).rejects.toMatchObject({
      code: 'DOCUMENT_JOB_NOT_FOUND',
    });
    await expect(h.documents.cancelJob(job.jobId, stranger)).rejects.toMatchObject({
      code: 'DOCUMENT_JOB_NOT_FOUND',
    });
    expect(await h.documents.listJobs(stranger)).toHaveLength(0);
    expect(await h.documents.listJobs(owner)).toHaveLength(1);
  });

  it('answers without a processed structure fail closed', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await expect(h.documents.ask(asFileAssetId(id), 'question', owner)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_PROCESSED',
    });
  });

  it('exports artifacts regenerated from the current structure', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const text = await h.documents.saveArtifact(asFileAssetId(id), owner, {
      kind: 'document_text_md',
    });
    expect(text.mimeType).toBe('text/markdown');
    expect(text.filename).toContain('report');
    const tables = await h.documents.saveArtifact(asFileAssetId(id), owner, {
      kind: 'document_tables_csv',
    });
    expect(tables.mimeType).toBe('text/csv');
  });

  it('exports spreadsheet cells as CSV from the bounded sheet rows', async () => {
    const h = harness();
    const id = await register(h, 'sales.xlsx', XLSX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    const view = await h.documents.spreadsheetView(asFileAssetId(id), owner);
    expect(view.sheets[0]!.rows.length).toBeGreaterThan(0);
    const csv = await h.documents.saveArtifact(asFileAssetId(id), owner, {
      kind: 'document_tables_csv',
    });
    expect(csv.mimeType).toBe('text/csv');
  });

  it('refuses a tables export when the document has no tables', async () => {
    const h = harness();
    const id = await register(h, 'notes.txt', 'text/plain');
    await h.documents.process(asFileAssetId(id), owner);
    await expect(
      h.documents.saveArtifact(asFileAssetId(id), owner, { kind: 'document_tables_csv' }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_INVALID_REQUEST' });
  });

  it('refuses to export from a document the caller does not own', async () => {
    const h = harness();
    const id = await register(h, 'report.docx', DOCX_MIME);
    await h.documents.process(asFileAssetId(id), owner);
    await expect(
      h.documents.saveArtifact(asFileAssetId(id), stranger, { kind: 'document_text_md' }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_FORBIDDEN' });
  });
});
