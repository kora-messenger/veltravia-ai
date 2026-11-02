import { useId, useState } from 'react';
import { Spinner } from '../../components/ui';
import { formatDuration, STEP_LABEL, type ActivityStep, type ChatActivity } from './activity';
import { CheckIcon, ChevronIcon, CodeIcon, PauseIcon, StatusChip } from './chatIcons';

/**
 * The live status line above an answer.
 *
 * One line while a run works, with the run's own current intent, and an
 * expansion for the individual steps. The line stays after the answer arrives so
 * the work behind it can still be inspected. Nothing animates except the
 * spinner: the brand mark above it is static, per the standing rule.
 *
 * Each step opens onto what it actually ran. The two blocks are labelled
 * `Command` and `Output` and carry the server's own text: the tool and its
 * arguments, then what came back. Nothing is summarised here, because a summary
 * would be this page's account of the run rather than the run's own.
 */
export function RunActivityLine({ activity }: { readonly activity: ChatActivity }) {
  const [open, setOpen] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
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
          {activity.steps.map((step) => (
            <Step
              key={step.id}
              step={step}
              open={openStep === step.id}
              onToggle={() => setOpenStep((current) => (current === step.id ? null : step.id))}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * A step's mark.
 *
 * A command that succeeded keeps the `</>` it ran under. A command that failed
 * loses that mark: the failed chip takes its place, so a row can never claim to
 * have been a command that went through. Steps with nothing to run wear the tick
 * or the cross instead.
 */
function StepMark({ step }: { readonly step: ActivityStep }) {
  if (step.status === 'success') {
    return step.command === null ? <StatusChip state="done" /> : <CodeIcon />;
  }
  if (step.status === 'pending_confirmation') return <PauseIcon />;
  return <StatusChip state={step.status === 'rejected' ? 'refused' : 'failed'} />;
}

function Step({
  step,
  open,
  onToggle,
}: {
  readonly step: ActivityStep;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const detailId = useId();
  const duration = formatDuration(step.durationMs);

  return (
    <li className={`v-chat__step is-${step.status}`}>
      <button
        type="button"
        className="v-chat__step-row"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span className="v-chat__step-mark" aria-hidden="true">
          <StepMark step={step} />
        </span>
        <span className="v-chat__step-label">{step.label}</span>
        <span className="v-chat__step-meta">
          {STEP_LABEL[step.status]}
          {duration === null ? '' : ` · ${duration}`}
        </span>
        <span className={open ? 'v-chat__chevron is-open' : 'v-chat__chevron'} aria-hidden="true">
          <ChevronIcon size={14} />
        </span>
      </button>

      {open ? (
        <div className="v-chat__step-detail" id={detailId}>
          <DetailBlock label="Command" text={step.command} empty="This step ran no command." />
          <DetailBlock label="Output" text={step.output} empty="This step returned nothing." />
          {step.truncated ? (
            <p className="v-chat__detail-note">Longer text was trimmed to fit.</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DetailBlock({
  label,
  text,
  empty,
}: {
  readonly label: string;
  readonly text: string | null;
  readonly empty: string;
}) {
  return (
    <div className="v-chat__detail-block">
      <h4 className="v-chat__detail-label">{label}</h4>
      {text === null ? (
        <p className="v-chat__detail-empty">{empty}</p>
      ) : (
        <pre className="v-chat__detail-text">{text}</pre>
      )}
    </div>
  );
}
