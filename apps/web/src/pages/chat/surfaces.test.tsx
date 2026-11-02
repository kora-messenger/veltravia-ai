// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';

/**
 * The website and the packaged app are two layouts over one engine. These
 * tests hold that contract: same composer, same engine, different arrangement,
 * and the choice comes from where the bundle runs rather than from width.
 */

const startRun = vi.fn();
const getCapabilities = vi.fn();
const getRun = vi.fn();
const cancelRun = vi.fn();

vi.mock('../../api/reasoning', () => ({
  startRun: (input: unknown) => startRun(input),
  getCapabilities: () => getCapabilities(),
  getRun: (id: string) => getRun(id),
  cancelRun: (id: string) => cancelRun(id),
  isTerminal: () => false,
}));

const { ChatPage } = await import('./ChatPage');

const capabilities = {
  profiles: [],
  limits: {
    maxIterations: 8,
    maxToolCalls: 8,
    maxDurationMs: 60000,
    maxProviderRetries: 1,
    contextBudgetChars: 8000,
  },
  ceilings: {
    maxIterations: 50,
    maxToolCalls: 50,
    maxDurationMs: 600000,
    maxProviderRetries: 3,
    contextBudgetChars: 32000,
  },
  provider: { connected: false, reason: null, modes: ['gateway', 'simulated'] },
  tools: [],
  simulatedReasoningAllowed: true,
};

const renderPage = () =>
  render(
    <ToastProvider>
      <ChatPage />
    </ToastProvider>,
  );

/** Pretends the bundle is running inside the packaged Android application. */
const runAsPackagedApp = () => {
  (window as unknown as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
    isNativePlatform: () => true,
  };
};

beforeEach(() => {
  startRun.mockReset();
  getCapabilities.mockReset();
  getRun.mockReset();
  cancelRun.mockReset();
  getCapabilities.mockResolvedValue(capabilities);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('the website layout', () => {
  it('centres a greeting behind the mark and puts each action on its card', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Hey there');
    expect(screen.getByRole('button', { name: 'Open the app builder' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open document intelligence' })).toBeDefined();
    // Website cards can be dismissed for the session.
    expect(screen.getAllByRole('button', { name: /^Dismiss suggestion/ })).toHaveLength(2);
  });

  it('does not render the app-only new-conversation circle', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: 'Start a new conversation' })).toBeNull();
  });
});

describe('the packaged app layout', () => {
  it('drops the hero greeting for the phone arrangement', () => {
    runAsPackagedApp();
    renderPage();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByText(/Hey there/)).toBeNull();
    expect(screen.getByRole('button', { name: /Build something new/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Ask about your documents/ })).toBeDefined();
  });

  it('offers the new-conversation circle the reference has', () => {
    runAsPackagedApp();
    renderPage();
    expect(screen.getByRole('button', { name: 'Start a new conversation' })).toBeDefined();
  });

  it('keeps the same type box as the website', () => {
    runAsPackagedApp();
    renderPage();
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe(
      "What's on your mind",
    );
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDefined();
  });

  it('lets a prompt row start a conversation on the shared engine', () => {
    runAsPackagedApp();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Build something new/ }));
    // Navigation is the whole action: the hash carries the destination.
    expect(window.location.hash).toBe('#/builder');
  });

  it('does not offer per-card dismissal, unlike the website', () => {
    runAsPackagedApp();
    renderPage();
    expect(screen.queryByRole('button', { name: /^Dismiss suggestion/ })).toBeNull();
  });
});
