/**
 * The way back to the newest content.
 *
 * The thread is long, and reading an earlier part of it means the newest part is
 * off screen. Whether or not the agent is still working, getting back should not
 * mean swiping. This control is that way back: a small frosted circle sitting over
 * the end of the thread, centred above the type box.
 *
 * It carries two states, because the two cases mean different things:
 *
 * - A run in progress: three dots rising and falling in turn. Work is happening
 *   out of sight, so the mark says something is still going on.
 * - No run in progress: a plain downward chevron. Nothing is happening; the mark
 *   only says the newest message is below.
 *
 * Either way it exists only when the reader is away from the bottom. At the bottom
 * there is nothing to come back to, and a control that does nothing is noise.
 */

export interface LiveEdgeButtonProps {
  /** A run is in progress. Chooses the mark, not whether the control exists. */
  readonly working: boolean;
  /** The reader has scrolled away from the newest content. */
  readonly awayFromBottom: boolean;
  readonly onReturn: () => void;
}

/**
 * Whether the control should be on screen.
 *
 * This depends only on the reader's position. The earlier version also required a
 * run in progress, which meant it vanished the moment an answer landed, exactly
 * when a reader who had scrolled up would want it. Kept pure so it is tested
 * directly.
 */
export function shouldShowLiveEdge(awayFromBottom: boolean): boolean {
  return awayFromBottom;
}

/** The spoken name of the control, which differs with what it will do. */
export function liveEdgeLabel(working: boolean): string {
  return working ? 'Still working. Jump to the latest activity' : 'Jump to the latest message';
}

export function LiveEdgeButton({ working, awayFromBottom, onReturn }: LiveEdgeButtonProps) {
  if (!shouldShowLiveEdge(awayFromBottom)) return null;
  return (
    <button
      type="button"
      className="v-live-edge"
      data-state={working ? 'working' : 'idle'}
      onClick={onReturn}
      aria-label={liveEdgeLabel(working)}
    >
      {working ? (
        <span className="v-live-edge__dots" aria-hidden="true">
          <span className="v-live-edge__dot" />
          <span className="v-live-edge__dot" />
          <span className="v-live-edge__dot" />
        </span>
      ) : (
        <svg
          className="v-live-edge__chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      )}
    </button>
  );
}
