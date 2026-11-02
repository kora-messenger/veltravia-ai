import { useId, useState } from 'react';
import type { AgentActivityEvent } from '@veltravia/shared';
import { Spinner } from '../../components/ui';
import { CommandActivity, DoneMark } from './CommandActivity';
import { countLabel, runHeadline, toRows } from './agentActivity';
import { ChevronIcon } from './chatIcons';
import type { FollowConnection } from './followRun';

/**
 * The live account of what the agent is doing.
 *
 * Rows arrive from the server already ordered and already described; this
 * component decides only how they stack. A group is one row that opens onto its
 * members, and its own mark is the worst of its members, so a group can never
 * wear a tick while something inside it failed.
 *
 * The header is deliberately quiet: a spinner and the current row's words while
 * work is happening, then a plain statement of how the run ended. No percentage,
 * no countdown, nothing this page would have to guess.
 */
export function AgentActivityTimeline({
  activities,
  runStatus,
  connection,
}: {
  readonly activities: readonly AgentActivityEvent[];
  readonly runStatus: string | null;
  readonly connection: FollowConnection;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<readonly string[]>([]);
  const [openRows, setOpenRows] = useState<readonly string[]>([]);
  const listId = useId();

  const rows = toRows(activities);
  const running = runStatus === 'running' || runStatus === null;
  const failed = activities.some((activity) => activity.status === 'failed');
  const headline = runHeadline(activities, runStatus);

  const toggle = (
    setter: (update: (current: readonly string[]) => readonly string[]) => void,
    id: string,
  ): void =>
    setter((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  return (
    <div className={running ? 'v-act is-live' : 'v-act'}>
      <div className="v-act__head">
        <button
          type="button"
          className="v-act__head-button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className="v-act__head-mark" aria-hidden="true">
            {running ? (
              <Spinner size="sm" aria-label="Still working" />
            ) : (
              <DoneMark failed={failed} />
            )}
          </span>
          <span className="v-act__head-label">{headline}</span>
          <span className="v-act__head-count">{countLabel(activities.length)}</span>
          <span
            className={collapsed ? 'v-act__chevron' : 'v-act__chevron is-open'}
            aria-hidden="true"
          >
            <ChevronIcon size={14} />
          </span>
        </button>
        {connection === 'reconnecting' || connection === 'offline' ? (
          <p className="v-act__connection" role="status">
            {connection === 'offline'
              ? 'You are offline. The run continues on the server and this will catch up.'
              : 'Reconnecting to the run. Nothing was restarted.'}
          </p>
        ) : null}
      </div>

      {collapsed ? null : (
        <ol className="v-act__rows" id={listId}>
          {rows.map(({ parent, children }) => {
            if (children.length === 0) {
              return (
                <CommandActivity
                  key={parent.activityId}
                  activity={parent}
                  open={openRows.includes(parent.activityId)}
                  onToggle={() => toggle(setOpenRows, parent.activityId)}
                />
              );
            }
            const groupOpen = openGroups.includes(parent.activityId);
            return (
              <li key={parent.activityId} className="v-act__group">
                <button
                  type="button"
                  className="v-act__button"
                  aria-expanded={groupOpen}
                  onClick={() => toggle(setOpenGroups, parent.activityId)}
                >
                  <span className="v-act__mark" aria-hidden="true">
                    {parent.status === 'failed' ? (
                      <DoneMark failed />
                    ) : parent.status === 'running' ? (
                      <Spinner size="sm" aria-label={`${parent.title}: working`} />
                    ) : (
                      <DoneMark failed={false} />
                    )}
                  </span>
                  <span className="v-act__title">{parent.title}</span>
                  <span className="v-act__time">{children.length}</span>
                  <span
                    className={groupOpen ? 'v-act__chevron is-open' : 'v-act__chevron'}
                    aria-hidden="true"
                  >
                    <ChevronIcon size={14} />
                  </span>
                </button>
                {groupOpen ? (
                  <ol className="v-act__rows v-act__rows--nested">
                    {children.map((child) => (
                      <CommandActivity
                        key={child.activityId}
                        activity={child}
                        nested
                        open={openRows.includes(child.activityId)}
                        onToggle={() => toggle(setOpenRows, child.activityId)}
                      />
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
