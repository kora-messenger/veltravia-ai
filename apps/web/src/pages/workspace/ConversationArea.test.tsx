import { afterEach, describe, expect, it } from 'vitest';

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { ConversationArea } from './ConversationArea';
import type { WorkspaceMessageView } from './message-model';

afterEach(() => cleanup());

const FIXTURE_MESSAGES: readonly WorkspaceMessageView[] = [
  { id: 'm-1', origin: 'user', text: 'Add a login page', timestamp: null },
  {
    id: 'm-2',
    origin: 'assistant',
    text: 'Here is the plan I propose.',
    timestamp: null,
  },
  {
    id: 'm-3',
    origin: 'system',
    text: 'Run paused — waiting for your confirmation.',
    timestamp: null,
  },
  {
    id: 'm-4',
    origin: 'tool',
    text: '3 files found matching "login".',
    timestamp: null,
    source: 'Tool: project.list-files',
  },
];

describe('ConversationArea', () => {
  it('shows the Veltravia introduction when the conversation is empty', () => {
    render(<ConversationArea messages={[]} />);
    expect(screen.getByRole('heading', { name: 'Build with Veltravia AI' })).toBeDefined();
    expect(screen.getByText(/describe what you want to create/i)).toBeDefined();
    expect(screen.getByText(/veltravia plans the work/i)).toBeDefined();
  });

  it('renders messages as a polite log region with accessible rows', () => {
    render(<ConversationArea messages={FIXTURE_MESSAGES} />);
    // role="log" is a polite live region: appended messages are announced
    // to assistive tech without stealing focus.
    expect(screen.getByRole('log', { name: 'Conversation messages' })).toBeDefined();
    expect(screen.getAllByRole('listitem').length).toBe(4);
  });

  it('labels every non-user message with its origin (trust language)', () => {
    render(<ConversationArea messages={FIXTURE_MESSAGES} />);
    expect(screen.getByText('Veltravia AI')).toBeDefined();
    expect(screen.getByText('System')).toBeDefined();
    expect(screen.getByText('Tool output')).toBeDefined();
    expect(screen.getByText('Tool: project.list-files')).toBeDefined();
  });

  it('renders message text as plain text, not HTML', () => {
    render(
      <ConversationArea
        messages={[
          {
            id: 'm-x',
            origin: 'tool',
            text: '<img src=x onerror="alert(1)">',
            timestamp: null,
          },
        ]}
      />,
    );
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeDefined();
    expect(document.querySelector('img')).toBeNull();
  });
});
