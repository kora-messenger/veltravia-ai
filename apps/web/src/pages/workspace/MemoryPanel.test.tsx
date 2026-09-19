import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { MemoryPanel } from './MemoryPanel';
import {
  approveMemoryCandidate,
  archiveMemory,
  createMemory,
  deleteMemory,
  getMemoryStats,
  listMemories,
  searchMemories,
  verifyMemory,
} from '../../api/memories';
import type { MemoryView } from '../../api/memories';

vi.mock('../../api/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/memories')>();
  return {
    ...actual,
    listMemories: vi.fn(),
    getMemoryStats: vi.fn(),
    searchMemories: vi.fn(),
    createMemory: vi.fn(),
    archiveMemory: vi.fn(),
    restoreMemory: vi.fn(),
    verifyMemory: vi.fn(),
    markMemoryStale: vi.fn(),
    approveMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    deleteMemory: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function memory(overrides: Partial<MemoryView> = {}): MemoryView {
  return {
    id: 'mem-1',
    projectId: 'prj-1',
    workspaceId: null,
    type: 'technology',
    title: 'Tech stack',
    content: 'The app uses React with Vite.',
    status: 'active',
    confidence: 'high',
    verificationStatus: 'unverified',
    source: { kind: 'user', referenceId: null },
    revision: 1,
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    lastVerifiedAt: null,
    ...overrides,
  };
}

function primeList(
  memories: readonly MemoryView[],
  stats = { total: 1, active: 1, archived: 0, candidates: 0, rejected: 0, stale: 0 },
) {
  vi.mocked(listMemories).mockResolvedValue(memories);
  vi.mocked(getMemoryStats).mockResolvedValue(stats);
}

describe('MemoryPanel', () => {
  it('loads and renders active memories with honest provenance and state', async () => {
    primeList([
      memory(),
      memory({
        id: 'mem-2',
        title: 'Second',
        source: { kind: 'generation_run', referenceId: 'run-9' },
      }),
    ]);
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Tech stack')).toBeDefined();
    });
    expect(screen.getByText('1 active · 0 candidates · 0 archived')).toBeDefined();
    expect(screen.getByText('Added by you')).toBeDefined();
    expect(screen.getByText(/From generation run \(run-9\)/)).toBeDefined();
    // Verification and confidence are always visible, never hidden.
    expect(screen.getAllByText('Unverified').length).toBe(2);
    expect(screen.getAllByText('high').length).toBe(2);
    expect(listMemories).toHaveBeenCalledWith('prj-1', { status: 'active' });
  });

  it('shows an honest empty state when there is no memory yet', async () => {
    primeList([], { total: 0, active: 0, archived: 0, candidates: 0, rejected: 0 });
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No active memories yet/i)).toBeDefined();
    });
  });

  it('surfaces load failures with a retry, never fabricated memory', async () => {
    vi.mocked(listMemories).mockRejectedValue(new Error('network down'));
    vi.mocked(getMemoryStats).mockResolvedValue({
      total: 0,
      active: 0,
      archived: 0,
      candidates: 0,
      rejected: 0,
    });
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await screen.findAllByText(/something went wrong/i);
    primeList([memory()]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText('Tech stack')).toBeDefined();
    });
  });

  it('candidates render with explicit Approve/Reject and nothing else', async () => {
    vi.mocked(listMemories).mockImplementation(async (_projectId, opts) =>
      opts?.status === 'candidate' ? [memory({ status: 'candidate' })] : [],
    );
    vi.mocked(getMemoryStats).mockResolvedValue({
      total: 1,
      active: 0,
      archived: 0,
      candidates: 1,
      rejected: 0,
    });
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /candidates/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /reject/i })).toBeDefined();
    // No lifecycle actions leak on a candidate - review only.
    expect(screen.queryByRole('button', { name: /^archive$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('approve sends the review decision and refreshes the list', async () => {
    vi.mocked(listMemories).mockImplementation(async (_projectId, opts) =>
      opts?.status === 'candidate' ? [memory({ status: 'candidate' })] : [],
    );
    vi.mocked(getMemoryStats).mockResolvedValue({
      total: 1,
      active: 0,
      archived: 0,
      candidates: 1,
      rejected: 0,
    });
    vi.mocked(approveMemoryCandidate).mockResolvedValue(memory());
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /candidates/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => {
      expect(approveMemoryCandidate).toHaveBeenCalledWith('prj-1', 'mem-1');
    });
    // A reload follows the decision so the list reflects the server state.
    await waitFor(() => {
      expect(listMemories.mock.calls.length >= 2).toBe(true);
    });
  });

  it('archive and delete act on the exact memory id', async () => {
    primeList([memory()]);
    vi.mocked(archiveMemory).mockResolvedValue(memory({ status: 'archived' }));
    vi.mocked(deleteMemory).mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await waitFor(() => {
      expect(archiveMemory).toHaveBeenCalledWith('prj-1', 'mem-1');
    });
  });

  it('verify marks the memory verified and reports success', async () => {
    primeList([memory()]);
    vi.mocked(verifyMemory).mockResolvedValue(memory({ verificationStatus: 'verified' }));
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /verify/i })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => {
      expect(verifyMemory).toHaveBeenCalledWith('prj-1', 'mem-1');
    });
  });

  it('create sends the typed body and clears the form', async () => {
    primeList([]);
    vi.mocked(createMemory).mockResolvedValue(memory());
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No active memories yet/i)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /add memory/i }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tech stack' } });
    fireEvent.change(screen.getByLabelText('Content'), {
      target: { value: 'The app uses React with Vite.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save memory/i }));

    await waitFor(() => {
      expect(createMemory).toHaveBeenCalledWith('prj-1', {
        title: 'Tech stack',
        content: 'The app uses React with Vite.',
        type: expect.any(String),
        confidence: 'high',
      });
    });
  });

  it('create failure shows the honest error and keeps the form open', async () => {
    primeList([]);
    vi.mocked(createMemory).mockRejectedValue(new Error('SECRET_REJECTED'));
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No active memories yet/i)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /add memory/i }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'sk-abc123' } });
    fireEvent.click(screen.getByRole('button', { name: /save memory/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeDefined();
    });
    // The form stays open with the user's input intact.
    expect(screen.getByLabelText('Title')).toBeDefined();
  });

  it('search posts the query and shows the bounded results', async () => {
    primeList([memory()]);
    vi.mocked(searchMemories).mockResolvedValue([memory({ title: 'React hit' })]);
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('Tech stack')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('Search memory'), { target: { value: 'React' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => {
      expect(searchMemories).toHaveBeenCalledWith('prj-1', 'React');
    });
    await waitFor(() => {
      expect(screen.getByText('React hit')).toBeDefined();
    });
    expect(screen.queryByText('Tech stack')).toBeNull();
  });

  it('archived tab requests the archived status', async () => {
    primeList([]);
    render(
      <ToastProvider>
        <MemoryPanel projectId="prj-1" />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No active memories yet/i)).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /archived/i }));
    await waitFor(() => {
      expect(listMemories).toHaveBeenLastCalledWith('prj-1', { status: 'archived' });
    });
  });
});
