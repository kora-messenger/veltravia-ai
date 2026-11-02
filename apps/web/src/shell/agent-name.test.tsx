// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ui';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AgentProfileProvider } from '../agent/AgentProfileProvider';
import { TopBar } from './TopBar';

/**
 * The header is where the assistant's name lives, so this covers the whole
 * round trip: read it, open the editor from the name itself (there is no
 * pencil), save, and see the header agree with the server.
 */

const { getAgentProfile, updateAgentProfile, resetAgentName } = vi.hoisted(() => ({
  getAgentProfile: vi.fn(),
  updateAgentProfile: vi.fn(),
  resetAgentName: vi.fn(),
}));

vi.mock('../api/agent-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/agent-profile')>()),
  getAgentProfile,
  updateAgentProfile,
  resetAgentName,
}));

const { ApiError } = await import('../api/client');

const profile = {
  agentName: 'My Engineer',
  ownerName: 'Ijezie',
  isDefault: true,
  updatedAt: null as string | null,
};
const response = (name: string, isDefault = false) => ({
  profile: { ...profile, agentName: name, isDefault },
  maxLength: 40,
  durable: false,
  note: 'held in memory',
});

const renderHeader = () =>
  render(
    <ThemeProvider>
      <ToastProvider>
        <AgentProfileProvider>
          <TopBar route={{ id: 'chat', title: 'Chat' }} onOpenMobileNav={() => {}} />
        </AgentProfileProvider>
      </ToastProvider>
    </ThemeProvider>,
  );

beforeEach(() => {
  getAgentProfile.mockReset();
  updateAgentProfile.mockReset();
  resetAgentName.mockReset();
  getAgentProfile.mockResolvedValue(response('My Engineer', true));
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('the assistant’s name in the header', () => {
  it('shows the stored name instead of the route title', async () => {
    getAgentProfile.mockResolvedValue(response('Ada'));
    renderHeader();
    expect(await screen.findByRole('heading', { level: 1, name: 'Ada' })).toBeDefined();
    expect(screen.queryByRole('heading', { level: 1, name: 'Chat' })).toBeNull();
  });

  it('edits only the agent name, never the account name', async () => {
    renderHeader();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Name your agent (currently called My Engineer)' }),
    );
    expect(screen.getByLabelText('Agent name')).toBeDefined();
    // The account name is a different thing and is not asked for here.
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
  });

  it('opens the editor from the name itself, with no pencil control', async () => {
    renderHeader();
    const trigger = await screen.findByRole('button', {
      name: 'Name your agent (currently called My Engineer)',
    });
    // One control around the name: no separate icon button beside it.
    expect(screen.getAllByRole('button', { name: /your agent/i })).toHaveLength(1);
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(screen.getByLabelText('Agent name')).toBeDefined();
  });

  it('saves a new name and updates the header everywhere', async () => {
    updateAgentProfile.mockResolvedValue(response('Kora'));
    renderHeader();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Name your agent (currently called My Engineer)' }),
    );
    const field = screen.getByLabelText('Agent name');
    fireEvent.change(field, { target: { value: 'Kora' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(updateAgentProfile).toHaveBeenCalledWith({ agentName: 'Kora' }, undefined);
    expect(await screen.findByRole('heading', { level: 1, name: 'Kora' })).toBeDefined();
  });

  it('keeps the dialog open and says why when the server refuses', async () => {
    updateAgentProfile.mockRejectedValue(
      new ApiError(422, 'AGENT_NAME_TOO_LONG', 'An agent name can be at most 40 characters.'),
    );
    renderHeader();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Name your agent (currently called My Engineer)' }),
    );
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Something else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/at most 40 characters/)).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'My Engineer' })).toBeDefined();
  });

  it('will not submit an empty name', async () => {
    renderHeader();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Name your agent (currently called My Engineer)' }),
    );
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(updateAgentProfile).not.toHaveBeenCalled();
  });

  it('offers the default back only once a custom name exists', async () => {
    getAgentProfile.mockResolvedValue(response('Ada'));
    renderHeader();
    fireEvent.click(await screen.findByRole('button', { name: /your agent/i }));
    expect(screen.getByRole('button', { name: 'Restore the default name' })).toBeDefined();
  });

  it('keeps the default name in the header when the read fails, and says so', async () => {
    getAgentProfile.mockRejectedValue(new ApiError(0, 'NETWORK', 'offline'));
    renderHeader();
    expect(await screen.findByRole('heading', { level: 1, name: 'My Engineer' })).toBeDefined();
  });
});
