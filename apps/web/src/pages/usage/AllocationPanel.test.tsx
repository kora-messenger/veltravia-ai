// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AllocationPanel, type AllocationPanelDeps } from './AllocationPanel';
import type { AllocationSummary } from '../../api/allocations';

/**
 * The allocation panel's promises, as assertions.
 *
 * Each test is about something the screen could get wrong in a way that would
 * mislead: a missing pool drawn as zero, two lanes merged into one number, an
 * allocation that cannot be taken back, or an assistant trail that silently
 * disappears when the read fails.
 */

const summary = (overrides: Partial<AllocationSummary> = {}): AllocationSummary => ({
  workspaceId: 'ws_1',
  note: 'Allocations are ceilings over the workspace wallet.',
  categories: [
    {
      category: 'ai_tokens',
      pool: { set: true, total: 5_000, allocated: 2_000, available: 3_000, note: '' },
      totals: { allocated: 2_000, reserved: 100, consumed: 400, available: 1_500 },
      allocations: [
        {
          id: 'alloc_1',
          workspaceId: 'ws_1',
          category: 'ai_tokens',
          targetKind: 'project',
          targetRef: 'prj_alpha',
          allocated: 2_000,
          reserved: 100,
          consumed: 400,
          available: 1_500,
          limit: null,
          priority: 0,
          policy: 'manual',
          state: 'active',
          allowedOperations: [],
          expiresAt: null,
          version: 1,
        },
      ],
    },
    {
      category: 'integration_credits',
      pool: { set: false, total: 0, allocated: 0, available: 0, note: '' },
      totals: { allocated: 0, reserved: 0, consumed: 0, available: 0 },
      allocations: [],
    },
  ],
  ...overrides,
});

function deps(overrides: Partial<AllocationPanelDeps> = {}): AllocationPanelDeps {
  return {
    load: vi.fn(async () => summary()),
    history: vi.fn(async () => ({ events: [] })),
    activity: vi.fn(async () => ({
      entries: [
        {
          id: 'audit_1',
          tool: 'project.create',
          status: 'executed',
          resultSummary: 'Created the project "Research".',
          args: {},
          occurredAt: '2026-11-14T10:00:00.000Z',
        },
      ],
    })),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('the allocation panel', () => {
  it('says what it needs when no workspace is in view', () => {
    render(<AllocationPanel workspaceId={null} />);
    expect(screen.getByText(/Choose a workspace/i)).toBeTruthy();
  });

  it('draws both lanes separately and never adds them up', async () => {
    const load = vi.fn(async () => summary());
    render(<AllocationPanel workspaceId="ws_1" deps={deps({ load })} />);
    await waitFor(() => expect(screen.getByText('5,000')).toBeTruthy());
    // Both lane headings are drawn (each also appears once as a form option).
    expect(screen.getAllByText('AI token credits').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Integration credits').length).toBeGreaterThanOrEqual(2);
    // The integration lane has no pool, and says so rather than showing zero.
    expect(screen.getByText(/No pool is set for this lane/i)).toBeTruthy();
    // Nothing on the page adds the two lanes together.
    expect(screen.queryByText('5,000')).toBeTruthy();
    expect(screen.queryByText(/combined total/i)).toBeNull();
  });

  it('shows an allocation with what is left in it', async () => {
    render(<AllocationPanel workspaceId="ws_1" deps={deps()} />);
    await waitFor(() => expect(screen.getByText('prj_alpha')).toBeTruthy());
    expect(screen.getByText('1,500 available')).toBeTruthy();
    expect(screen.getByText('400 spent')).toBeTruthy();
    expect(screen.getByText('100 held')).toBeTruthy();
  });

  it('shows the assistant trail from the server, not from state', async () => {
    render(<AllocationPanel workspaceId="ws_1" deps={deps()} />);
    await waitFor(() => expect(screen.getByText('Created the project "Research".')).toBeTruthy());
    expect(screen.getByText('executed')).toBeTruthy();
  });

  it('still renders the lanes when the trail read fails', async () => {
    const activity = vi.fn(async () => {
      throw new Error('trail unavailable');
    });
    render(<AllocationPanel workspaceId="ws_1" deps={deps({ activity })} />);
    await waitFor(() => expect(screen.getByText('prj_alpha')).toBeTruthy());
    expect(screen.getByText(/has not performed any account actions yet/i)).toBeTruthy();
  });

  it('reports a read failure with a retry', async () => {
    const load = vi.fn(async () => {
      throw new Error('the server did not answer');
    });
    render(<AllocationPanel workspaceId="ws_1" deps={deps({ load })} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/Allocations could not be read/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('sends a reclaim for one allocation', async () => {
    const adjust = vi.fn(async () => ({ allocation: summary().categories[0]!.allocations[0]! }));
    render(<AllocationPanel workspaceId="ws_1" deps={deps({ adjust })} />);
    await waitFor(() => expect(screen.getByText('prj_alpha')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Reclaim unspent credit/i }));
    await waitFor(() =>
      expect(adjust).toHaveBeenCalledWith({ allocationId: 'alloc_1', action: 'reclaim' }),
    );
  });

  it('sets a pool for the chosen lane only', async () => {
    const setPool = vi.fn(async () => ({
      pool: { set: true, total: 900, allocated: 0, available: 900, note: '' },
    }));
    render(<AllocationPanel workspaceId="ws_1" deps={deps({ setPool })} />);
    await waitFor(() => expect(screen.getByText('prj_alpha')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Pool size'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save pool' }));
    await waitFor(() =>
      expect(setPool).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        category: 'ai_tokens',
        total: 900,
      }),
    );
  });

  it('refuses to allocate without a target', async () => {
    const create = vi.fn();
    render(<AllocationPanel workspaceId="ws_1" deps={deps({ create })} />);
    await waitFor(() => expect(screen.getByText('prj_alpha')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));
    await waitFor(() =>
      expect(screen.getByText(/Name the target this allowance is for/i)).toBeTruthy(),
    );
    expect(create).not.toHaveBeenCalled();
  });
});
