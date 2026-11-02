import { useId, useState } from 'react';
import { Spinner } from '../../components/ui';
import { formatDuration, STEP_LABEL, type ChatActivity } from './activity';
import { CheckIcon, ChevronIcon, CrossIcon, PauseIcon } from './chatIcons';

/**
 * The live status line above an answer.
 *
 * One line while a run works, with the run's own current intent, and an
 * expansion for the individual steps. The line stays after the answer arrives so
 * the work behind it can still be inspected. Nothing animates except the
 * spinner: the brand mark above it is static, per the standing rule.
 */
export function RunActivityLine({ activity }: { readonly activity: ChatActivity }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const expandable = activity.steps.length > 0;
  const summary = activity.steps.length === 1 ? '1 step' : `${activity.steps.length} steps`;

  return (
    <div className={activity.running ? 'v-chat__activity' : 'v-chat__activity is-done'}>
      <div className="v-chat__activity-row">
        {activity.running ? (
          <Spinner size="sm" aria-label="Still working" />
        ) : (
          <span className="v-chat__activity-mark" aria-hidden="true">
            <CheckIcon />
          </span>
        )}
        <span className="v-chat__activity-label">{activity.label}</span>
        {expandable ? (
          <button
            type="button"
            className="v-chat__activity-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="v-chat__activity-count">{summary}</span>
            <span className={open ? 'v-chat__chevron is-open' : 'v-chat__chevron'}>
              <ChevronIcon />
            </span>
          </button>
        ) : null}
      </div>

      {expandable && open ? (
        <ol className="v-chat__steps" id={listId}>
          {activity.steps.map((step) => {
            const duration = formatDuration(step.durationMs);
            return (
              <li className={`v-chat__step is-${step.status}`} key={step.id}>
                <span className="v-chat__step-mark" aria-hidden="true">
                  {step.status === 'success' ? (
                    <CheckIcon />
                  ) : step.status === 'pending_confirmation' ? (
                    <PauseIcon />
                  ) : (
                    <CrossIcon />
                  )}
                </span>
                <span className="v-chat__step-label">{step.label}</span>
                <span className="v-chat__step-meta">
                  {STEP_LABEL[step.status]}
                  {duration === null ? '' : ` · ${duration}`}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
