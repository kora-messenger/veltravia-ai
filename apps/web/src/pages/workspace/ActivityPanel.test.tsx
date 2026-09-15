import { afterEach, describe, expect, it } from 'vitest';

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { ActivityPanel } from './ActivityPanel';
import type { ActivityEntryView } from './message-model';

afterEach(() => cleanup());

describe('ActivityPanel', () => {
  it('renders honest empty states for agent and tool activity', () => {
    render(<ActivityPanel agentEntries={[]} toolEntries={[]} />);
    expect(screen.getByRole('heading', { name: 'Agent activity' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Tool activity' })).toBeDefined();
    expect(screen.getByText(/nothing yet/i)).toBeDefined();
    expect(screen.getByText(/tool calls appear here/i)).toBeDefined();
  });

  it('renders activity entries with status labels (fixture data only)', () => {
    const entries: readonly ActivityEntryView[] = [
      {
        id: 'a-1',
        label: 'Reading project files',
        status: 'running',
        detail: 'Scanning src/',
      },
      {
        id: 't-1',
        label: 'github.read',
        status: 'awaiting-confirmation',
        riskLevel: 'high',
        confirmationRequired: true,
      },
    ];
    render(<ActivityPanel agentEntries={entries.slice(0, 1)} toolEntries={entries.slice(1)} />);
    expect(screen.getByText('Reading project files')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('github.read')).toBeDefined();
    expect(screen.getByText('Waiting for confirmation')).toBeDefined();
    expect(screen.getByText('High risk')).toBeDefined();
    expect(screen.getByText('Needs your confirmation')).toBeDefined();
  });

  it('never invents activity: an empty panel renders no status labels', () => {
    render(<ActivityPanel agentEntries={[]} toolEntries={[]} />);
    for (const absent of ['Completed', 'Failed', 'Running', 'Queued']) {
      expect(screen.queryByText(absent)).toBeNull();
    }
  });
});
