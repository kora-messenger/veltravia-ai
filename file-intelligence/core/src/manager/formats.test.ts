import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileIntelligenceManager } from './index.js';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
const bytes = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
const scope = { ownerRef: 'format-owner', projectId: null, workspaceId: null };
const principal = { ownerRef: 'format-owner' };
const make = () => new FileIntelligenceManager({ store: new InMemoryFileAssetStore() });
describe('real-file format fixtures', () => {
  it('extracts DOCX paragraphs', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'report.docx',
      bytes: bytes('report.docx'),
      source: 'user_upload',
      scope,
    });
    const r = await m.extract(f.id, principal);
    expect(r.representation).toMatchObject({
      kind: 'document',
      text: expect.stringContaining('Revenue is 42'),
    });
  });
  it('extracts PDF text and page count', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'report.pdf',
      bytes: bytes('report.pdf'),
      source: 'user_upload',
      scope,
    });
    const r = await m.extract(f.id, principal);
    expect(r.representation).toMatchObject({
      kind: 'document',
      pages: 1,
      text: expect.stringContaining('revenue 42'),
    });
  });
  it('extracts XLSX sheet, dimensions, headers and cells', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'metrics.xlsx',
      bytes: bytes('metrics.xlsx'),
      source: 'user_upload',
      scope,
    });
    const r = await m.extract(f.id, principal);
    expect(r.representation).toMatchObject({
      kind: 'workbook',
      sheets: [
        {
          name: 'Metrics',
          rows: 2,
          columns: 2,
          headers: ['Name', 'Value'],
          cells: [
            ['Name', 'Value'],
            ['Revenue', '42'],
          ],
        },
      ],
    });
  });
  it('validates PNG dimensions and image-only byte route', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'photo.png',
      bytes: bytes('photo.png'),
      source: 'user_upload',
      scope,
    });
    expect(f.metadata).toMatchObject({ detectedType: 'png', width: 4, height: 5 });
    const preview = await m.preview(f.id, principal);
    expect(preview.kind).toBe('image');
    expect((await m.imageBytes(f.id, principal)).mimeType).toBe('image/png');
  });
  it('registers WAV duration, without transcription', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'tone.wav',
      bytes: bytes('tone.wav'),
      source: 'user_upload',
      scope,
    });
    expect(f.metadata.detectedType).toBe('audio');
    expect(f.metadata.durationSeconds).toBeCloseTo(0.1);
    expect((await m.preview(f.id, principal)).text).toBeNull();
  });
  it('registers MP4 without video understanding', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'clip.mp4',
      bytes: bytes('clip.mp4'),
      source: 'user_upload',
      scope,
    });
    expect(f.metadata.detectedType).toBe('video');
    expect((await m.preview(f.id, principal)).kind).toBe('metadata');
  });
  it('inspects ZIP without extracting children until requested', async () => {
    const m = make();
    const f = await m.registerFile({
      filename: 'sample.zip',
      bytes: bytes('sample.zip'),
      source: 'user_upload',
      scope,
    });
    expect((await m.preview(f.id, principal)).entries.map((e) => e.path)).toEqual([
      'README.md',
      'src/main.ts',
    ]);
    expect(await m.getChildren(f.id, principal)).toHaveLength(0);
    await m.extract(f.id, principal);
    expect(await m.getChildren(f.id, principal)).toHaveLength(2);
  });
  it('rejects ZIP bytes renamed as DOCX or XLSX', async () => {
    for (const name of ['pretend.docx', 'pretend.xlsx']) {
      const m = make();
      await expect(
        m.registerFile({
          filename: name,
          bytes: bytes('sample.zip'),
          source: 'user_upload',
          scope,
        }),
      ).rejects.toMatchObject({ code: 'FILE_TYPE_REJECTED' });
    }
  });
  it('rejects binary bytes masquerading as text', async () => {
    const m = make();
    await expect(
      m.registerFile({
        filename: 'spoofed.txt',
        bytes: Uint8Array.from([0, 1, 2, 3]),
        source: 'user_upload',
        scope,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TYPE_REJECTED' });
  });
});
