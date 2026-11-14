// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ui';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AgentProfileProvider } from '../agent/AgentProfileProvider';
import { ProfileDialog } from './ProfileDialog';
import { TopBar } from './TopBar';

/**
 * The assistant's name no longer sits in the chat header: the chat screen carries
 * neither the product mark nor a name there. It is still readable in the menu's
 * agent row and still editable, from the profile dialog, and these cover that round
 * trip: read it, change it, restore the default, and see the server's answer.
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

const wrap = (children: React.ReactNode) =>
  render(
    <ThemeProvider>
      <ToastProvider>
        <AgentProfileProvider>{children}</AgentProfileProvider>
      </ToastProvider>
    </ThemeProvider>,
  );

const renderDialog = () => wrap(<ProfileDialog open onClose={() => {}} />);

/** The dialog re-seeds its fields when the profile lands, so edit only after that. */
const loadedField = async (value: string) => {
  // The default name is also what shows before the read lands, so the person's name
  // (empty until then) is what proves the profile has arrived.
  const owner = screen.getByLabelText('Your name') as HTMLInputElement;
  await waitFor(() => expect(owner.value).toBe('Ijezie'));
  const field = screen.getByLabelText("Your assistant's name") as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe(value));
  return field;
};

beforeEach(() => {
  getAgentProfile.mockReset();
  updateAgentProfile.mockReset();
  resetAgentName.mockReset();
  getAgentProfile.mockResolvedValue(response('My Engineer', true));
});

afterEach(() => {
  cleanup();
});

describe('the chat header', () => {
  it('carries neither the product mark nor the assistant’s name', async () => {
    const { container } = wrap(
      <TopBar route={{ id: 'chat', title: 'Chat' }} onOpenMobileNav={() => {}} />,
    );
    await waitFor(() => expect(getAgentProfile).toHaveBeenCalled());
    expect(container.querySelector('.v-topbar__brand')).toBeNull();
    expect(container.querySelector('.v-topbar__title')).toBeNull();
    expect(screen.queryByText('My Engineer')).toBeNull();
    expect(screen.queryByRole('button', { name: /your agent/i })).toBeNull();
  });

  it('still gives every other page its mark and its own title', () => {
    const { container } = wrap(
      <TopBar route={{ id: 'settings', title: 'Settings' }} onOpenMobileNav={() => {}} />,
    );
    expect(container.querySelector('.v-topbar__brand img')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeDefined();
  });
});

describe('naming the assistant from the profile dialog', () => {
  it('shows the stored name in its own field, apart from the person’s name', async () => {
    getAgentProfile.mockResolvedValue(response('Ada'));
    renderDialog();
    await waitFor(() =>
      expect((screen.getByLabelText("Your assistant's name") as HTMLInputElement).value).toBe(
        'Ada',
      ),
    );
    expect(screen.getByLabelText('Your name')).toBeDefined();
  });

  it('saves a new name and sends both fields to the server', async () => {
    updateAgentProfile.mockResolvedValue(response('Kora'));
    renderDialog();
    const field = await loadedField('My Engineer');
    fireEvent.change(field, { target: { value: 'Kora' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateAgentProfile).toHaveBeenCalled());
    expect(updateAgentProfile.mock.calls[0]?.[0]).toMatchObject({ agentName: 'Kora' });
  });

  it('keeps the dialog open and says why when the server refuses', async () => {
    updateAgentProfile.mockRejectedValue(
      new ApiError(422, 'AGENT_NAME_TOO_LONG', 'An agent name can be at most 40 characters.'),
    );
    renderDialog();
    const field = await loadedField('My Engineer');
    fireEvent.change(field, { target: { value: 'Something else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('will not submit an empty assistant name', async () => {
    renderDialog();
    const field = await loadedField('My Engineer');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(updateAgentProfile).not.toHaveBeenCalled();
  });

  it('offers the default back only once a custom name exists', async () => {
    renderDialog();
    await waitFor(() => expect(getAgentProfile).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Restore the default name' })).toBeNull();
    cleanup();

    getAgentProfile.mockResolvedValue(response('Ada'));
    renderDialog();
    expect(await screen.findByRole('button', { name: 'Restore the default name' })).toBeDefined();
  });

  it('restores the default through the server', async () => {
    getAgentProfile.mockResolvedValue(response('Ada'));
    resetAgentName.mockResolvedValue(response('My Engineer', true));
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore the default name' }));
    await waitFor(() => expect(resetAgentName).toHaveBeenCalled());
  });
});
