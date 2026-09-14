// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button, ToastProvider, useToast } from './index';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe({
  message,
  tone,
  duration,
}: {
  message: string;
  tone?: 'success';
  duration?: number;
}) {
  const { toast } = useToast();
  return (
    <Button
      onClick={() =>
        toast(
          message,
          tone === undefined && duration === undefined
            ? undefined
            : {
                ...(tone !== undefined ? { tone } : {}),
                ...(duration !== undefined ? { duration } : {}),
              },
        )
      }
    >
      fire
    </Button>
  );
}

describe('ToastProvider', () => {
  it('throws when useToast is used outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Orphan() {
      useToast();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });

  it('shows a toast with the requested tone and supports manual dismissal', async () => {
    render(
      <ToastProvider>
        <Probe message="Saved" tone="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(screen.getByText('Saved').closest('.v-toast')?.className).toContain('v-toast--success');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByText('Saved')).toBeNull());
  });

  it('auto-dismisses after the duration', async () => {
    render(
      <ToastProvider>
        <Probe message="Brief" duration={150} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByText('Brief')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Brief')).toBeNull(), { timeout: 2000 });
  });

  it('keeps a toast when duration is 0', async () => {
    render(
      <ToastProvider>
        <Probe message="Sticky" duration={0} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText('Sticky')).toBeDefined();
  });

  it('stacks multiple toasts independently', () => {
    function Double() {
      const { toast } = useToast();
      return (
        <>
          <Button onClick={() => toast('First')}>one</Button>
          <Button onClick={() => toast('Second')}>two</Button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Double />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    expect(screen.getByText('First')).toBeDefined();
    expect(screen.getByText('Second')).toBeDefined();
  });
});
