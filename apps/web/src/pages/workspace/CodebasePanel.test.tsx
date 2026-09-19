// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { CodebasePanel } from './CodebasePanel';
import {
  buildIndex,
  extractMemoryCandidates,
  getIndex,
  searchCodebase,
  traceFeature,
  type CodebaseIndexView,
  type CodebaseSearchResultView,
  type CodebaseTraceView,
} from '../../api/codebase';
import { ApiError } from '../../api/client';

vi.mock('../../api/codebase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/codebase')>();
  return {
    ...actual,
    getIndex: vi.fn(),
    buildIndex: vi.fn(),
    searchCodebase: vi.fn(),
    traceFeature: vi.fn(),
    extractMemoryCandidates: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mockedGetIndex = vi.mocked(getIndex);
const mockedBuildIndex = vi.mocked(buildIndex);
const mockedSearch = vi.mocked(searchCodebase);
const mockedTrace = vi.mocked(traceFeature);
const mockedExtract = vi.mocked(extractMemoryCandidates);

function indexView(overrides: Partial<CodebaseIndexView> = {}): CodebaseIndexView {
  return {
    indexId: 'idx-1',
    workspaceId: 'ws-1',
    revision: 1,
    status: 'current',
    buildState: 'completed',
    languages: ['typescript', 'json'],
    frameworks: [{ id: 'react', name: 'React', confidence: 'high', evidence: ['react-dom'] }],
    fileCount: 5,
    symbolCount: 12,
    relationshipCount: 8,
    dependencyCount: 3,
    routeCount: 0,
    componentCount: 2,
    entryPointCount: 1,
    failedFileCount: 0,
    unsupportedFileCount: 0,
    flaggedSecretFileCount: 0,
    failure: null,
    files: [
      {
        path: 'src/main.tsx',
        language: 'typescript',
        size: 120,
        parseStatus: 'parsed',
        parseNote: null,
        flaggedSecrets: false,
      },
    ],
    ...overrides,
  };
}

function resultView(overrides: Partial<CodebaseSearchResultView> = {}): CodebaseSearchResultView {
  return {
    title: 'LoginForm',
    detail: 'component in src/components/LoginForm.tsx',
    evidence: [],
    filePath: 'src/components/LoginForm.tsx',
    range: { startLine: 1 },
    ...overrides,
  };
}

function traceView(overrides: Partial<CodebaseTraceView> = {}): CodebaseTraceView {
  return {
    feature: 'login form',
    nodes: [
      {
        label: 'LoginForm',
        kind: 'component',
        filePath: 'src/components/LoginForm.tsx',
        reason: 'Name matches the feature query',
      },
    ],
    edges: [],
    notes: [],
    truncated: false,
    ...overrides,
  };
}

function renderPanel(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <CodebasePanel projectId="prj-1" workspaceId="ws-1" />
    </ToastProvider>,
  );
}

describe('CodebasePanel - no index yet', () => {
  it('offers to analyze the workspace when no index exists', async () => {
    mockedGetIndex.mockRejectedValueOnce(
      new ApiError(404, 'CODEBASE_INDEX_NOT_FOUND', 'Analysis not found'),
    );
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Analyze workspace' });
    expect(button).toBeDefined();
  });

  it('builds an index on demand and shows the derived stats', async () => {
    mockedGetIndex.mockRejectedValueOnce(
      new ApiError(404, 'CODEBASE_INDEX_NOT_FOUND', 'Analysis not found'),
    );
    mockedBuildIndex.mockResolvedValueOnce({
      index: indexView(),
      incremental: false,
      changedFiles: 5,
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze workspace' }));
    const stats = await screen.findByText(/5 files · 12 symbols/);
    expect(stats).toBeDefined();
    expect(screen.getByText('Current')).toBeDefined();
    expect(screen.getByText(/Languages: typescript, json/)).toBeDefined();
    expect(screen.getByText(/Frameworks: React/)).toBeDefined();
  });
});

describe('CodebasePanel - existing index', () => {
  it('renders the current index and a refresh action', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    renderPanel();
    expect(await screen.findByText('Current')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Extract memory candidates' })).toBeDefined();
    expect(screen.getByText(/src\/main.tsx/)).toBeDefined();
  });

  it('shows a stale badge when the index is stale', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView({ status: 'stale' }));
    renderPanel();
    expect(await screen.findByText('Stale')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Refresh analysis' })).toBeDefined();
  });

  it('surfaces flagged-secret counts without ever showing values', async () => {
    mockedGetIndex.mockResolvedValueOnce(
      indexView({
        flaggedSecretFileCount: 1,
        files: [
          {
            path: 'config/env.ts',
            language: 'typescript',
            size: 80,
            parseStatus: 'parsed',
            parseNote: null,
            flaggedSecrets: true,
          },
        ],
      }),
    );
    renderPanel();
    expect(await screen.findByText(/1 file flagged for secret-shaped content/)).toBeDefined();
    expect(screen.getByText('secrets flagged')).toBeDefined();
  });

  it('renders an honest error state on load failure', async () => {
    mockedGetIndex.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Server error'));
    renderPanel();
    expect(await screen.findByText('Analysis unavailable')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });
});

describe('CodebasePanel - search and trace', () => {
  it('lists symbol results for a query', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedSearch.mockResolvedValueOnce([resultView()]);
    renderPanel();
    await screen.findByText('Current');
    const input = screen.getByLabelText('Find symbols');
    fireEvent.change(input, { target: { value: 'LoginForm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('component in src/components/LoginForm.tsx')).toBeDefined();
  });

  it('reports when a symbol search matches nothing', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedSearch.mockResolvedValueOnce([]);
    renderPanel();
    await screen.findByText('Current');
    fireEvent.change(screen.getByLabelText('Find symbols'), { target: { value: 'ghost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No symbols matched that search.')).toBeDefined();
  });

  it('shows an honest search failure', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedSearch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Search failed'));
    renderPanel();
    await screen.findByText('Current');
    fireEvent.change(screen.getByLabelText('Find symbols'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Search failed')).toBeDefined();
  });

  it('traces a feature into node evidence', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedTrace.mockResolvedValueOnce(traceView());
    renderPanel();
    await screen.findByText('Current');
    fireEvent.change(screen.getByLabelText('Trace a feature'), {
      target: { value: 'login form' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(await screen.findByText('Name matches the feature query')).toBeDefined();
  });
});

describe('CodebasePanel - memory candidates', () => {
  it('toasts the candidate count from extraction', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedExtract.mockResolvedValueOnce(2);
    renderPanel();
    await screen.findByText('Current');
    fireEvent.click(screen.getByRole('button', { name: 'Extract memory candidates' }));
    await waitFor(() => expect(mockedExtract).toHaveBeenCalledWith('prj-1', 'ws-1'));
    expect(await screen.findByText(/2 candidates sent to memory for review/)).toBeDefined();
  });

  it('toasts honestly when nothing durable was found', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedExtract.mockResolvedValueOnce(0);
    renderPanel();
    await screen.findByText('Current');
    fireEvent.click(screen.getByRole('button', { name: 'Extract memory candidates' }));
    expect(await screen.findByText('Nothing durable found worth remembering yet.')).toBeDefined();
  });

  it('toasts the error when extraction fails', async () => {
    mockedGetIndex.mockResolvedValueOnce(indexView());
    mockedExtract.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Extraction failed'));
    renderPanel();
    await screen.findByText('Current');
    fireEvent.click(screen.getByRole('button', { name: 'Extract memory candidates' }));
    expect(await screen.findByText('Extraction failed')).toBeDefined();
  });
});
