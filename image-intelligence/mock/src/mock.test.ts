import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createMockImageProvider, INJECTION_IMAGE_SCRIPT } from './index.js';
import type { AIImageAttachment } from '@veltravia/ai-core';

const read = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../core/src/fixtures/${name}`, import.meta.url))),
  );
const sha = (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const appPng = read('app.png');
const attach = (bytes: Uint8Array): AIImageAttachment => ({
  base64Data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
});

describe('mock image provider', () => {
  it('declares the full honest capability surface with no format or size limits', () => {
    const p = createMockImageProvider();
    const c = p.getCapabilities();
    expect(p.id).toBe('image.mock');
    expect(c.capabilities).toContain('image_understanding');
    expect(c.capabilities).toContain('ocr');
    expect(c.supportedFormats).toBeNull();
    expect(c.maxBytes).toBeNull();
  });

  it('returns deterministic JSON for every operation', async () => {
    const p = createMockImageProvider();
    for (const op of [
      'describe',
      'ocr',
      'query',
      'screenshot',
      'ui_structure',
      'chart',
      'diagram',
      'extract',
      'compare',
    ] as const) {
      const r = await p.analyze({ op, images: [attach(appPng)], isCancelled: () => false });
      expect(() => JSON.parse(r.text)).not.toThrow();
    }
  });

  it('is deterministic for the same bytes', async () => {
    const p = createMockImageProvider();
    const a = await p.analyze({
      op: 'describe',
      images: [attach(appPng)],
      isCancelled: () => false,
    });
    const b = await p.analyze({
      op: 'describe',
      images: [attach(appPng)],
      isCancelled: () => false,
    });
    expect(a.text).toBe(b.text);
  });

  it('serves scripted outputs keyed by checksum', async () => {
    const injectPng = read('inject.png');
    const p = createMockImageProvider({
      scripts: { [sha(injectPng)]: INJECTION_IMAGE_SCRIPT },
    });
    const r = await p.analyze({
      op: 'ocr',
      images: [attach(injectPng)],
      isCancelled: () => false,
    });
    expect(r.text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  });

  it('simulates the documented failure modes', async () => {
    const failing = createMockImageProvider({
      scripts: { [sha(appPng)]: { outputs: {}, failWith: 'provider_error' } },
    });
    await expect(
      failing.analyze({ op: 'describe', images: [attach(appPng)], isCancelled: () => false }),
    ).rejects.toMatchObject({ code: 'IMAGE_PROVIDER_ERROR' });

    const malformed = createMockImageProvider({
      scripts: { [sha(appPng)]: { outputs: {}, failWith: 'malformed' } },
    });
    const r = await malformed.analyze({
      op: 'describe',
      images: [attach(appPng)],
      isCancelled: () => false,
    });
    expect(r.text).not.toMatch(/^\{/);

    const cancelled = createMockImageProvider();
    await expect(
      cancelled.analyze({ op: 'describe', images: [attach(appPng)], isCancelled: () => true }),
    ).rejects.toMatchObject({ code: 'IMAGE_PROCESSING_CANCELLED' });
  });

  it('falls back to bounded defaults for unknown keys', async () => {
    const p = createMockImageProvider();
    const r = await p.analyze({ op: 'describe', images: [], isCancelled: () => false });
    expect(() => JSON.parse(r.text)).not.toThrow();
  });
});
