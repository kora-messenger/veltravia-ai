// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RunActivityLine } from './RunActivity';
import type { ChatActivity } from './activity';

const running = (steps: ChatActivity['steps'] = []): ChatActivity => ({
  label: steps.length > 0 ? steps[steps.length - 1]!.label : 'Working on it',
  steps,
  running: true,
});

afterEach(cleanup);

describe('the live status line', () => {
  it('shows a spinner and the run’s own words while it works', () => {
    render(<RunActivityLine activity={running()} />);
    expect(screen.getByText('Working on it')).toBeDefined();
    expect(screen.getByRole('status', { name: 'Still working' })).toBeDefined();
    // Nothing to expand when the run has published no steps, so no toggle.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the steps collapsed until asked, then lists them with status', () => {
    render(
      <RunActivityLine
        activity={running([
          { id: 's1', label: 'Read the failing test tail', status: 'success', durationMs: 420 },
          { id: 's2', label: 'Wrote the patch', status: 'failed', durationMs: 1200 },
        ])}
      />,
    );

    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.textContent).toContain('2 steps');
    expect(screen.queryByRole('list')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBeDefined();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Read the failing test tail');
    expect(items[0]?.textContent).toContain('Done');
    expect(items[0]?.textContent).toContain('420 ms');
    expect(items[1]?.textContent).toContain('Failed');
    expect(items[1]?.textContent).toContain('1.2 s');
  });

  it('drops the spinner once the run is over and keeps the line readable', () => {
    render(
      <RunActivityLine
        activity={{
          label: 'Read the failing test tail',
          steps: [
            { id: 's1', label: 'Read the failing test tail', status: 'success', durationMs: 10 },
          ],
          running: false,
        }}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Read the failing test tail')).toBeDefined();
    expect(screen.getByRole('button').textContent).toContain('1 step');
  });

  it('says a step is waiting for approval rather than calling it done', () => {
    render(
      <RunActivityLine
        activity={{
          label: 'Purge the sandbox',
          steps: [
            {
              id: 's1',
              label: 'Purge the sandbox',
              status: 'pending_confirmation',
              durationMs: null,
            },
          ],
          running: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listitem').textContent).toContain('Waiting for approval');
  });
});
