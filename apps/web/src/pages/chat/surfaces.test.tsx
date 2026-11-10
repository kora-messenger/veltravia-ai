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
  getModelPicker: () => Promise.resolve({ automatic: {}, models: [], choice: null }),
  setChatModel: () => Promise.resolve(null),
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
  it('centres a greeting behind the mark, with the ways in stacked above the type box', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Hey there');
    // The ways in are two stacked lines in the footer, not chips and not hero text.
    const tips = document.querySelector('.v-chat__tips');
    expect(tips).not.toBeNull();
    expect(tips?.querySelectorAll('.v-chat__suggestion')).toHaveLength(2);
    expect(document.querySelector('.v-chat__prompts')).toBeNull();
    // They share the composer's footer, so the keyboard carries them with the box.
    const footer = document.querySelector('.v-chat__footer');
    expect(footer?.contains(tips as Node)).toBe(true);
    const composer = document.querySelector('.v-chat-composer');
    expect(
      (tips as Element).compareDocumentPosition(composer as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The hero itself carries only the mark and the greeting.
    expect(
      document.querySelector('.v-chat__hero')?.querySelector('.v-chat__suggestion'),
    ).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Dismiss suggestion/ })).toHaveLength(2);
  });

  it('lets a tip be dismissed, and keeps the other', () => {
    renderPage();
    fireEvent.click(
      screen.getByRole('button', { name: /Dismiss suggestion: Ask questions about your own/ }),
    );
    expect(document.querySelectorAll('.v-chat__tips .v-chat__suggestion')).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: /Dismiss suggestion: Let your agent send and manage/ }),
    );
    // Nothing left means no empty block holding space above the box.
    expect(document.querySelector('.v-chat__tips')).toBeNull();
  });

  it('keeps each tip a real destination', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Open document intelligence' }));
    expect(window.location.hash).toBe('#/documents');
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
    expect(screen.getByText(/Let your agent send and manage emails/)).toBeDefined();
    expect(screen.getByText(/Ask questions about your own documents/)).toBeDefined();
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

  it('lets a suggestion start a real navigation on the shared engine', () => {
    runAsPackagedApp();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Open document intelligence' }));
    // Navigation is the whole action: the hash carries the destination.
    expect(window.location.hash).toBe('#/documents');
  });

  it('draws its own rows, and no website chips', () => {
    runAsPackagedApp();
    renderPage();
    expect(document.querySelectorAll('.v-chat__suggestion-icon')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Connect email address' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open document intelligence' })).toBeDefined();
    // The website's tips block is not drawn twice; the app keeps its own lines.
    expect(document.querySelector('.v-chat__tips')).toBeNull();
  });

  it('fills the type box from a prompt row without sending it', () => {
    runAsPackagedApp();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Connect email address' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(
      'Connect a Email address for me so you can send and manage email on my behalf',
    );
    expect(startRun).not.toHaveBeenCalled();
  });

  it('still dismisses a row and keeps it dismissed', () => {
    runAsPackagedApp();
    renderPage();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss suggestion: Let your agent send and manage emails on your behalf',
      }),
    );
    expect(screen.queryByText(/Let your agent send and manage emails/)).toBeNull();
    expect(
      JSON.parse(window.sessionStorage.getItem('veltravia.chat.dismissed-suggestions') ?? '[]'),
    ).toEqual(['email']);
  });
});
