// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { VersionPanel } from './VersionPanel';
import {
  compareRevisions,
  decideRollback,
  listCheckpoints,
  listRevisions,
  openRollback,
  type OpenedRollback,
  type RevisionView,
} from '../../api/versions';
import {
  archiveBranch,
  createBranch,
  deleteBranch,
  fetchBranchHistory,
  getBranch,
  listBranches,
  renameBranch,
  switchBranch,
  type BranchView,
  type HistoryEntryView,
} from '../../api/branches';
import { ApiError } from '../../api/client';
import type { WorkspaceView } from '../../api/workspaces';

/**
 * Step 38 in the browser: branches, the annotated history, and restoring only
 * the files a person chooses. Everything here is offline: the API modules are
 * replaced, so these tests state what the screen does with the answers it gets.
 */

vi.mock('../../api/versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/versions')>();
  return {
    ...actual,
    listRevisions: vi.fn(),
    listCheckpoints: vi.fn(),
    compareRevisions: vi.fn(),
    openRollback: vi.fn(),
    decideRollback: vi.fn(),
  };
});
vi.mock('../../api/branches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/branches')>();
  return {
    ...actual,
    listBranches: vi.fn(),
    getBranch: vi.fn(),
    switchBranch: vi.fn(),
    createBranch: vi.fn(),
    renameBranch: vi.fn(),
    archiveBranch: vi.fn(),
    deleteBranch: vi.fn(),
    fetchBranchHistory: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const branchOf = (over: Partial<BranchView> = {}): BranchView => ({
  id: 'br-main',
  name: 'main',
  description: null,
  state: 'active',
  isDefault: true,
  isActive: true,
  workspaceId: 'ws-1',
  baseRevisionId: null,
  parentBranchId: null,
  createdAt: '2026-11-04T09:00:00Z',
  createdBy: 'user',
  archivedAt: null,
  ...over,
});

const revisionOf = (over: Partial<RevisionView> = {}): RevisionView => ({
  id: 'rev-2',
  revisionNumber: 2,
  parentRevisionId: 'rev-1',
  createdAt: '2026-11-04T10:00:00Z',
  source: 'manual',
  change: { added: 0, modified: 1, deleted: 0, total: 1 },
  fileCount: 3,
  totalBytes: 100,
  message: null,
  restoredFromRevisionId: null,
  checkpointRefs: [],
  ...over,
});

const workspaceOf = (over: Partial<WorkspaceView> = {}): WorkspaceView =>
  ({
    id: 'ws-1',
    projectId: 'p1',
    name: 'main',
    status: 'active',
    revision: 5,
    ...over,
  }) as WorkspaceView;

const entry = (over: Partial<HistoryEntryView> = {}): HistoryEntryView => ({
  revisionId: 'rev-2',
  revisionNumber: 2,
  branchId: 'br-main',
  branchName: 'main',
  description: 'x',
  createdAt: '2026-11-04T10:00:00Z',
  actor: 'user',
  author: 'api',
  changeType: 'edit',
  filesChanged: 1,
  added: 0,
  modified: 1,
  deleted: 0,
  checkpointIds: [],
  checkpointNames: [],
  source: 'manual',
  ...over,
});

function seed(opts: { branches?: BranchView[]; entries?: HistoryEntryView[] } = {}): void {
  const branches = opts.branches ?? [branchOf()];
  vi.mocked(listBranches).mockResolvedValue({
    branches,
    activeBranchId: branches.find((b) => b.isActive)?.id ?? null,
  });
  vi.mocked(listRevisions).mockResolvedValue([
    revisionOf(),
    revisionOf({ id: 'rev-1', revisionNumber: 1 }),
  ]);
  vi.mocked(listCheckpoints).mockResolvedValue([]);
  vi.mocked(fetchBranchHistory).mockResolvedValue({
    entries: opts.entries ?? [],
    total: 2,
    hasMore: false,
  });
  vi.mocked(switchBranch).mockResolvedValue(branches[0] ?? branchOf());
  vi.mocked(getBranch).mockResolvedValue({
    branch: branches[0] ?? branchOf(),
    deletable: true,
    deleteBlockedReason: null,
    latestRevisionNumber: 2,
  });
  vi.mocked(compareRevisions).mockResolvedValue({
    fromRevisionId: 'rev-2',
    toRevisionId: 'rev-1',
    fromLabel: null,
    toLabel: null,
    added: 1,
    modified: 1,
    deleted: 1,
    renamed: 0,
    unchanged: 2,
    files: [
      { path: 'src/app.ts', kind: 'modified', lines: [] },
      { path: 'src/gone.ts', kind: 'added', lines: [] },
      { path: 'src/extra.ts', kind: 'deleted', lines: [] },
    ],
  } as never);
}

const opened = (paths: string[] | null): OpenedRollback => ({
  operation: {
    id: 'op-1',
    state: 'pending_confirmation',
    createdAt: '',
    result: null,
    failureCode: null,
    failureMessage: null,
    request: {
      workspaceId: 'ws-1',
      targetRevisionId: 'rev-1',
      expectedCurrentRevision: 5,
      reason: null,
      paths,
    },
  },
  validation: {
    targetRevisionId: 'rev-1',
    targetRevisionNumber: 1,
    currentRevision: 5,
    filesChanged: paths?.length ?? 3,
  },
});

function renderPanel() {
  return render(
    <ToastProvider>
      <VersionPanel projectId="p1" workspaces={[workspaceOf()]} />
    </ToastProvider>,
  );
}

describe('the history timeline', () => {
  it('tells your changes, the AI agent’s and a restore apart', async () => {
    seed({
      entries: [
        entry({
          revisionId: 'rev-2',
          revisionNumber: 2,
          actor: 'ai-agent',
          source: 'coding_after',
        }),
        entry({ revisionId: 'rev-1', revisionNumber: 1, actor: 'user' }),
      ],
    });
    renderPanel();
    expect(await screen.findByText('AI agent')).toBeDefined();
    expect(screen.getByText('You')).toBeDefined();
  });

  it('shows the checkpoint that pins a revision', async () => {
    seed({
      entries: [entry({ checkpointNames: ['Before login rewrite'], checkpointIds: ['c1'] })],
    });
    renderPanel();
    expect(await screen.findByText('Before login rewrite')).toBeDefined();
  });

  it('still shows the timeline when the history call returns nothing', async () => {
    seed({ entries: [] });
    renderPanel();
    expect(await screen.findByText('#2')).toBeDefined();
    expect(screen.queryByText('AI agent')).toBeNull();
  });
});

describe('restoring only some files', () => {
  async function startRestore() {
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Restore…' });
    fireEvent.click(buttons[1]!);
    await screen.findByRole('list', { name: 'Files to restore' });
  }

  it('lists the changed files, all chosen, and says what will happen to each', async () => {
    seed();
    await startRestore();
    const list = screen.getByRole('list', { name: 'Files to restore' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    for (const box of within(list).getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(true);
    }
    // The comparison runs from now to the target, so these describe the restore.
    expect(within(list).getByText('will be reverted')).toBeDefined();
    expect(within(list).getByText('will come back')).toBeDefined();
    expect(within(list).getByText('will be removed')).toBeDefined();
    expect(screen.getByText('3 of 3 selected.')).toBeDefined();
  });

  it('restores the whole project when every file is still chosen', async () => {
    seed();
    vi.mocked(openRollback).mockResolvedValue(opened(null));
    await startRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(openRollback).toHaveBeenCalled());
    // No paths key at all: this is the plain whole-tree restore.
    expect(vi.mocked(openRollback).mock.calls[0]?.[1]).toEqual({
      workspaceId: 'ws-1',
      targetRevisionId: 'rev-1',
      expectedCurrentRevision: 5,
    });
  });

  it('sends only the ticked files when some are unticked', async () => {
    seed();
    vi.mocked(openRollback).mockResolvedValue(opened(['src/app.ts']));
    await startRestore();
    const list = screen.getByRole('list', { name: 'Files to restore' });
    const boxes = within(list).getAllByRole('checkbox');
    fireEvent.click(boxes[1]!);
    fireEvent.click(boxes[2]!);
    expect(screen.getByText('1 of 3 selected.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(openRollback).toHaveBeenCalled());
    expect(vi.mocked(openRollback).mock.calls[0]?.[1]).toEqual({
      workspaceId: 'ws-1',
      targetRevisionId: 'rev-1',
      expectedCurrentRevision: 5,
      paths: ['src/app.ts'],
    });
  });

  it('will not continue with nothing chosen', async () => {
    seed();
    await startRestore();
    const list = screen.getByRole('list', { name: 'Files to restore' });
    for (const box of within(list).getAllByRole('checkbox')) fireEvent.click(box);
    expect(screen.getByText('0 of 3 selected.')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(openRollback).not.toHaveBeenCalled();
  });

  it('names the chosen files on the confirmation and promises a recovery point', async () => {
    seed();
    vi.mocked(openRollback).mockResolvedValue(opened(['src/app.ts']));
    await startRestore();
    const list = screen.getByRole('list', { name: 'Files to restore' });
    const boxes = within(list).getAllByRole('checkbox');
    fireEvent.click(boxes[1]!);
    fireEvent.click(boxes[2]!);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const confirm = await screen.findByRole('list', { name: 'Files being restored' });
    expect(within(confirm).getByText('src/app.ts')).toBeDefined();
    expect(screen.getByText(/Every other file stays as it is/)).toBeDefined();
    expect(screen.getByText(/saved as a recovery point/)).toBeDefined();
    // Nothing has been decided yet.
    expect(decideRollback).not.toHaveBeenCalled();
  });

  it('says there is nothing to restore when the files already match', async () => {
    seed();
    vi.mocked(compareRevisions).mockResolvedValue({
      fromRevisionId: 'rev-2',
      toRevisionId: 'rev-1',
      fromLabel: null,
      toLabel: null,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      unchanged: 3,
      files: [],
    } as never);
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Restore…' });
    fireEvent.click(buttons[1]!);
    expect(await screen.findByText(/already match this revision/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows the server’s refusal if the comparison cannot be made', async () => {
    seed();
    vi.mocked(compareRevisions).mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', 'Revision is gone'),
    );
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Restore…' });
    fireEvent.click(buttons[1]!);
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(openRollback).not.toHaveBeenCalled();
  });
});

describe('managing branches', () => {
  it('lists branches and marks the default and archived ones', async () => {
    seed({
      branches: [
        branchOf(),
        branchOf({ id: 'br-x', name: 'experiment', isDefault: false, isActive: false }),
      ],
    });
    renderPanel();
    const select = (await screen.findByLabelText('Branch')) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(['main (default)', 'experiment']);
  });

  it('will not offer to archive or delete the default branch', async () => {
    seed();
    renderPanel();
    await screen.findByLabelText('Branch');
    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('creates a branch from the one in view and switches to it', async () => {
    seed();
    const created = branchOf({ id: 'br-new', name: 'login-work', isDefault: false });
    vi.mocked(createBranch).mockResolvedValue(created);
    renderPanel();
    await screen.findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'New branch' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'login-work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(createBranch).toHaveBeenCalled());
    expect(vi.mocked(createBranch).mock.calls[0]?.[1]).toMatchObject({
      name: 'login-work',
      fromBranchId: 'br-main',
    });
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith('p1', 'br-new'));
  });

  it('keeps the dialog open and shows the reason when a name is taken', async () => {
    seed();
    vi.mocked(createBranch).mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'A branch named "main" already exists in this project.'),
    );
    renderPanel();
    await screen.findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'New branch' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/already exists/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create branch' })).toBeDefined();
  });

  it('renames a branch', async () => {
    seed();
    vi.mocked(renameBranch).mockResolvedValue(branchOf({ name: 'trunk' }));
    renderPanel();
    await screen.findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'trunk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameBranch).toHaveBeenCalled());
    expect(vi.mocked(renameBranch).mock.calls[0]?.[2]).toMatchObject({ name: 'trunk' });
  });

  it('archives a non-default branch', async () => {
    seed({
      branches: [
        branchOf({ id: 'br-x', name: 'experiment', isDefault: false, isActive: true }),
        branchOf(),
      ],
    });
    vi.mocked(archiveBranch).mockResolvedValue(
      branchOf({ id: 'br-x', name: 'experiment', isDefault: false, state: 'archived' }),
    );
    renderPanel();
    await screen.findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archiveBranch).toHaveBeenCalledWith('p1', 'br-x'));
  });

  it('says plainly that deleting keeps the files, and deletes only after confirming', async () => {
    seed({
      branches: [
        branchOf({ id: 'br-x', name: 'experiment', isDefault: false, isActive: true }),
        branchOf(),
      ],
    });
    vi.mocked(deleteBranch).mockResolvedValue(undefined);
    renderPanel();
    await screen.findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/files and saved versions are kept/)).toBeDefined();
    expect(deleteBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete branch' }));
    await waitFor(() => expect(deleteBranch).toHaveBeenCalledWith('p1', 'br-x'));
  });

  it('explains why a branch cannot be deleted and disables the button', async () => {
    seed({
      branches: [
        branchOf({ id: 'br-x', name: 'experiment', isDefault: false, isActive: true }),
        branchOf(),
      ],
    });
    vi.mocked(getBranch).mockResolvedValue({
      branch: branchOf({ id: 'br-x', name: 'experiment', isDefault: false }),
      deletable: false,
      deleteBlockedReason: 'Other branches were created from this one (login-work).',
      latestRevisionNumber: 2,
    });
    renderPanel();
    await screen.findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Other branches were created from this one/)).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Delete branch' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows an error, not a blank panel, when branches cannot be loaded', async () => {
    seed();
    vi.mocked(listBranches).mockRejectedValue(new ApiError(0, 'NETWORK', 'Server unreachable'));
    renderPanel();
    expect(await screen.findByText(/Could not load branches/)).toBeDefined();
    expect(screen.getByText(/Server unreachable/)).toBeDefined();
  });
});

describe('refreshing', () => {
  /**
   * The branch bar reports the branch to its parent after each load. A parent
   * that passes a new function on every render used to make the bar reload
   * for ever, which in a browser was thousands of requests in seconds. The mocks
   * here never change identity, so only counting calls can show it.
   */
  it('loads once, not in a loop, when the parent re-renders', async () => {
    seed();
    renderPanel();
    await screen.findByLabelText('Branch', { exact: true });
    // Give any runaway reload time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(vi.mocked(listBranches).mock.calls.length).toBeLessThanOrEqual(2);
    expect(vi.mocked(listRevisions).mock.calls.length).toBeLessThanOrEqual(3);
    expect(vi.mocked(fetchBranchHistory).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('does not close an open restore chooser when the branch bar refreshes', async () => {
    seed();
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Restore…' });
    fireEvent.click(buttons[1]!);
    await screen.findByRole('list', { name: 'Files to restore' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole('list', { name: 'Files to restore' })).toBeDefined();
  });
});
