// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type * as syncApi from '../../api/sync';
import { SyncPage } from './SyncPage';

/**
 * The page is exercised through a fake API, never a live GitHub.
 *
 * The assertions that matter are the honest ones: Apply cannot be pressed while
 * a decision is outstanding, a publish is never claimed before the server says
 * so, and a repository is never invented.
 */

const MASTER = 'a'.repeat(40);

function plan(overrides: Partial<syncApi.SyncPlan> = {}): syncApi.SyncPlan {
  return {
    planId: 'plan-1',
    projectId: 'prj-1',
    owner: 'acme',
    repository: 'notes',
    branch: 'main',
    status: 'ready',
    mode: 'update',
    remoteHead: MASTER,
    localRevision: 2,
    push: [{ kind: 'modify', path: 'src/a.ts', from: null, hash: 'h', size: 10 }],
    pull: [],
    conflicts: [],
    skipped: [],
    unchanged: 4,
    approvalReasons: [],
    approved: false,
    message: '',
    createdAt: '2026-11-06T10:00:00.000Z',
    expiresAt: '2026-11-06T11:00:00.000Z',
    failure: null,
    ...overrides,
  };
}

const status = (overrides: Partial<syncApi.SyncStatusView> = {}): syncApi.SyncStatusView => ({
  connected: false,
  connection: null,
  plans: [],
  hasUnresolvedConflicts: false,
  persistence: 'memory',
  ...overrides,
});

const CONNECTED = status({
  connected: true,
  connection: {
    owner: 'acme',
    repository: 'notes',
    branch: 'main',
    lastSyncedCommit: MASTER,
    lastSyncedAt: '2026-11-06T09:00:00.000Z',
  },
});

function fakeApi(overrides: Partial<typeof syncApi> = {}): typeof syncApi {
  const empty: syncApi.SyncHistoryView = { entries: [], persistence: 'memory' };
  return {
    fetchSyncStatus: vi.fn(async () => status()),
    fetchHistory: vi.fn(async () => empty),
    fetchRepositories: vi.fn(async () => []),
    connectRepository: vi.fn(async () => CONNECTED.connection!),
    disconnectRepository: vi.fn(async () => undefined),
    createPlan: vi.fn(async () => plan()),
    fetchPlan: vi.fn(async () => plan()),
    approvePlan: vi.fn(async () => plan({ approved: true })),
    resolveConflict: vi.fn(async () => plan()),
    applyPlan: vi.fn(async () => ({ plan: plan({ status: 'ready' }), commitSha: MASTER })),
    cancelPlan: vi.fn(async () => plan()),
    fetchConflictDetail: vi.fn(),
    isOffline: (() => false) as unknown as typeof syncApi.isOffline,
    ...overrides,
  } as unknown as typeof syncApi;
}

const offline = (() => false) as unknown as typeof syncApi.isOffline;

afterEach(() => {
  cleanup();
});

describe('SyncPage', () => {
  it('offers the connect form, and says a repository cannot be created here', async () => {
    const api = fakeApi();
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);
    expect(await screen.findByText('Connect a repository')).toBeTruthy();
    expect(screen.getByText(/cannot be created from here/i)).toBeTruthy();
    expect(screen.queryByText('Compare with GitHub')).not.toBeTruthy();
  });

  it('connects the chosen repository and branch', async () => {
    const api = fakeApi({
      fetchRepositories: vi.fn(async () => [
        { owner: 'acme', name: 'notes', defaultBranch: 'trunk', visibility: 'private' as const },
      ]),
      fetchSyncStatus: vi.fn().mockResolvedValueOnce(status()).mockResolvedValue(CONNECTED),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);

    const select = await screen.findByLabelText('Repository');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'acme/notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(api.connectRepository).toHaveBeenCalledTimes(1));
    expect(api.connectRepository).toHaveBeenCalledWith('prj-1', {
      owner: 'acme',
      repository: 'notes',
      branch: 'trunk',
    });
    expect(await screen.findByText(/Connected to acme\/notes on trunk\./)).toBeTruthy();
  });

  it('compares both sides and lists what would move', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      createPlan: vi.fn(async () =>
        plan({
          pull: [{ kind: 'add', path: 'docs/b.md', from: null, hash: 'h', size: 3 }],
        }),
      ),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Compare with GitHub' }));
    const panel = await screen.findByTestId('sync-plan');
    expect(panel.textContent).toContain('1 to publish, 1 to bring in');
    expect(panel.textContent).toContain('changed src/a.ts');
    expect(panel.textContent).toContain('added docs/b.md');
    expect(api.createPlan).toHaveBeenCalledWith('prj-1');
  });

  it('will not let an undecided conflict be applied', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      createPlan: vi.fn(async () =>
        plan({
          status: 'needs-approval',
          conflicts: [
            {
              id: 'c1',
              path: 'src/a.ts',
              kind: 'both-modified',
              resolution: null,
              localHash: 'l',
              remoteHash: 'r',
            },
          ],
        }),
      ),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Compare with GitHub' }));
    const apply = await screen.findByRole('button', { name: 'Apply sync' });
    expect(apply).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sync-blockers').textContent).toContain(
      'One file changed on both sides',
    );
    expect(screen.getByText('src/a.ts was changed on both sides.')).toBeTruthy();
    fireEvent.click(apply);
    expect(api.applyPlan).not.toHaveBeenCalled();
  });

  it('sends a conflict decision and takes the plan the server returns', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      createPlan: vi.fn(async () =>
        plan({
          status: 'needs-approval',
          conflicts: [
            {
              id: 'c1',
              path: 'src/a.ts',
              kind: 'both-modified',
              resolution: null,
              localHash: 'l',
              remoteHash: 'r',
            },
          ],
        }),
      ),
      resolveConflict: vi.fn(async () =>
        plan({
          status: 'needs-approval',
          conflicts: [
            {
              id: 'c1',
              path: 'src/a.ts',
              kind: 'both-modified',
              resolution: 'keep-remote' as const,
              localHash: 'l',
              remoteHash: 'r',
            },
          ],
        }),
      ),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Compare with GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: /Keep GitHub's version/ }));

    await waitFor(() =>
      expect(api.resolveConflict).toHaveBeenCalledWith('plan-1', 'c1', {
        resolution: 'keep-remote',
      }),
    );
    // Still blocked, now on approval instead of the conflict.
    expect(await screen.findByText('Keeping GitHub’s version.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply sync' })).toHaveProperty('disabled', true);
  });

  it('approves, then applies, and reports the commit the server sent', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      createPlan: vi.fn(async () => plan({ status: 'needs-approval' })),
      applyPlan: vi.fn(async () => ({ plan: plan(), commitSha: MASTER })),
      fetchHistory: vi.fn(async () => ({
        entries: [
          {
            entryId: 'h1',
            projectId: 'prj-1',
            owner: 'acme',
            repository: 'notes',
            branch: 'main',
            outcome: 'success' as const,
            commitSha: MASTER,
            message: '',
            at: '2026-11-06T12:00:00.000Z',
            added: [],
            modified: ['src/a.ts'],
            deleted: [],
            pulled: 0,
            conflicts: 0,
            approval: 'approved' as const,
            failureCode: null,
          },
        ],
        persistence: 'memory' as const,
      })),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Compare with GitHub' }));
    expect(await screen.findByRole('button', { name: 'Apply sync' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve this sync' }));
    await waitFor(() => expect(api.approvePlan).toHaveBeenCalledWith('plan-1'));

    const apply = await screen.findByRole('button', { name: 'Apply sync' });
    await waitFor(() => expect(apply).toHaveProperty('disabled', false));
    fireEvent.click(apply);

    await waitFor(() => expect(api.applyPlan).toHaveBeenCalledWith('plan-1'));
    expect(await screen.findByText('Sync finished. Published aaaaaaa.')).toBeTruthy();
    // The history row is a second, independent statement of the same commit.
    const historyLine = await screen.findByText(/1 changed\. Published aaaaaaa\./);
    expect(historyLine.textContent).toContain('Published aaaaaaa.');
  });

  it('says both sides match instead of showing an empty plan', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      createPlan: vi.fn(async () => plan({ push: [], pull: [], unchanged: 9 })),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Compare with GitHub' }));
    expect(await screen.findByText('Both sides match')).toBeTruthy();
  });

  it('shows the reason the server gave when a comparison fails', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      createPlan: vi.fn(async () => {
        throw new ApiError(
          409,
          'SYNC_REMOTE_CHANGED',
          'Someone pushed to this branch while you were comparing.',
        );
      }),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Compare with GitHub' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Someone pushed to this branch while you were comparing.',
    );
  });

  it('says the history is in memory, and shows what each sync did', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => CONNECTED),
      fetchHistory: vi.fn(async () => ({
        entries: [
          {
            entryId: 'h1',
            projectId: 'prj-1',
            owner: 'acme',
            repository: 'notes',
            branch: 'main',
            outcome: 'failure' as const,
            commitSha: null,
            message: '',
            at: '2026-11-06T12:00:00.000Z',
            added: [],
            modified: [],
            deleted: [],
            pulled: 0,
            conflicts: 1,
            approval: 'not-required' as const,
            failureCode: 'SYNC_CONFLICT',
          },
        ],
        persistence: 'memory' as const,
      })),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);
    expect((await screen.findByTestId('sync-persistence')).textContent).toContain(
      'kept in memory by the API',
    );
    expect(screen.getByText('The sync failed (SYNC_CONFLICT).')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('disconnects without claiming anything changed on GitHub', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn().mockResolvedValueOnce(CONNECTED).mockResolvedValue(status()),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.disconnectRepository).toHaveBeenCalledWith('prj-1'));
    expect(await screen.findByText('Disconnected. Nothing on GitHub was changed.')).toBeTruthy();
    expect(await screen.findByText('Connect a repository')).toBeTruthy();
  });

  it('tells an offline reader the truth immediately', async () => {
    render(<SyncPage projectId="prj-1" api={fakeApi()} isOffline={(() => true) as never} />);
    expect(await screen.findByText('You are offline')).toBeTruthy();
    expect(screen.getByText('GitHub sync needs a connection. Nothing was changed.')).toBeTruthy();
  });

  it('says why the page could not load rather than rendering an empty shell', async () => {
    const api = fakeApi({
      fetchSyncStatus: vi.fn(async () => {
        throw new ApiError(502, 'SYNC_UNAVAILABLE', 'The GitHub connection could not be checked.');
      }),
    });
    render(<SyncPage projectId="prj-1" api={api} isOffline={offline} />);
    expect(await screen.findByText('The connection could not be checked')).toBeTruthy();
    expect(screen.getByText('The GitHub connection could not be checked.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
