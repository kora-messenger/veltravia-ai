// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveEdgeButton, liveEdgeLabel, shouldShowLiveEdge } from './LiveEdgeButton';

afterEach(cleanup);

describe('shouldShowLiveEdge', () => {
  it('depends only on where the reader is, not on whether a run is going', () => {
    expect(shouldShowLiveEdge(true)).toBe(true);
    expect(shouldShowLiveEdge(false)).toBe(false);
  });
});

describe('LiveEdgeButton', () => {
  it('renders nothing when the reader is already at the newest content', () => {
    const { container } = render(
      <LiveEdgeButton working awayFromBottom={false} onReturn={vi.fn()} />,
    );
    expect(container.childElementCount).toBe(0);
  });

  it('stays on screen after the run ends, which is when a reader who scrolled up wants it', () => {
    render(<LiveEdgeButton working={false} awayFromBottom onReturn={vi.fn()} />);
    expect(screen.getByRole('button', { name: liveEdgeLabel(false) })).toBeDefined();
  });

  it('is a labelled button that returns the reader to the newest content', () => {
    const onReturn = vi.fn();
    render(<LiveEdgeButton working awayFromBottom onReturn={onReturn} />);
    fireEvent.click(screen.getByRole('button', { name: /still working/i }));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('draws three decorative dots while a run is in progress', () => {
    const { container } = render(<LiveEdgeButton working awayFromBottom onReturn={vi.fn()} />);
    expect(container.querySelector('.v-live-edge')?.getAttribute('data-state')).toBe('working');
    expect(container.querySelector('.v-live-edge__dots')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.v-live-edge__dot')).toHaveLength(3);
    expect(container.querySelector('.v-live-edge__chevron')).toBeNull();
  });

  it('draws a still chevron once nothing is running, with no dots left behind', () => {
    const { container } = render(
      <LiveEdgeButton working={false} awayFromBottom onReturn={vi.fn()} />,
    );
    expect(container.querySelector('.v-live-edge')?.getAttribute('data-state')).toBe('idle');
    expect(container.querySelector('.v-live-edge__chevron')).not.toBeNull();
    expect(container.querySelectorAll('.v-live-edge__dot')).toHaveLength(0);
  });

  it('says what it will do in each state', () => {
    expect(liveEdgeLabel(true)).toMatch(/still working/i);
    expect(liveEdgeLabel(false)).toMatch(/latest message/i);
  });
});
