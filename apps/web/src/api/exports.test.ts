// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import { downloadExport, parseExportView, saveArchive } from './exports';

const VALID = {
  exportId: 'exp_1',
  projectId: 'prj-1',
  workspaceId: 'ws-1',
  scope: 'project',
  selection: [],
  status: 'ready',
  revision: 3,
  fileName: 'App.zip',
  archiveBytes: 10,
  archiveHash: '',
  included: [],
  excluded: [],
  totals: { files: 1, bytes: 5 },
  consistencyRetries: 0,
  failure: null,
  createdAt: '2026-11-05T10:00:00Z',
  expiresAt: null,
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

afterEach(() => vi.restoreAllMocks());

describe('parseExportView', () => {
  it('accepts a well-formed export', () => {
    expect(parseExportView(VALID).exportId).toBe('exp_1');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing id', { ...VALID, exportId: undefined }],
    ['an unknown status', { ...VALID, status: 'done' }],
    ['non-array excluded', { ...VALID, excluded: 'none' }],
    ['non-array included', { ...VALID, included: {} }],
    ['missing totals', { ...VALID, totals: undefined }],
    ['non-numeric totals', { ...VALID, totals: { files: '1', bytes: 5 } }],
    ['an unknown exclusion reason', { ...VALID, excluded: [{ path: 'a', reason: 'because' }] }],
    ['an exclusion with no path', { ...VALID, excluded: [{ reason: 'too-large' }] }],
  ])('refuses %s', (_name, payload) => {
    expect(() => parseExportView(payload)).toThrowError(/cannot read/);
  });
});

describe('downloadExport', () => {
  const bytes = new TextEncoder().encode('PK-pretend-zip');

  it('returns a verified blob when the checksum matches', async () => {
    const hash = await sha256(bytes);
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    const archive = await downloadExport(
      { exportId: 'exp_1', fileName: 'App.zip', archiveHash: hash },
      fetchImpl as unknown as typeof fetch,
    );
    expect(archive.verified).toBe(true);
    expect(archive.fileName).toBe('App.zip');
    expect(archive.blob.type).toBe('application/zip');
    expect(archive.blob.size).toBe(bytes.byteLength);
    expect(fetchImpl).toHaveBeenCalledWith('/api/exports/exp_1/download');
  });

  it('refuses a download whose checksum does not match, and returns nothing to save', async () => {
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    await expect(
      downloadExport(
        { exportId: 'exp_1', fileName: 'App.zip', archiveHash: 'f'.repeat(64) },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'EXPORT_CORRUPT' });
  });

  it('falls back to the checksum header when the view has none', async () => {
    const hash = await sha256(bytes);
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, { status: 200, headers: { 'x-veltravia-archive-sha256': hash } }),
    );
    const archive = await downloadExport(
      { exportId: 'exp_1', fileName: null, archiveHash: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(archive.verified).toBe(true);
    expect(archive.fileName).toBe('project.zip');
  });

  it('reports the server’s reason when the download is refused', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'EXPORT_NOT_FOUND', message: 'That export was not found.' },
          }),
          {
            status: 404,
          },
        ),
    );
    const failure = await downloadExport(
      { exportId: 'exp_1', fileName: 'a.zip', archiveHash: 'x' },
      fetchImpl as unknown as typeof fetch,
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).message).toBe('That export was not found.');
  });

  it('uses a generic message when an error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 500 }));
    await expect(
      downloadExport(
        { exportId: 'exp_1', fileName: 'a.zip', archiveHash: 'x' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ message: 'The download failed.' });
  });

  it('turns a network failure into a clear error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      downloadExport(
        { exportId: 'exp_1', fileName: 'a.zip', archiveHash: 'x' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('never calls the network when the device is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchImpl = vi.fn();
    await expect(
      downloadExport(
        { exportId: 'exp_1', fileName: 'a.zip', archiveHash: 'x' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('encodes the export id into the URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    await downloadExport(
      { exportId: 'a/b?c', fileName: 'a.zip', archiveHash: await sha256(bytes) },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledWith('/api/exports/a%2Fb%3Fc/download');
  });
});

describe('saveArchive', () => {
  it('clicks a temporary download link and cleans it up', () => {
    const create = vi.fn(() => 'blob:fake');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    vi.useFakeTimers();
    saveArchive({ blob: new Blob(['x']), fileName: 'App.zip', verified: true });
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:fake');
    vi.useRealTimers();
  });
});
