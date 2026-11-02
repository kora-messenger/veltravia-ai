// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RunActivityLine } from './RunActivity';
import type { ActivityStep, ChatActivity } from './activity';

const step = (over: Partial<ActivityStep> = {}): ActivityStep => ({
  id: 's1',
  label: 'Read the failing test tail',
  status: 'success',
  durationMs: 420,
  command: 'project.read-file\n{\n  "path": "src/chat.test.ts"\n}',
  output: 'Test Files  5 passed\nTests  49 passed',
  truncated: false,
  ...over,
});

const running = (steps: ChatActivity['steps'] = []): ChatActivity => ({
  label: steps.length > 0 ? steps[steps.length - 1]!.label : 'Working on it',
  steps,
  running: true,
});

const openSteps = (steps: readonly ActivityStep[]): void => {
  render(<RunActivityLine activity={running(steps)} />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
};

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
    openSteps([
      step(),
      step({ id: 's2', label: 'Wrote the patch', status: 'failed', durationMs: 1200 }),
    ]);

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
          steps: [step({ durationMs: 10 })],
          running: false,
        }}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Read the failing test tail')).toBeDefined();
    expect(screen.getByRole('button').textContent).toContain('1 step');
  });

  it('says a step is waiting for approval rather than calling it done', () => {
    openSteps([
      step({ label: 'Purge the sandbox', status: 'pending_confirmation', durationMs: null }),
    ]);
    expect(screen.getByRole('listitem').textContent).toContain('Waiting for approval');
  });
});

describe('opening a step shows what it ran', () => {
  it('reveals Command and Output only when the step is opened', () => {
    openSteps([step()]);
    expect(screen.queryByText('Command')).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false, name: /failing test tail/i }));
    expect(screen.getByText('Command')).toBeDefined();
    expect(screen.getByText('Output')).toBeDefined();
    expect(screen.getByText(/src\/chat\.test\.ts/)).toBeDefined();
    expect(screen.getByText(/49 passed/)).toBeDefined();
  });

  it('closes the step again on a second tap', () => {
    openSteps([step()]);
    const row = screen.getByRole('button', { expanded: false, name: /failing test tail/i });
    fireEvent.click(row);
    expect(screen.getByText('Command')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /failing test tail/i }));
    expect(screen.queryByText('Command')).toBeNull();
  });

  it('says so plainly when a step returned nothing', () => {
    openSteps([step({ command: null, output: null })]);
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /failing test tail/i }));
    expect(screen.getByText('This step ran no command.')).toBeDefined();
    expect(screen.getByText('This step returned nothing.')).toBeDefined();
  });

  it('admits when the server trimmed the text', () => {
    openSteps([step({ truncated: true })]);
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /failing test tail/i }));
    expect(screen.getByText('Longer text was trimmed to fit.')).toBeDefined();
  });

  it('keeps each step’s own detail to itself', () => {
    openSteps([
      step({ id: 'a', label: 'Read the file', command: 'project.read-file', output: 'first' }),
      step({ id: 'b', label: 'Write the file', command: 'project.update-file', output: 'second' }),
    ]);
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /read the file/i }));
    const opened = screen.getAllByRole('listitem')[0]!;
    expect(within(opened).getByText('first')).toBeDefined();
    expect(within(opened).queryByText('second')).toBeNull();
  });
});

describe('the mark on a step tells the truth about it', () => {
  const marksOf = (): { command: boolean; chip: boolean } => {
    const item = screen.getAllByRole('listitem')[0]!;
    const mark = item.querySelector('.v-chat__step-mark')!;
    return {
      command: mark.querySelector('svg path')?.getAttribute('d')?.includes('16 8l4 4') === true,
      chip: mark.querySelector('rect') !== null,
    };
  };

  it('gives a command that succeeded the code mark it ran under', () => {
    openSteps([step()]);
    expect(marksOf()).toEqual({ command: true, chip: false });
  });

  it('replaces that mark with the failed chip when the command failed', () => {
    openSteps([step({ status: 'failed' })]);
    expect(marksOf()).toEqual({ command: false, chip: true });
    expect(screen.getAllByRole('listitem')[0]!.className).toContain('is-failed');
  });

  it('wears the tick chip when a step had no command to run', () => {
    openSteps([step({ command: null })]);
    expect(marksOf()).toEqual({ command: false, chip: true });
  });
});
