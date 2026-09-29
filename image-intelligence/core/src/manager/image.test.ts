import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
import { ImageIntelligenceManager } from './index.js';
import { ImageProviderRegistry } from '../provider/index.js';
import {
  createMockImageProvider,
  INJECTION_IMAGE_SCRIPT,
} from '@veltravia/image-intelligence-mock';
import { ImageIntelligenceError } from '../errors/index.js';
import type { ImageAuditEvent, ImageProvider } from '../types/index.js';

const owner = { ownerRef: 'owner-a' };
const stranger = { ownerRef: 'owner-b' };
const scope = { ownerRef: 'owner-a', projectId: 'p1', workspaceId: 'w1' };
const sha = (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const read = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));
const appPng = read('app.png');
const bluePng = read('blue.png');
const injectPng = read('inject.png');

interface Harness {
  image: ImageIntelligenceManager;
  files: FileIntelligenceManager;
  events: ImageAuditEvent[];
  clock: Date;
  registry: ImageProviderRegistry;
}

function harness(
  options: {
    limits?: Record<string, number>;
    provider?: ImageProvider;
  } = {},
): Harness {
  const events: ImageAuditEvent[] = [];
  const files = new FileIntelligenceManager({
    store: new InMemoryFileAssetStore(),
    now: () => new Date('2026-09-29T08:00:00Z'),
  });
  const registry = new ImageProviderRegistry();
  registry.register(
    options.provider ??
      createMockImageProvider({
        scripts: {
          [sha(injectPng)]: INJECTION_IMAGE_SCRIPT,
        },
      }),
  );
  const clock = new Date('2026-09-29T08:00:00Z');
  const image = new ImageIntelligenceManager({
    files,
    providers: registry,
    limits: options.limits as never,
    now: () => new Date(clock),
    audit: { record: (e) => events.push(e as ImageAuditEvent) },
  });
  return { image, files, events, clock, registry };
}

async function registerPng(h: Harness, name = 'app.png', bytes = appPng) {
  return h.files.registerFile({
    filename: name,
    bytes,
    declaredMimeType: 'image/png',
    source: 'user_upload',
    scope,
  });
}

describe('ImageIntelligenceManager - inspect', () => {
  it('returns safe metadata with PNG color info', async () => {
    const h = harness();
    const file = await registerPng(h);
    const meta = await h.image.inspect(file.id, owner);
    expect(meta.format).toBe('png');
    expect(meta.byteSize).toBe(appPng.length);
    expect(meta.scope.projectId).toBe('p1');
    expect(meta.colorInfo?.bitDepth).toBe(8);
    // PNG is not an animated container: honest null, never a guess.
    expect(meta.animated).toBeNull();
  });

  it('refuses non-image files', async () => {
    const h = harness();
    const text = await h.files.registerFile({
      filename: 'note.txt',
      bytes: Buffer.from('hello'),
      source: 'user_upload',
      scope,
    });
    await expect(h.image.inspect(text.id, owner)).rejects.toMatchObject({
      code: 'IMAGE_UNSUPPORTED_FORMAT',
    });
  });

  it('enforces the principal boundary', async () => {
    const h = harness();
    const file = await registerPng(h);
    await expect(h.image.inspect(file.id, stranger)).rejects.toMatchObject({
      code: 'IMAGE_UNAUTHORIZED',
    });
    await expect(h.image.process(file.id, stranger)).rejects.toMatchObject({
      code: 'IMAGE_UNAUTHORIZED',
    });
  });
});

describe('ImageIntelligenceManager - processing pipeline', () => {
  it('processes an image: description + OCR stored, job completed', async () => {
    const h = harness();
    const file = await registerPng(h);
    const job = await h.image.process(file.id, owner);
    expect(job.status).toBe('completed');
    expect(job.operations).toBe(2);
    expect(job.completedOperations).toBe(2);
    const analysis = await h.image.analysis(file.id, owner);
    expect(analysis.description?.summary).toContain('image');
    expect(analysis.ocr?.trust).toBe('untrusted_data');
    expect(analysis.ocr?.regions.length).toBeGreaterThan(0);
    // Audit trail is bounded metadata only.
    const types = h.events.map((e) => e.type);
    expect(types).toContain('image_processing_started');
    expect(types).toContain('image_job_completed');
  });

  it('rejects analysis before processing', async () => {
    const h = harness();
    const file = await registerPng(h);
    await expect(h.image.analysis(file.id, owner)).rejects.toMatchObject({
      code: 'IMAGE_NOT_PROCESSED',
    });
  });

  it('rejects oversized images', async () => {
    const h = harness({ limits: { maxFileBytes: 8 } });
    const file = await registerPng(h);
    await expect(h.image.process(file.id, owner)).rejects.toMatchObject({
      code: 'IMAGE_LIMIT_EXCEEDED',
    });
  });

  it('fails the job honestly when the provider errors', async () => {
    const h = harness({
      provider: createMockImageProvider({
        scripts: { [sha(appPng)]: { outputs: {}, failWith: 'provider_error' } },
      }),
    });
    const file = await registerPng(h);
    const job = await h.image.process(file.id, owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('IMAGE_PROVIDER_ERROR');
    expect(h.events.map((e) => e.type)).toContain('image_job_failed');
  });

  it('times out jobs that exceed the processing ceiling', async () => {
    const h = harness({
      limits: { maxProcessingMs: 50 },
      provider: createMockImageProvider({
        latencyMs: 400,
        scripts: {},
      }),
    });
    const file = await registerPng(h);
    const job = await h.image.process(file.id, owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('IMAGE_PROVIDER_TIMEOUT');
  });

  it('fails honestly on malformed provider output', async () => {
    const h = harness({
      provider: createMockImageProvider({
        scripts: { [sha(appPng)]: { outputs: {}, failWith: 'malformed' } },
      }),
    });
    const file = await registerPng(h);
    const job = await h.image.process(file.id, owner);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('IMAGE_PROVIDER_ERROR');
  });

  it('refuses processing when no provider supports image understanding', async () => {
    const fresh = new ImageProviderRegistry();
    fresh.register({
      id: 'ocr-only',
      getCapabilities: () => ({
        providerId: 'ocr-only',
        capabilities: ['ocr'],
        supportedFormats: null,
        maxBytes: null,
        maxDimensionPixels: null,
      }),
      analyze: async () => ({ text: '{}' }),
    });
    const files = new FileIntelligenceManager({
      store: new InMemoryFileAssetStore(),
      now: () => new Date('2026-09-29T08:00:00Z'),
    });
    const image = new ImageIntelligenceManager({ files, providers: fresh });
    const file = await files.registerFile({
      filename: 'app.png',
      bytes: appPng,
      declaredMimeType: 'image/png',
      source: 'user_upload',
      scope,
    });
    await expect(image.process(file.id, owner)).rejects.toMatchObject({
      code: 'IMAGE_CAPABILITY_UNSUPPORTED',
    });
  });

  it('supports cancellation mid-run', async () => {
    const h = harness({
      provider: createMockImageProvider({ latencyMs: 150, scripts: {} }),
    });
    const file = await registerPng(h);
    const promise = h.image.process(file.id, owner);
    // Give the provider call a moment to start, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    const jobs = h.image.listJobs(owner);
    const cancelled = h.image.cancelJob(jobs[0]!.id, owner);
    expect(cancelled.status).toBe('cancelled');
    const final = await promise;
    expect(final.status).toBe('cancelled');
    expect(h.events.map((e) => e.type)).toContain('image_job_cancelled');
  });

  it('expires stale jobs', async () => {
    const h = harness();
    const file = await registerPng(h);
    await h.image.process(file.id, owner);
    h.clock.setHours(h.clock.getHours() + 25);
    const jobs = h.image.listJobs(owner);
    expect(
      jobs.every((j) => ['completed', 'expired', 'cancelled', 'failed'].includes(j.status)),
    ).toBe(true);
  });

  it('refuses unknown jobs', () => {
    const h = harness();
    expect(() => h.image.getJob('imagejob_missing' as never, owner)).toThrow(
      ImageIntelligenceError,
    );
  });
});

describe('ImageIntelligenceManager - operations', () => {
  async function processed() {
    const h = harness();
    const file = await registerPng(h);
    await h.image.process(file.id, owner);
    return { h, file };
  }

  it('answers grounded questions', async () => {
    const { h, file } = await processed();
    const r = await h.image.query(file.id, 'What is shown?', owner);
    expect(r.answer.length).toBeGreaterThan(0);
    expect(r.trust).toBe('ai_generated');
    expect(r.question).toBe('What is shown?');
  });

  it('rejects empty questions', async () => {
    const { h, file } = await processed();
    await expect(h.image.query(file.id, '   ', owner)).rejects.toMatchObject({
      code: 'IMAGE_INVALID_REQUEST',
    });
  });

  it('analyzes screenshots without trusting forged region references', async () => {
    const { h, file } = await processed();
    const a = await h.image.screenshot(file.id, owner);
    expect(a.issues.length).toBeGreaterThan(0);
    // The scripted output contains a forged regionId - it must be neutralized.
    expect(a.issues.every((i) => i.regionId === null || i.regionId.startsWith('r_'))).toBe(true);
    expect(a.issues.some((i) => i.regionId === 'r_FORGED')).toBe(false);
  });

  it('extracts UI structure with the visual-evidence caveat', async () => {
    const { h, file } = await processed();
    const u = await h.image.uiStructure(file.id, owner);
    expect(u.elements.length).toBeGreaterThan(0);
    expect(u.notes.some((n) => n.includes('not the original DOM'))).toBe(true);
  });

  it('reads chart values without inventing them', async () => {
    const { h, file } = await processed();
    const c = await h.image.chart(file.id, owner);
    expect(c.chartType).toBe('bar');
    expect(c.values).toEqual(['12', '18', '24', '31']);
  });

  it('extracts diagram nodes and drops forged edges', async () => {
    const { h, file } = await processed();
    const d = await h.image.diagram(file.id, owner);
    expect(d.nodes).toHaveLength(3);
    // The scripted 'forged edge' (fromIndex 99) must be dropped.
    expect(d.relationships).toHaveLength(2);
  });

  it('extracts named fields with uncertainty flags', async () => {
    const { h, file } = await processed();
    const e = await h.image.extract(file.id, ['title', 'projectCount'], owner);
    expect(e.fields).toHaveLength(2);
    expect(e.fields.some((f) => f.uncertain)).toBe(true);
  });

  it('compares two images', async () => {
    const h = harness();
    const a = await registerPng(h, 'app.png', appPng);
    const b = await h.files.registerFile({
      filename: 'blue.png',
      bytes: bluePng,
      declaredMimeType: 'image/png',
      source: 'user_upload',
      scope,
    });
    const r = await h.image.compare(a.id, b.id, owner);
    expect(r.differences.length).toBeGreaterThan(0);
    expect(r.fileAId).toBe(a.id);
    expect(r.fileBId).toBe(b.id);
  });

  it('searches stored OCR deterministically', async () => {
    const { h, file } = await processed();
    const r = await h.image.searchImage(file.id, 'dashboard', owner);
    expect(r.trust).toBe('untrusted_data');
    expect(r.matches.length).toBeGreaterThan(0);
    const project = await h.image.searchImages('Projects', owner, { projectId: 'p1' });
    expect(project.matches.length).toBeGreaterThan(0);
  });
});

describe('ImageIntelligenceManager - injection containment', () => {
  it('stores injection-laden OCR text as inert data', async () => {
    const h = harness();
    const file = await h.files.registerFile({
      filename: 'inject.png',
      bytes: injectPng,
      declaredMimeType: 'image/png',
      source: 'user_upload',
      scope,
    });
    await h.image.process(file.id, owner);
    const analysis = await h.image.analysis(file.id, owner);
    expect(analysis.ocr?.text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    // The injection stays text: it never appears in any audit event.
    const auditText = JSON.stringify(h.events);
    expect(auditText).not.toContain('IGNORE ALL');
    // And querying returns an honest refusal framing, not compliance.
    const q = await h.image.query(file.id, 'what does the text say', owner);
    expect(q.answer.toLowerCase()).toContain('untrusted data');
  });
});

describe('ImageIntelligenceManager - artifacts', () => {
  async function processed() {
    const h = harness();
    const file = await registerPng(h);
    await h.image.process(file.id, owner);
    return { h, file };
  }

  it('saves JSON analysis and OCR artifacts through the file system', async () => {
    const { h, file } = await processed();
    const json = await h.image.saveArtifact(file.id, owner, { kind: 'image_analysis_json' });
    expect(json.byteSize).toBeGreaterThan(0);
    expect(json.filename.endsWith('-analysis.json')).toBe(true);
    const txt = await h.image.saveArtifact(file.id, owner, { kind: 'ocr_txt' });
    expect(txt.mimeType).toBe('text/plain');
    expect(h.events.map((e) => e.type)).toContain('image_artifact_saved');
  });

  it('saves a markdown description that separates observed facts from inferences', async () => {
    const { h, file } = await processed();
    const md = await h.image.saveArtifact(file.id, owner, { kind: 'image_description_md' });
    expect(md.mimeType).toBe('text/markdown');
    const stored = await h.files.listFiles(owner, { projectId: 'p1' });
    expect(stored.length).toBeGreaterThan(0);
  });

  it('rejects artifact kinds whose analysis has not run', async () => {
    const h = harness();
    const file = await registerPng(h);
    await expect(
      h.image.saveArtifact(file.id, owner, { kind: 'image_description_md' }),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_PROCESSED' });
    await expect(
      h.image.saveArtifact(file.id, owner, { kind: 'screenshot_analysis_md' }),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_PROCESSED' });
    await expect(
      h.image.saveArtifact(file.id, owner, { kind: 'image_comparison_json' }),
    ).rejects.toMatchObject({ code: 'IMAGE_ARTIFACT_INVALID' });
  });

  it('saves screenshot and comparison artifacts after their operations ran', async () => {
    const { h, file } = await processed();
    await h.image.screenshot(file.id, owner);
    const shot = await h.image.saveArtifact(file.id, owner, { kind: 'screenshot_analysis_md' });
    expect(shot.filename.endsWith('-screenshot.md')).toBe(true);
    const b = await h.files.registerFile({
      filename: 'blue.png',
      bytes: bluePng,
      declaredMimeType: 'image/png',
      source: 'user_upload',
      scope,
    });
    await h.image.compare(file.id, b.id, owner);
    const cmp = await h.image.saveArtifact(file.id, owner, { kind: 'image_comparison_json' });
    expect(cmp.filename.endsWith('-comparison.json')).toBe(true);
  });
});

describe('ImageIntelligenceManager - capabilities view', () => {
  it('surfaces providers, limits, and the operation map honestly', () => {
    const h = harness();
    const caps = h.image.capabilities();
    expect(caps.providers).toHaveLength(1);
    expect(caps.providers[0]?.capabilities).toContain('image_understanding');
    expect(caps.operations).toHaveLength(9);
    expect(caps.limits.maxFileBytes).toBeGreaterThan(0);
  });
});
