// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { VersionPanel } from './VersionPanel';
import {
  captureRevision,
  createCheckpoint,
  decideRollback,
  deleteCheckpoint,
  fetchRevisionDiff,
  listCheckpoints,
  listRevisions,
  openRollback,
  type CheckpointView,
  type DiffView,
  type OpenedRollback,
  type RevisionView,
} from '../../api/versions';
import { ApiError } from '../../api/client';
import type { WorkspaceView } from '../../api/workspaces';

vi.mock('../../api/versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/versions')>();
  return {
    ...actual,
    listRevisions: vi.fn(),
    listCheckpoints: vi.fn(),
    captureRevision: vi.fn(),
    createCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
    fetchRevisionDiff: vi.fn(),
    openRollback: vi.fn(),
    decideRollback: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mockedListRevisions = vi.mocked(listRevisions);
const mockedListCheckpoints = vi.mocked(listCheckpoints);
const mockedCapture = vi.mocked(captureRevision);
const mockedCreateCheckpoint = vi.mocked(createCheckpoint);
const mockedDeleteCheckpoint = vi.mocked(deleteCheckpoint);
const mockedDiff = vi.mocked(fetchRevisionDiff);
const mockedOpen = vi.mocked(openRollback);
const mockedDecide = vi.mocked(decideRollback);

function workspace(id = 'ws-1', revision = 3): WorkspaceView {
  return {
    id,
    name: 'Main',
    status: 'active',
    revision,
    createdAt: '2026-01-01T00:00:00Z',
    projectId: 'p1',
  };
}

function revision(overrides: Partial<RevisionView> = {}): RevisionView {
  return {
    id: 'rev-2',
    revisionNumber: 2,
    parentRevisionId: 'rev-1',
    createdAt: '2026-09-19T10:00:00Z',
    source: 'manual',
    change: { added: 1, modified: 2, deleted: 0, total: 3 },
    fileCount: 3,
    totalBytes: 120,
    message: 'before refactor',
    restoredFromRevisionId: null,
    checkpointRefs: [],
    ...overrides,
  };
}

function checkpoint(overrides: Partial<CheckpointView> = {}): CheckpointView {
  return {
    id: 'cp-1',
    name: 'Stable release',
    description: null,
    createdAt: '2026-09-19T11:00:00Z',
    revisionId: 'rev-2',
    revisionNumber: 2,
    ...overrides,
  };
}

function seed(
  revisions: readonly RevisionView[],
  checkpoints: readonly CheckpointView[] = [],
): void {
  mockedListRevisions.mockResolvedValue(revisions);
  mockedListCheckpoints.mockResolvedValue(checkpoints);
}

function renderPanel(
  workspaces: readonly WorkspaceView[] = [workspace()],
): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <VersionPanel projectId="p1" workspaces={workspaces} />
    </ToastProvider>,
  );
}

describe('VersionPanel', () => {
  it('renders the revision timeline with honest metadata', async () => {
    seed([revision()], [checkpoint()]);
    renderPanel();
    expect(await screen.findByText('#2')).toBeDefined();
    expect(screen.getByText('Captured by you')).toBeDefined();
    expect(screen.getByText('before refactor')).toBeDefined();
    expect(screen.getByText(/1 added/)).toBeDefined();
    // Metadata only: no file contents anywhere.
    expect(document.body.textContent ?? '').not.toContain('export function');
  });

  it('shows the empty state when no revisions exist', async () => {
    seed([], []);
    renderPanel();
    expect(await screen.findByText(/No revisions yet/)).toBeDefined();
  });

  it('captures a revision and reloads the timeline', async () => {
    seed([revision()]);
    mockedCapture.mockResolvedValue(revision({ id: 'rev-3', revisionNumber: 3 }));
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Capture revision' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(mockedCapture).toHaveBeenCalledWith('p1', 'ws-1', {});
    });
    await waitFor(() => {
      expect(mockedListRevisions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('opens a bounded diff dialog from a revision row', async () => {
    seed([revision()]);
    const diff: DiffView = {
      fromRevisionId: 'rev-1',
      toRevisionId: 'rev-2',
      fromLabel: null,
      toLabel: null,
      added: 1,
      modified: 1,
      deleted: 0,
      renamed: 0,
      unchanged: 0,
      files: [
        {
          path: 'src/app.ts',
          kind: 'modified',
          lines: [
            { kind: 'remove', text: 'const old = 1;' },
            { kind: 'add', text: 'const fresh = 2;' },
          ],
        },
      ],
    };
    mockedDiff.mockResolvedValue(diff);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Diff' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(mockedDiff).toHaveBeenCalledWith('p1', 'ws-1', 'rev-2');
    expect(screen.getByText('const fresh = 2;')).toBeDefined();
  });

  it('requests a rollback and restores only after explicit approval', async () => {
    seed([
      revision({ id: 'rev-2', revisionNumber: 2 }),
      revision({ id: 'rev-1', revisionNumber: 1 }),
    ]);
    const opened: OpenedRollback = {
      operation: {
        id: 'op-1',
        state: 'pending_confirmation',
        createdAt: '2026-09-19T12:00:00Z',
        result: null,
        failureCode: null,
        failureMessage: null,
        request: {
          workspaceId: 'ws-1',
          targetRevisionId: 'rev-1',
          expectedCurrentRevision: 3,
          reason: null,
        },
      },
      validation: {
        targetRevisionId: 'rev-1',
        targetRevisionNumber: 1,
        currentRevision: 3,
        filesChanged: 2,
      },
    };
    mockedOpen.mockResolvedValue(opened);
    mockedDecide.mockResolvedValue(
      opened.operation.state === 'pending_confirmation'
        ? {
            id: 'op-1',
            state: 'completed',
            createdAt: '',
            result: {
              newRevisionId: 'rev-3',
              newRevisionNumber: 3,
              restoredFromRevisionId: 'rev-1',
              restoredFromRevisionNumber: 1,
              filesChanged: 2,
            },
            failureCode: null,
            failureMessage: null,
            request: opened.operation.request,
          }
        : opened.operation,
    );
    renderPanel();

    // The LATEST revision's Restore button is disabled; the older one works.
    const restoreButtons = await screen.findAllByRole('button', { name: 'Restore…' });
    expect(restoreButtons).toHaveLength(2);
    expect(restoreButtons[0].hasAttribute('disabled')).toBe(true);
    expect(restoreButtons[1].hasAttribute('disabled')).toBe(false);
    fireEvent.click(restoreButtons[1]);
    await waitFor(() => {
      expect(mockedOpen).toHaveBeenCalledWith('p1', {
        workspaceId: 'ws-1',
        targetRevisionId: 'rev-1',
        expectedCurrentRevision: 3,
      });
    });
    expect(await screen.findByText('Restore this revision?')).toBeDefined();
    expect(mockedDecide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restore now' }));
    await waitFor(() => {
      expect(mockedDecide).toHaveBeenCalledWith('p1', 'op-1', 'approve');
    });
  });

  it('keeps the workspace untouched when the user backs out of a restore', async () => {
    seed([revision({ id: 'rev-2' }), revision({ id: 'rev-1', revisionNumber: 1 })]);
    mockedOpen.mockResolvedValue({
      operation: {
        id: 'op-2',
        state: 'pending_confirmation',
        createdAt: '',
        result: null,
        failureCode: null,
        failureMessage: null,
        request: {
          workspaceId: 'ws-1',
          targetRevisionId: 'rev-1',
          expectedCurrentRevision: 3,
          reason: null,
        },
      },
      validation: {
        targetRevisionId: 'rev-1',
        targetRevisionNumber: 1,
        currentRevision: 3,
        filesChanged: 1,
      },
    });
    renderPanel();
    const restoreButtons = await screen.findAllByRole('button', { name: 'Restore…' });
    fireEvent.click(restoreButtons[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep current files' }));
    await waitFor(() => {
      expect(screen.queryByText('Restore this revision?')).toBeNull();
    });
    expect(mockedDecide).not.toHaveBeenCalled();
  });

  it('pins and removes checkpoints from the checkpoints tab', async () => {
    seed([revision()], []);
    mockedCreateCheckpoint.mockResolvedValue(checkpoint());
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /Checkpoints/ }));
    const nameInput = screen.getByLabelText('Checkpoint name');
    fireEvent.change(nameInput, { target: { value: 'Stable release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin checkpoint' }));
    await waitFor(() => {
      expect(mockedCreateCheckpoint).toHaveBeenCalledWith('p1', 'ws-1', { name: 'Stable release' });
    });

    await waitFor(() => {
      expect(mockedCreateCheckpoint).toHaveBeenCalledWith('p1', 'ws-1', {
        name: 'Stable release',
      });
    });
  });

  it('removes a pinned checkpoint from the checkpoints tab', async () => {
    seed([revision()], [checkpoint()]);
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /Checkpoints/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(mockedDeleteCheckpoint).toHaveBeenCalledWith('p1', 'ws-1', 'cp-1');
    });
  });

  it('surfaces honest rollback failures from the server', async () => {
    seed([revision({ id: 'rev-2' }), revision({ id: 'rev-1', revisionNumber: 1 })]);
    mockedOpen.mockRejectedValue(
      new ApiError('Rollback could not be started.', {
        status: 409,
        code: 'VERSION_REVISION_CONFLICT',
      }),
    );
    renderPanel();
    const restoreButtons = await screen.findAllByRole('button', { name: 'Restore…' });
    fireEvent.click(restoreButtons[1]);
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(mockedDecide).not.toHaveBeenCalled();
  });
});
