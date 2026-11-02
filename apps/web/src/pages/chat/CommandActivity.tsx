import { useId } from 'react';
import type { AgentActivityEvent } from '@veltravia/shared';
import { Spinner } from '../../components/ui';
import { formatDuration } from './activity';
import { isCommandActivity, statusWord } from './agentActivity';
import { CheckIcon, ChevronIcon, CodeIcon, PauseIcon, StatusChip } from './chatIcons';

/**
 * One row of the timeline.
 *
 * The mark says two things at once: what kind of work this was (a command wears
 * the `</>` mark) and how it went (a finished non-command wears the tick chip, a
 * failure wears the punched-out chip, a refusal wears the muted one, a step
 * waiting on a person wears the pause). A row that is still running gets a
 * spinner and nothing else - no tick before the work is done.
 *
 * Opening a row shows the two blocks the server published: the sanitised
 * arguments and what came back. That is the whole record; there is no third,
 * hidden layer for this page to reveal.
 */
export function CommandActivity({
  activity,
  open,
  onToggle,
  nested = false,
}: {
  readonly activity: AgentActivityEvent;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly nested?: boolean;
}) {
  const panelId = useId();
  const command = isCommandActivity(activity.category);
  const duration = formatDuration(activity.durationMs);
  const className = [
    'v-act__row',
    nested ? 'is-nested' : '',
    activity.status === 'failed' ? 'is-failed' : '',
    activity.status === 'succeeded' ? 'is-done' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <li className={className}>
      <button
        type="button"
        className="v-act__button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className="v-act__mark" aria-hidden="true">
          <Mark activity={activity} command={command} />
        </span>
        <span className="v-act__title">{activity.title}</span>
        {duration !== null ? <span className="v-act__time">{duration}</span> : null}
        <span className={open ? 'v-act__chevron is-open' : 'v-act__chevron'} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>

      {open ? (
        <div className="v-act__panel" id={panelId}>
          <dl className="v-act__meta">
            <div>
              <dt>Status</dt>
              <dd>{statusWord(activity.status)}</dd>
            </div>
            {duration !== null ? (
              <div>
                <dt>Duration</dt>
                <dd>{duration}</dd>
              </div>
            ) : null}
            {activity.retryCount > 0 ? (
              <div>
                <dt>Retries</dt>
                <dd>{activity.retryCount}</dd>
              </div>
            ) : null}
          </dl>
          {activity.error !== null ? (
            <p className="v-act__error">{activity.error.message}</p>
          ) : null}
          <Block label="Command" text={activity.safeInput} empty="This step ran no command." />
          <Block label="Output" text={activity.safeOutput} empty="This step returned nothing." />
        </div>
      ) : null}
    </li>
  );
}

function Mark({
  activity,
  command,
}: {
  readonly activity: AgentActivityEvent;
  readonly command: boolean;
}) {
  if (activity.status === 'running' || activity.status === 'pending') {
    return <Spinner size="sm" aria-label={`${activity.title}: working`} />;
  }
  if (activity.status === 'failed') return <StatusChip state="failed" />;
  if (activity.status === 'cancelled') return <StatusChip state="refused" />;
  if (activity.status === 'awaiting_approval') {
    return (
      <span className="v-act__pause">
        <PauseIcon />
      </span>
    );
  }
  if (command) {
    return (
      <span className="v-act__code">
        <CodeIcon />
      </span>
    );
  }
  return <StatusChip state="done" />;
}

function Block({
  label,
  text,
  empty,
}: {
  readonly label: string;
  readonly text: string | null;
  readonly empty: string;
}) {
  return (
    <div className="v-act__block">
      <span className="v-act__block-label">{label}</span>
      {text === null ? (
        <p className="v-act__empty">{empty}</p>
      ) : (
        <pre className="v-act__pre">{text}</pre>
      )}
    </div>
  );
}

/** The tick used in the timeline header once a run is over. */
export function DoneMark({ failed }: { readonly failed: boolean }) {
  if (failed) return <StatusChip state="failed" />;
  return (
    <span className="v-act__tick" aria-hidden="true">
      <CheckIcon />
    </span>
  );
}
