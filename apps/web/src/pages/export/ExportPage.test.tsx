// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import * as exportsApi from '../../api/exports';
import * as sourceApi from '../../api/source';
import { ApiError } from '../../api/client';
import { ExportPage } from './ExportPage';

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

const TREE: sourceApi.SourceTreeView = {
  projectId: 'prj-1',
  workspaceId: 'ws-1',
  rootRevision: 7,
  files: [
    { path: 'package.json', type: 'file', revision: 2, size: 20, updatedAt: '', contentHash: null },
    { path: 'src/index.ts', type: 'file', revision: 3, size: 20, updatedAt: '', contentHash: null },
    {
      path: 'src/ui/App.tsx',
      type: 'file',
      revision: 4,
      size: 20,
      updatedAt: '',
      contentHash: null,
    },
  ],
  directories: ['src', 'src/ui'],
  totals: { files: 3, bytes: 60 },
};

function readyView(overrides: Partial<exportsApi.ExportView> = {}): exportsApi.ExportView {
  return {
    exportId: 'exp_abc',
    projectId: 'prj-1',
    workspaceId: 'ws-1',
    scope: 'project',
    selection: [],
    status: 'ready',
    revision: 7,
    fileName: 'Notes.zip',
    archiveBytes: 2048,
    archiveHash: 'a'.repeat(64),
    included: [],
    excluded: [],
    totals: { files: 3, bytes: 60 },
    consistencyRetries: 0,
    failure: null,
    createdAt: '2026-11-05T10:00:00.000Z',
    expiresAt: '2026-11-05T10:15:00.000Z',
    ...overrides,
  };
}

const NOW = Date.parse('2026-11-05T10:00:00Z');
const renderPage = (save = vi.fn()) =>
  render(<ExportPage projectId="prj-1" save={save} now={() => NOW} />);

beforeEach(() => {
  api.listExports.mockResolvedValue([]);
  source.fetchTree.mockResolvedValue(TREE);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('loading and empty states', () => {
  it('shows a loading state, then the page', async () => {
    renderPage();
    expect(screen.getByText('Loading project…')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Export source code' })).toBeTruthy();
    expect(screen.getByText('3 files in this project')).toBeTruthy();
  });

  it('shows an error with a retry when the project cannot load, and retries', async () => {
    source.fetchTree.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Project not found.'));
    renderPage();
    expect(await screen.findByText('Could not open this project')).toBeTruthy();
    expect(screen.getByText('Project not found.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Export source code' })).toBeTruthy();
  });

  it('says so, and offers no export, when the project has no files', async () => {
    source.fetchTree.mockResolvedValue({
      ...TREE,
      files: [],
      directories: [],
      totals: { files: 0, bytes: 0 },
    });
    renderPage();
    expect(await screen.findByText('Nothing to export yet')).toBeTruthy();
    expect(screen.queryByTestId('export-start')).toBeNull();
  });

  it('has an error state when no project is selected', async () => {
    render(<ExportPage projectId={null} save={vi.fn()} />);
    expect(await screen.findByText('No project was selected.')).toBeTruthy();
  });
});

describe('exporting the whole project', () => {
  it('shows progress, then the result with a download button and facts', async () => {
    let finish: (v: exportsApi.ExportView) => void = () => undefined;
    api.createExport.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));

    expect(await screen.findByTestId('export-progress')).toBeTruthy();
    expect(api.createExport).toHaveBeenCalledWith('prj-1', { scope: 'project' });

    finish(readyView());
    const result = await screen.findByTestId('export-result');
    expect(within(result).getByTestId('export-status').textContent).toBe('Ready');
    expect(within(result).getByText('3 files')).toBeTruthy();
    expect(within(result).getByText('2.0 KB')).toBeTruthy();
    expect(within(result).getByText('a'.repeat(64))).toBeTruthy();
    expect(within(result).getByText(/about 15 more minutes/)).toBeTruthy();
    expect(screen.queryByTestId('export-progress')).toBeNull();
  });

  it('does not start a second export while one is running', async () => {
    api.createExport.mockReturnValue(new Promise(() => undefined));
    renderPage();
    const start = await screen.findByTestId('export-start');
    fireEvent.click(start);
    fireEvent.click(start);
    fireEvent.click(start);
    expect(api.createExport).toHaveBeenCalledTimes(1);
  });

  it('shows the server error and lets the user try again', async () => {
    api.createExport.mockRejectedValueOnce(
      new ApiError(
        429,
        'EXPORT_RATE_LIMITED',
        'Too many export requests. Try again in 30 seconds.',
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    expect((await screen.findByTestId('export-error')).textContent).toMatch(/Too many export/);
    api.createExport.mockResolvedValueOnce(readyView());
    fireEvent.click(screen.getByTestId('export-start'));
    expect(await screen.findByTestId('export-result')).toBeTruthy();
    expect(screen.queryByTestId('export-error')).toBeNull();
  });
});

describe('failed exports', () => {
  it('explains a revision conflict and says nothing was saved', async () => {
    api.createExport.mockResolvedValue(
      readyView({
        status: 'failed',
        failure: {
          code: 'EXPORT_REVISION_CONFLICT',
          message: 'The project kept changing while it was being exported.',
        },
        fileName: null,
        archiveBytes: null,
        archiveHash: null,
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    const failure = await screen.findByTestId('export-failure');
    expect(failure.textContent).toMatch(/nothing was saved/);
    expect(screen.queryByTestId('export-download')).toBeNull();
    expect(screen.getByTestId('export-status').textContent).toBe('Failed');
  });

  it('still lists what was left out when everything was excluded', async () => {
    api.createExport.mockResolvedValue(
      readyView({
        status: 'failed',
        failure: { code: 'EXPORT_NOTHING_TO_EXPORT', message: 'Every file was excluded.' },
        excluded: [
          {
            path: '.env',
            reason: 'credential-file',
            detail: 'The file name marks it as holding credentials.',
          },
        ],
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    const excluded = await screen.findByTestId('export-excluded');
    expect(within(excluded).getByText('.env')).toBeTruthy();
    expect(within(excluded).getByText('Credential file')).toBeTruthy();
  });

  it('shows an expired export as expired, with no download', async () => {
    api.createExport.mockResolvedValue(
      readyView({ status: 'expired', archiveHash: null, fileName: null }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    expect(await screen.findByTestId('export-expired')).toBeTruthy();
    expect(screen.queryByTestId('export-download')).toBeNull();
  });
});

describe('excluded files', () => {
  it('lists each excluded file with its reason, never a value', async () => {
    api.createExport.mockResolvedValue(
      readyView({
        excluded: [
          {
            path: '.env',
            reason: 'credential-file',
            detail: 'The file name marks it as holding credentials.',
          },
          {
            path: 'src/leak.ts',
            reason: 'secret-in-content',
            detail:
              'The content looks like it contains a credential (GitHub token). It was not read further or included.',
          },
        ],
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    const panel = await screen.findByTestId('export-excluded');
    expect(within(panel).getByText('Left out of the archive (2)')).toBeTruthy();
    expect(within(panel).getByText('Looks like a secret')).toBeTruthy();
    expect(within(panel).getByText(/GitHub token/)).toBeTruthy();
    expect(panel.textContent).toMatch(/not a guarantee/);
  });

  it('shows no excluded panel when nothing was excluded', async () => {
    api.createExport.mockResolvedValue(readyView());
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    await screen.findByTestId('export-result');
    expect(screen.queryByTestId('export-excluded')).toBeNull();
  });
});

describe('choosing files and folders', () => {
  it('needs a selection before it can export one', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Choose files and folders'));
    const start = screen.getByTestId('export-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByTestId('export-selected-count').textContent).toBe('Nothing selected yet.');
  });

  it('sends exactly the chosen paths, with a folder covering its children', async () => {
    api.createExport.mockResolvedValue(
      readyView({ scope: 'selection', selection: ['src', 'package.json'] }),
    );
    renderPage();
    fireEvent.click(await screen.findByLabelText('Choose files and folders'));

    fireEvent.click(screen.getByLabelText('File src/index.ts'));
    fireEvent.click(screen.getByLabelText('Folder src'));
    fireEvent.click(screen.getByLabelText('File package.json'));
    expect(screen.getByTestId('export-selected-count').textContent).toBe('2 items selected.');

    // The child is covered by its folder and cannot be toggled separately.
    expect((screen.getByLabelText('File src/ui/App.tsx') as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('export-start'));
    await waitFor(() => expect(api.createExport).toHaveBeenCalled());
    const [, request] = api.createExport.mock.calls[0]!;
    expect(request.scope).toBe('selection');
    expect([...(request.paths ?? [])].sort()).toEqual(['package.json', 'src']);
  });
});

describe('downloading', () => {
  it('downloads, saves, and reports a verified file', async () => {
    const view = readyView();
    api.createExport.mockResolvedValue(view);
    const archive = { blob: new Blob(['zip']), fileName: 'Notes.zip', verified: true };
    api.downloadExport.mockResolvedValue(archive);
    const save = vi.fn();
    renderPage(save);
    fireEvent.click(await screen.findByTestId('export-start'));
    fireEvent.click(await screen.findByTestId('export-download'));
    expect((await screen.findByTestId('export-download-done')).textContent).toMatch(
      /matched its recorded checksum/,
    );
    expect(save).toHaveBeenCalledWith(archive);
    expect(api.downloadExport).toHaveBeenCalledWith(view);
  });

  it('says plainly when the browser could not verify the checksum', async () => {
    api.createExport.mockResolvedValue(readyView());
    api.downloadExport.mockResolvedValue({
      blob: new Blob(['z']),
      fileName: 'x.zip',
      verified: false,
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    fireEvent.click(await screen.findByTestId('export-download'));
    expect((await screen.findByTestId('export-download-done')).textContent).toMatch(
      /could not verify/,
    );
  });

  it('does not save a file when the download fails or is corrupt', async () => {
    api.createExport.mockResolvedValue(readyView());
    api.downloadExport.mockRejectedValue(
      new ApiError(
        502,
        'EXPORT_CORRUPT',
        'The downloaded file does not match the export. It was not saved; try again.',
      ),
    );
    const save = vi.fn();
    renderPage(save);
    fireEvent.click(await screen.findByTestId('export-start'));
    fireEvent.click(await screen.findByTestId('export-download'));
    expect((await screen.findByTestId('export-download-failed')).textContent).toMatch(/not saved/);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('checking, deleting and history', () => {
  it('reports a valid archive check', async () => {
    api.createExport.mockResolvedValue(readyView());
    api.validateExport.mockResolvedValue({
      exportId: 'exp_abc',
      valid: true,
      entries: 3,
      problems: [],
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    fireEvent.click(await screen.findByTestId('export-validate'));
    expect((await screen.findByTestId('export-validation')).textContent).toMatch(
      /3 files, all matching/,
    );
  });

  it('reports archive problems as an alert', async () => {
    api.createExport.mockResolvedValue(readyView());
    api.validateExport.mockResolvedValue({
      exportId: 'exp_abc',
      valid: false,
      entries: 2,
      problems: ['A recorded file is missing: Notes/src/index.ts'],
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    fireEvent.click(await screen.findByTestId('export-validate'));
    const note = await screen.findByTestId('export-validation');
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.textContent).toMatch(/A recorded file is missing/);
  });

  it('deletes an export and returns to the placeholder', async () => {
    api.createExport.mockResolvedValue(readyView());
    api.discardExport.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByTestId('export-start'));
    fireEvent.click(await screen.findByTestId('export-discard'));
    expect(await screen.findByTestId('export-placeholder')).toBeTruthy();
    expect(api.discardExport).toHaveBeenCalledWith('exp_abc');
  });

  it('lists recent exports and reopens one', async () => {
    api.listExports.mockResolvedValue([readyView({ scope: 'selection', selection: ['src'] })]);
    renderPage();
    const open = await screen.findByRole('button', { name: /Open export: Selection: src, Ready/ });
    fireEvent.click(open);
    expect(await screen.findByTestId('export-result')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Selection: src' })).toBeTruthy();
  });
});
