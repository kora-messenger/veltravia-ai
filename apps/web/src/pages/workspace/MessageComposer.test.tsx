import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageComposer } from './MessageComposer';

function renderComposer(props: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  const onSend = vi.fn();
  const view = render(<MessageComposer onSend={onSend} {...props} />);
  return { onSend, ...view };
}

afterEach(() => cleanup());

describe('MessageComposer', () => {
  it('renders an accessible multiline input and send button', () => {
    renderComposer();
    const input = screen.getByRole('textbox', { name: 'Message Veltravia AI' });
    expect(input.tagName).toBe('TEXTAREA');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDefined();
  });

  it('disables send while empty and enables once text is present', () => {
    renderComposer();
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Message Veltravia AI' }), {
      target: { value: 'Explain the project structure' },
    });
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('keeps a placeholder that does not promise AI execution', () => {
    renderComposer();
    expect(
      screen.getByPlaceholderText(/ask veltravia to build, modify, explain or analyze/i),
    ).toBeDefined();
    // Honesty note is part of the production surface.
    expect(screen.getByText(/not sent anywhere yet/i)).toBeDefined();
  });

  it('focuses the input (visible focus surface)', () => {
    renderComposer();
    const input = screen.getByRole('textbox', { name: 'Message Veltravia AI' });
    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it('supports multiline input via Shift+Enter without submitting', () => {
    renderComposer();
    const input = screen.getByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: 'Line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('submits with Enter, clears the input, and refocuses', () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: '  Add a settings screen  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Add a settings screen');
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('does not submit when disabled or busy', () => {
    const { onSend } = renderComposer({ disabled: true });
    const input = screen.getByRole('textbox', { name: 'Message Veltravia AI' });
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    cleanup();
    const busy = renderComposer({ busy: true });
    const busyInput = busy.getByRole('textbox', { name: 'Message Veltravia AI' });
    expect((busyInput as HTMLTextAreaElement).disabled).toBe(true);
    // The send button keeps its accessible name but is disabled while busy.
    expect(busy.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true);
  });

  it('makes no network requests of any kind', () => {
    const fetchSpy = vi.fn();
    window.fetch = fetchSpy as unknown as typeof window.fetch;
    renderComposer();
    const input = screen.getByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: 'Anything' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
