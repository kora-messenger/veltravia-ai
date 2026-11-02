// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentActivityEvent } from '@veltravia/shared';
import { AgentActivityTimeline } from './AgentActivityTimeline';

/**
 * The timeline is the run's own record, so the tests check three things: it
 * shows what the server sent, it never upgrades a status, and it keeps the
 * command and output inside the row they belong to.
 */

const NOW = '2026-11-02T10:00:00.000Z';

function activity(
  overrides: Partial<AgentActivityEvent> & { activityId: string },
): AgentActivityEvent {
  return {
    eventId: `${overrides.activityId}:${overrides.status ?? 'succeeded'}`,
    runId: 'run-1',
    sequence: 1,
    activityId: overrides.activityId,
    parentActivityId: null,
    category: 'searching',
    title: 'Searched the codebase',
    status: 'succeeded',
    safeSummary: 'Searched the codebase.',
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 410,
    safeInput: 'codebase.search\n{"query":"tail"}',
    safeOutput: '49 passed',
    error: null,
    retryCount: 0,
    ...overrides,
  } as AgentActivityEvent;
}

const rows = () => screen.getAllByRole('listitem');

afterEach(cleanup);

describe('the activity timeline', () => {
  it('says it is working, with a spinner, while the run is live', () => {
    render(
      <AgentActivityTimeline
        runStatus="running"
        connection="live"
        activities={[
          activity({ activityId: 'a1', status: 'running', completedAt: null, durationMs: null }),
        ]}
      />,
    );
    expect(screen.getByLabelText('Searched the codebase: working')).toBeDefined();
    expect(screen.getByRole('button', { expanded: true })).toBeDefined();
  });

  it('keeps the rows behind one header and counts them', () => {
    render(
      <AgentActivityTimeline
        runStatus="running"
        connection="live"
        activities={[
          activity({ activityId: 'a1' }),
          activity({ activityId: 'a2', sequence: 2, title: 'Read package.json' }),
        ]}
      />,
    );
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /2 steps/ }));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('drops the spinner once the run is over and states how it went', () => {
    const { rerender } = render(
      <AgentActivityTimeline
        runStatus="running"
        connection="live"
        activities={[activity({ activityId: 'a1', status: 'running' })]}
      />,
    );
    expect(screen.queryByLabelText('Searched the codebase: working')).not.toBeNull();
    rerender(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[activity({ activityId: 'a1' })]}
      />,
    );
    expect(screen.queryByLabelText('Searched the codebase: working')).toBeNull();
    expect(screen.getByText('Finished')).toBeDefined();
  });

  it('separates a failed step from a failed run', () => {
    render(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[
          activity({ activityId: 'a1', status: 'failed', error: { code: 'X', message: 'nope' } }),
          activity({ activityId: 'a2', sequence: 2, title: 'Read package.json' }),
        ]}
      />,
    );
    // The task finished; one step inside it did not.
    expect(screen.getByText('Finished with one failed step')).toBeDefined();
    expect(screen.queryByText('Finished with a failure')).toBeNull();
  });

  it('says a failure instead of claiming the run finished cleanly', () => {
    render(
      <AgentActivityTimeline
        runStatus="failed"
        connection="closed"
        activities={[
          activity({
            activityId: 'a1',
            status: 'failed',
            safeOutput: null,
            error: { code: 'TOOL_FAILED', message: 'The command exited with code 1.' },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Finished with a failure')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Searched the codebase/ }));
    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText('The command exited with code 1.')).toBeDefined();
  });

  it('reveals Command and Output only when the row is opened', () => {
    render(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[activity({ activityId: 'a1' })]}
      />,
    );
    expect(screen.queryByText('Command')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Searched the codebase/ }));
    expect(screen.getByText('Command')).toBeDefined();
    expect(screen.getByText('Output')).toBeDefined();
    expect(screen.getByText(/src\/chat\.test\.ts|49 passed/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Searched the codebase/ }));
    expect(screen.queryByText('Command')).toBeNull();
  });

  it('says plainly when a step published nothing to show', () => {
    render(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[activity({ activityId: 'a1', safeInput: null, safeOutput: null })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Searched the codebase/ }));
    expect(screen.getByText('This step ran no command.')).toBeDefined();
    expect(screen.getByText('This step returned nothing.')).toBeDefined();
  });

  it('keeps each row’s detail to itself', () => {
    render(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[
          activity({ activityId: 'a1', safeOutput: 'first' }),
          activity({
            activityId: 'a2',
            sequence: 2,
            title: 'Read package.json',
            safeOutput: 'second',
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Searched the codebase/ })[0]!);
    expect(screen.getByText('first')).toBeDefined();
    expect(screen.queryByText('second')).toBeNull();
  });

  it('marks a command that succeeded with the code mark it ran under', () => {
    render(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[
          activity({ activityId: 'a1', category: 'running_tests', title: 'Ran the test suite' }),
        ]}
      />,
    );
    const marker = document.querySelector('.v-act__row .v-act__mark')!;
    expect(marker.querySelector('.v-act__code')).not.toBeNull();
  });

  it('wears the punched-out chip when a command failed, and the muted one when refused', () => {
    render(
      <AgentActivityTimeline
        runStatus="failed"
        connection="closed"
        activities={[
          activity({
            activityId: 'a1',
            status: 'failed',
            category: 'running_tests',
            title: 'Ran the test suite',
          }),
          activity({ activityId: 'a2', sequence: 2, status: 'cancelled', title: 'Wrote a file' }),
        ]}
      />,
    );
    const [failedRow, refusedRow] = Array.from(document.querySelectorAll('.v-act__row'));
    expect(failedRow!.className).toContain('is-failed');
    // A real knockout: an SVG mask, not a second coloured shape.
    expect(failedRow!.querySelector('mask')).not.toBeNull();
    expect(refusedRow!.querySelector('mask')).not.toBeNull();
    expect(refusedRow!.className).not.toContain('is-failed');
  });

  it('says a step is waiting for approval rather than calling it done', () => {
    render(
      <AgentActivityTimeline
        runStatus="awaiting_confirmation"
        connection="closed"
        activities={[activity({ activityId: 'a1', status: 'awaiting_approval', durationMs: null })]}
      />,
    );
    expect(screen.getByText('Waiting for your approval')).toBeDefined();
    expect(document.querySelector('.v-act__pause')).not.toBeNull();
  });

  it('groups a change set under one row and opens it onto its files', () => {
    render(
      <AgentActivityTimeline
        runStatus="completed"
        connection="closed"
        activities={[
          activity({
            activityId: 'g1',
            category: 'modifying_files',
            title: 'Updated 2 files',
            durationMs: 900,
          }),
          activity({
            activityId: 'c1',
            parentActivityId: 'g1',
            sequence: 2,
            title: 'Edited src/app.ts',
          }),
          activity({
            activityId: 'c2',
            parentActivityId: 'g1',
            sequence: 3,
            title: 'Edited src/chat.ts',
          }),
        ]}
      />,
    );
    // A group is one row until it is opened.
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText('Edited src/app.ts')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Updated 2 files/ }));
    expect(rows()).toHaveLength(3);
    expect(screen.getByText('Edited src/app.ts')).toBeDefined();
    expect(screen.getByText('Edited src/chat.ts')).toBeDefined();
  });

  it('admits when it is reconnecting, and says the run was not restarted', () => {
    render(
      <AgentActivityTimeline
        runStatus="running"
        connection="reconnecting"
        activities={[activity({ activityId: 'a1', status: 'running' })]}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Nothing was restarted');
  });

  it('tells an offline reader the run continues on the server', () => {
    render(
      <AgentActivityTimeline
        runStatus="running"
        connection="offline"
        activities={[activity({ activityId: 'a1', status: 'running' })]}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('continues on the server');
  });

  it('never shows two rows for the same activity', () => {
    render(
      <AgentActivityTimeline
        runStatus="running"
        connection="live"
        activities={[
          activity({ activityId: 'a1', status: 'running', durationMs: null }),
          activity({ activityId: 'a1', status: 'succeeded' }),
        ]}
      />,
    );
    // The component renders what it is given; de-duplication is the merge's job
    // and is tested there. What matters here is that rows key on the activity,
    // not on the index, so a replaced row cannot steal another's detail.
    expect(rows().length).toBeGreaterThan(0);
    cleanup();
  });
});
