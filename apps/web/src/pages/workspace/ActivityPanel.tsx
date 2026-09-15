import type { ActivityEntryView } from './message-model';

export interface ActivityPanelProps {
  /** Agent activity entries (empty until live runs exist). */
  agentEntries: readonly ActivityEntryView[];
  /** Tool activity entries (empty until live runs exist). */
  toolEntries: readonly ActivityEntryView[];
}

const STATUS_DOT: Record<ActivityEntryView['status'], string> = {
  queued: 'v-activity__dot v-activity__dot--queued',
  running: 'v-activity__dot v-activity__dot--running',
  'awaiting-confirmation': 'v-activity__dot v-activity__dot--awaiting',
  completed: 'v-activity__dot v-activity__dot--completed',
  failed: 'v-activity__dot v-activity__dot--failed',
  denied: 'v-activity__dot v-activity__dot--cancelled',
  expired: 'v-activity__dot v-activity__dot--failed',
  cancelled: 'v-activity__dot v-activity__dot--cancelled',
};

const STATUS_LABEL: Record<ActivityEntryView['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  'awaiting-confirmation': 'Waiting for confirmation',
  completed: 'Completed',
  failed: 'Failed',
  denied: 'Not executed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const RISK_LABEL: Record<NonNullable<ActivityEntryView['riskLevel']>, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

function ActivityList({ entries }: { entries: readonly ActivityEntryView[] }) {
  if (entries.length === 0) {
    return (
      <p className="v-activity__empty">
        Nothing yet. When Veltravia works on this project, each planning step, tool call, and
        validation shows up here as it happens.
      </p>
    );
  }
  return (
    <ul className="v-activity__list" role="list">
      {entries.map((entry) => (
        <li className="v-activity__item" key={entry.id}>
          <span className={STATUS_DOT[entry.status]} aria-hidden="true" />
          <div className="v-activity__item-body">
            <span className="v-activity__label">
              {entry.label}
              <span className="v-activity__status">{STATUS_LABEL[entry.status]}</span>
            </span>
            {entry.detail !== undefined && (
              <span className="v-activity__detail">{entry.detail}</span>
            )}
            {(entry.riskLevel !== undefined || entry.confirmationRequired === true) && (
              <span className="v-activity__badges">
                {entry.riskLevel !== undefined && (
                  <span className="v-activity__risk">{RISK_LABEL[entry.riskLevel]}</span>
                )}
                {entry.confirmationRequired === true && (
                  <span className="v-activity__confirm">Needs your confirmation</span>
                )}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Right workspace panel: the live record of what the agent and its tools
 * are doing. In this checkpoint it is an honest empty state — no fake
 * activity is ever rendered.
 */
export function ActivityPanel({ agentEntries, toolEntries }: ActivityPanelProps) {
  return (
    <aside className="v-activity-panel" aria-label="Activity">
      <section className="v-activity-section" aria-labelledby="v-activity-agent-heading">
        <h3 className="v-activity__heading" id="v-activity-agent-heading">
          Agent activity
        </h3>
        <ActivityList entries={agentEntries} />
      </section>
      <section className="v-activity-section" aria-labelledby="v-activity-tool-heading">
        <h3 className="v-activity__heading" id="v-activity-tool-heading">
          Tool activity
        </h3>
        {toolEntries.length === 0 ? (
          <p className="v-activity__empty">
            Tool calls appear here with their name, operation, risk level, and whether they need
            your confirmation.
          </p>
        ) : (
          <ActivityList entries={toolEntries} />
        )}
      </section>
    </aside>
  );
}
