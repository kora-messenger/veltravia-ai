// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { SourceExplorer } from './SourceExplorer';
import * as api from '../../api/source';
import { ApiError } from '../../api/client';

vi.mock('../../api/source', () => ({
  fetchTree: vi.fn(),
  fetchFile: vi.fn(),
  fetchHistory: vi.fn(),
}));

const tree: api.SourceTreeView = {
  projectId: 'prj_1',
  workspaceId: 'ws_1',
  rootRevision: 4,
  files: [
    {
      path: 'src/main.ts',
      type: 'file',
      revision: 2,
      size: 120,
      updatedAt: '2026-11-01T05:00:00.000Z',
      contentHash: 'abc',
    },
    {
      path: 'README.md',
      type: 'file',
      revision: 1,
      size: 40,
      updatedAt: '2026-11-01T04:00:00.000Z',
      contentHash: 'def',
    },
  ],
  directories: ['src'],
  totals: { files: 2, bytes: 160 },
};

const history: readonly api.FileHistoryEntry[] = [
  {
    id: 'h1',
    path: 'src/main.ts',
    changeKind: 'modified',
    revision: 2,
    size: 120,
    contentHash: 'abc',
    actor: 'source-api',
    summary: 'Updated src/main.ts',
    at: '2026-11-01T05:00:00.000Z',
  },
];

const file: api.SourceFileContent = {
  path: 'src/main.ts',
  revision: 2,
  size: 120,
  contentHash: 'abc',
  content: 'export const answer = 42;\n',
  truncated: false,
};

function renderExplorer() {
  return render(
    <ToastProvider>
      <SourceExplorer projectId="prj_1" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.fetchTree).mockResolvedValue(tree);
  vi.mocked(api.fetchHistory).mockResolvedValue(history);
  vi.mocked(api.fetchFile).mockResolvedValue(file);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('source explorer', () => {
  it('shows the file totals the server reported', async () => {
    renderExplorer();
    expect(await screen.findByText('2 files')).toBeDefined();
    expect(screen.getByText('revision 4')).toBeDefined();
  });

  it('marks a recently changed file', async () => {
    renderExplorer();
    fireEvent.click(await screen.findByRole('button', { name: /src\// }));
    await screen.findByRole('button', { name: /main\.ts/ });
    expect(screen.getAllByLabelText('recently changed').length).toBe(1);
  });

  it('loads a file when it is selected', async () => {
    renderExplorer();
    fireEvent.click(await screen.findByRole('button', { name: /src\// }));
    fireEvent.click(await screen.findByRole('button', { name: /main\.ts/ }));
    expect(await screen.findByLabelText('Contents of src/main.ts')).toBeDefined();
    expect(api.fetchFile).toHaveBeenCalledWith('prj_1', 'src/main.ts', undefined);
  });

  it('collapses a directory until it is expanded', async () => {
    renderExplorer();
    await screen.findByText('2 files');
    expect(screen.queryByRole('button', { name: /main\.ts/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /src\// }));
    expect(await screen.findByRole('button', { name: /main\.ts/ })).toBeDefined();
  });

  it('offers an honest empty state for a project with no files', async () => {
    vi.mocked(api.fetchTree).mockResolvedValue({
      ...tree,
      files: [],
      directories: [],
      totals: { files: 0, bytes: 0 },
    });
    renderExplorer();
    expect(await screen.findByText(/no files yet/i)).toBeDefined();
  });

  it('shows a retry when the tree cannot be loaded', async () => {
    vi.mocked(api.fetchTree).mockRejectedValue(new ApiError(500, 'SOURCE_FAILED', 'Server error.'));
    renderExplorer();
    expect(await screen.findByText('Server error.')).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('explains a truncated preview instead of pretending it is whole', async () => {
    vi.mocked(api.fetchFile).mockResolvedValue({ ...file, truncated: true });
    renderExplorer();
    fireEvent.click(await screen.findByRole('button', { name: /src\// }));
    fireEvent.click(await screen.findByRole('button', { name: /main\.ts/ }));
    expect(await screen.findByText(/cut at the read limit/i)).toBeDefined();
  });
});
