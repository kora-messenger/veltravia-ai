// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmationCard } from './ConfirmationCard';
import type { PendingConfirmationView } from '../../api/agents';

function pending(overrides: Partial<PendingConfirmationView> = {}): PendingConfirmationView {
  return {
    confirmationId: 'conf-1',
    toolId: 'mock.purge',
    invocationId: 'inv-1',
    riskLevel: 'critical',
    state: 'required',
    requestedAt: '2026-09-15T07:00:00.000Z',
    expiresAt: '2026-09-15T07:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
});

describe('ConfirmationCard', () => {
  it('renders the tool, the risk level, and an approve/reject choice', () => {
    render(
      <ConfirmationCard
        pendingConfirmation={pending()}
        submitting={false}
        error={null}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText('Run mock.purge?')).toBeDefined();
    expect(screen.getByText('Critical risk')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(false);
    // Never the requested input, never any secret.
    expect(document.body.textContent).not.toMatch(/confirmLabel/);
  });

  it('delivers the human decision to the owner callback - it decides nothing itself', () => {
    const onDecision = vi.fn();
    render(
      <ConfirmationCard
        pendingConfirmation={pending()}
        submitting={false}
        error={null}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecision).toHaveBeenCalledWith('approve');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecision).toHaveBeenCalledWith('reject');
  });

  it('locks both choices while a decision is in flight', () => {
    render(
      <ConfirmationCard
        pendingConfirmation={pending()}
        submitting={true}
        error={null}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows an expired request with no way to resurrect it', () => {
    render(
      <ConfirmationCard
        pendingConfirmation={pending({ state: 'expired' })}
        submitting={false}
        error={null}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText('Expired')).toBeDefined();
    expect(
      screen.getByText(
        'This request expired before a decision was made. It can no longer be approved.',
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows an honest note when delivering the decision failed', () => {
    render(
      <ConfirmationCard
        pendingConfirmation={pending()}
        submitting={false}
        error={'The decision did not go through.'}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('The decision did not go through.');
  });

  it('reports the state honestly when a decision was already recorded', () => {
    render(
      <ConfirmationCard
        pendingConfirmation={pending({ state: 'rejected' })}
        submitting={false}
        error={null}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText('Rejected')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true);
  });
});
