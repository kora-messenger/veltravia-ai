// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveEdgeButton, shouldShowLiveEdge } from './LiveEdgeButton';

afterEach(cleanup);

describe('shouldShowLiveEdge', () => {
  it('shows only for a run in progress AND a reader away from the bottom', () => {
    expect(shouldShowLiveEdge(true, true)).toBe(true);
    expect(shouldShowLiveEdge(true, false)).toBe(false);
    expect(shouldShowLiveEdge(false, true)).toBe(false);
    expect(shouldShowLiveEdge(false, false)).toBe(false);
  });
});

describe('LiveEdgeButton', () => {
  it('renders nothing when the run is over, so it never claims work that is not happening', () => {
    const { container } = render(
      <LiveEdgeButton working={false} awayFromBottom onReturn={vi.fn()} />,
    );
    expect(container.childElementCount).toBe(0);
  });

  it('renders nothing when the reader is already at the newest content', () => {
    const { container } = render(
      <LiveEdgeButton working awayFromBottom={false} onReturn={vi.fn()} />,
    );
    expect(container.childElementCount).toBe(0);
  });

  it('is a labelled button that returns the reader to the live edge', () => {
    const onReturn = vi.fn();
    render(<LiveEdgeButton working awayFromBottom onReturn={onReturn} />);
    const button = screen.getByRole('button', { name: /still working.*latest activity/i });
    fireEvent.click(button);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('draws three decorative dots that are hidden from assistive tech', () => {
    const { container } = render(<LiveEdgeButton working awayFromBottom onReturn={vi.fn()} />);
    const dots = container.querySelector('.v-live-edge__dots');
    expect(dots?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.v-live-edge__dot')).toHaveLength(3);
  });
});
