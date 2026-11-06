// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import * as exportsApi from '../../api/exports';
import * as sourceApi from '../../api/source';
import { useExport } from './useExport';

vi.mock('../../api/exports', async () => {
  const actual = await vi.importActual<typeof import('../../api/exports')>('../../api/exports');
  return {
    ...actual,
    createExport: vi.fn(),
    listExports: vi.fn(),
    downloadExport: vi.fn(),
    validateExport: vi.fn(),
    discardExport: vi.fn(),
  };
});
vi.mock('../../api/source', async () => {
  const actual = await vi.importActual<typeof import('../../api/source')>('../../api/source');
  return { ...actual, fetchTree: vi.fn() };
});

const api = vi.mocked(exportsApi);
const source = vi.mocked(sourceApi);

const VIEW = {
  exportId: 'exp_1',
  projectId: 'prj-1',
  workspaceId: 'ws-1',
  scope: 'project',
  selection: [],
  status: 'ready',
  revision: 1,
  fileName: 'a.zip',
  archiveBytes: 10,
  archiveHash: 'h',
  included: [],
  excluded: [],
  totals: { files: 1, bytes: 1 },
  consistencyRetries: 0,
  failure: null,
  createdAt: '',
  expiresAt: null,
} as unknown as exportsApi.ExportView;

beforeEach(() => {
  api.listExports.mockResolvedValue([]);
  source.fetchTree.mockResolvedValue({
    projectId: 'prj-1',
    workspaceId: 'ws-1',
    rootRevision: 1,
    files: [],
    directories: [],
    totals: { files: 0, bytes: 0 },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useExport', () => {
  it('ignores a second start made in the same tick, before any re-render', async () => {
    api.createExport.mockResolvedValue(VIEW);
    const { result } = renderHook(() => useExport('prj-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      // Both calls happen before React can re-render and disable a button.
      void result.current.start({ scope: 'project' });
      void result.current.start({ scope: 'project' });
    });
    expect(api.createExport).toHaveBeenCalledTimes(1);
    expect(result.current.current?.exportId).toBe('exp_1');
  });

  it('allows a new export after the previous one finished', async () => {
    api.createExport.mockResolvedValue(VIEW);
    const { result } = renderHook(() => useExport('prj-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => result.current.start({ scope: 'project' }));
    await act(async () => result.current.start({ scope: 'project' }));
    expect(api.createExport).toHaveBeenCalledTimes(2);
  });

  it('clears the previous result and error when a new export starts', async () => {
    api.createExport.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useExport('prj-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => result.current.start({ scope: 'project' }));
    expect(result.current.error).not.toBe('');
    api.createExport.mockResolvedValueOnce(VIEW);
    await act(async () => result.current.start({ scope: 'project' }));
    expect(result.current.error).toBe('');
    expect(result.current.current).toBe(VIEW);
  });

  it('never downloads an export that is not ready', async () => {
    api.createExport.mockResolvedValue({ ...VIEW, status: 'failed' } as exportsApi.ExportView);
    const { result } = renderHook(() => useExport('prj-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => result.current.start({ scope: 'project' }));
    await act(async () => result.current.downloadCurrent());
    expect(api.downloadExport).not.toHaveBeenCalled();
    expect(result.current.download.kind).toBe('idle');
  });

  it('does nothing without a project', async () => {
    const { result } = renderHook(() => useExport(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe('No project was selected.');
    await act(async () => result.current.start({ scope: 'project' }));
    expect(api.createExport).not.toHaveBeenCalled();
  });
});
