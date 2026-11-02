// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApiError } from '../../api/client';
import { ChatErrorState, failureReason } from './ChatErrorState';
import { classifySendFailure } from './useChat';

/**
 * A page with no backend behind it used to report "The request was not accepted"
 * and offer Retry, which is a promise it cannot keep: this page is served as
 * static files from GitHub Pages, so /api belongs to the static host.
 */

afterEach(cleanup);

describe('a host that is not the API', () => {
  it('reads a 404 as a missing backend, not a rejected request', () => {
    const failure = classifySendFailure(new ApiError(404, 'NOT_FOUND', 'Not Found'));
    expect(failure.kind).toBe('missing');
    expect(failureReason(failure.kind)).toBe('No backend is connected to this page');
  });

  it('still calls a 400 a rejected request', () => {
    expect(classifySendFailure(new ApiError(400, 'BAD_REQUEST', 'nope')).kind).toBe('rejected');
  });

  it('hides Retry when trying again cannot change the outcome', () => {
    render(
      <ChatErrorState
        reason={failureReason('missing')}
        retrying={false}
        onRetry={vi.fn()}
        canRetry={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('No backend is connected to this page')).toBeDefined();
  });

  it('keeps Retry for failures that might succeed next time', () => {
    render(<ChatErrorState reason={failureReason('offline')} retrying={false} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });
});
