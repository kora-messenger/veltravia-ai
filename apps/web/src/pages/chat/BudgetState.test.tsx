// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { BudgetState, budgetLine, ChatThread } from './ChatThread';
import type { ChatMessage } from './useChat';

afterEach(cleanup);

const stopped = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  text: '',
  state: 'failed',
  phase: 'finished',
  runId: 'rsn_1',
  activities: [],
  report: null,
  runStatus: 'limit_reached',
  connection: null,
  budget: { kind: 'tool_calls', used: 5, ceiling: 5 },
  canContinue: true,
  ...overrides,
});

describe('a run that stopped at its budget', () => {
  it('says which budget was used, in plain words', () => {
    expect(budgetLine({ kind: 'tool_calls', used: 5, ceiling: 5 })).toBe('5 of 5 tool calls used');
    expect(budgetLine({ kind: 'iterations', used: 1, ceiling: 1 })).toBe('1 of 1 step used');
    expect(budgetLine({ kind: 'duration', used: 120000, ceiling: 300000 })).toBe(
      '2 of 5 minutes used',
    );
  });

  it('reads as a budget, not as a failure, and offers the way on', () => {
    const onContinue = vi.fn();
    render(
      <BudgetState
        budget={{ kind: 'tool_calls', used: 5, ceiling: 5 }}
        canContinue
        continuing={false}
        onContinue={onContinue}
      />,
    );
    expect(screen.getByText(/5 of 5 tool calls used/)).toBeTruthy();
    expect(screen.queryByText(/The run did not produce an answer/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Continue this run/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('says plainly when there is nothing left to continue', () => {
    render(
      <BudgetState
        budget={{ kind: 'tool_calls', used: 5, ceiling: 5 }}
        canContinue={false}
        continuing={false}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/no continuations left/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the thread shows the budget card instead of the error card', () => {
    render(
      <ChatThread
        messages={[stopped()]}
        ownerName={null}
        canRetry={false}
        onRetry={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/stopped at its budget/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue this run/ })).toBeTruthy();
  });

  it('an ordinary failed turn still shows the error card', () => {
    render(
      <ChatThread
        messages={[stopped({ runStatus: 'failed', budget: null, canContinue: false })]}
        ownerName={null}
        canRetry
        onRetry={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByText(/stopped at its budget/)).toBeNull();
  });
});
