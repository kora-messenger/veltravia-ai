/**
 * The way back to the live edge.
 *
 * While the agent is working the thread grows at the bottom. A reader who scrolled
 * up to look at an earlier step is then looking at a page that is still changing
 * out of sight, and nothing tells them so. This control is that signal: a small
 * frosted circle with three dots that rise and fall in turn, sitting over the
 * middle of the type box. Tapping it returns to the newest activity.
 *
 * It exists only for the combination that needs it, a run in progress AND a
 * reader who is away from the bottom. At the bottom there is nothing to come back
 * to, and with no run in progress the dots would claim work that is not happening.
 */

export interface LiveEdgeButtonProps {
  /** A run is in progress. */
  readonly working: boolean;
  /** The reader has scrolled away from the newest content. */
  readonly awayFromBottom: boolean;
  readonly onReturn: () => void;
}

/** Whether the control should be on screen. Kept pure so it is tested directly. */
export function shouldShowLiveEdge(working: boolean, awayFromBottom: boolean): boolean {
  return working && awayFromBottom;
}

export function LiveEdgeButton({ working, awayFromBottom, onReturn }: LiveEdgeButtonProps) {
  if (!shouldShowLiveEdge(working, awayFromBottom)) return null;
  return (
    <button
      type="button"
      className="v-live-edge"
      onClick={onReturn}
      aria-label="Still working. Jump to the latest activity"
    >
      <span className="v-live-edge__dots" aria-hidden="true">
        <span className="v-live-edge__dot" />
        <span className="v-live-edge__dot" />
        <span className="v-live-edge__dot" />
      </span>
    </button>
  );
}
