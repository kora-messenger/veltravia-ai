// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatAnswerActions } from './ChatAnswerActions';

/**
 * The row under an answer. What matters is that each control changes something
 * real: the clipboard, the browser's speech, the share sheet, and one opinion
 * kept locally. Controls the browser cannot honour are absent, never decorative.
 */

const writeText = vi.fn(async () => {});

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (navigator as unknown as { share?: unknown }).share;
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
});

describe('under a finished answer', () => {
  it('copies the answer and says so', async () => {
    render(<ChatAnswerActions messageId="m1" text="The answer as shown." />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy this answer' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('The answer as shown.'));
    expect(await screen.findByText('Copied')).toBeDefined();
  });

  it('records one opinion per answer, in this browser', () => {
    render(<ChatAnswerActions messageId="m2" text="Answer" />);
    const up = screen.getByRole('button', { name: 'This answer was helpful' });
    fireEvent.click(up);
    expect(up.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem('veltravia:answer-feedback') ?? '{}')).toEqual({
      m2: 'up',
    });

    // Choosing the other thumb replaces the first, and pressing it again clears.
    const down = screen.getByRole('button', { name: 'This answer was not helpful' });
    fireEvent.click(down);
    expect(up.getAttribute('aria-pressed')).toBe('false');
    expect(down.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(down);
    expect(JSON.parse(window.localStorage.getItem('veltravia:answer-feedback') ?? '{}')).toEqual(
      {},
    );
  });

  it('reads aloud with the browser voice, and stops on the second press', () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak, cancel },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
      configurable: true,
      writable: true,
    });

    render(<ChatAnswerActions messageId="m3" text="Read me" />);
    fireEvent.click(screen.getByRole('button', { name: 'Read this answer aloud' }));
    expect(speak).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading this answer' }));
    expect(cancel).toHaveBeenCalled();
  });

  it('offers share and read-aloud only where the platform has them', () => {
    render(<ChatAnswerActions messageId="m4" text="Answer" />);
    expect(screen.queryByRole('button', { name: 'Share this answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read this answer aloud' })).toBeNull();
  });

  it('shares through the platform sheet when one exists', async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
    render(<ChatAnswerActions messageId="m5" text="Answer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share this answer' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ text: 'Answer' }));
  });
});
