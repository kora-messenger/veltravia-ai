import { useState } from 'react';

import { Badge, Button, EmptyState, ErrorState, Input, Select, Spinner } from '../../components/ui';
import type { SyncRepositoryView, SyncConflict, SyncPlan } from '../../api/sync';
import { useSync, type UseSyncDeps } from './useSync';
import {
  connectionBadge,
  describeChange,
  describeConflict,
  describeSkip,
  historyLine,
  pagePhase,
  planSummary,
  repositoryLabel,
  whenText,
} from './view-model';
import './sync.css';

/**
 * GitHub sync for a project.
 *
 * The order on the page is the order of the work: connect a repository, compare
 * both sides, settle anything that changed on both sides, approve what touches
 * GitHub, then apply. Nothing here publishes anything by itself, and every
 * button in this file waits for an answer from the server before it says
 * anything happened.
 *
 * GitHub is optional. A project can be created, edited, tested and exported
 * without ever visiting this page, and this page says so.
 */

interface SyncPageProps extends UseSyncDeps {
  readonly projectId: string | null;
}

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'error'> = {
  neutral: 'neutral',
  positive: 'success',
  caution: 'warning',
  negative: 'error',
};

export function SyncPage({ projectId, api, isOffline }: SyncPageProps) {
  const state = useSync(projectId, {
    ...(api === undefined ? {} : { api }),
    ...(isOffline === undefined ? {} : { isOffline }),
  });
  const [owner, setOwner] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');

  if (state.loading) {
    return (
      <div className="v-sync v-sync--loading" data-testid="sync-page">
        <p className="v-sync__note" role="status">
          <Spinner size="sm" aria-label="Checking GitHub connection" /> Checking the connection…
        </p>
      </div>
    );
  }

  if (state.offline) {
    return (
      <div className="v-sync" data-testid="sync-page">
        <ErrorState
          title="You are offline"
          description="GitHub sync needs a connection. Nothing was changed."
          retry={{ label: 'Try again', onClick: () => void state.reload() }}
        />
      </div>
    );
  }

  if (state.loadError !== '' || state.status === null) {
    return (
      <div className="v-sync" data-testid="sync-page">
        <ErrorState
          title="The connection could not be checked"
          description={state.loadError === '' ? 'No status came back.' : state.loadError}
          retry={{ label: 'Try again', onClick: () => void state.reload() }}
        />
      </div>
    );
  }

  const status = state.status;
  const badge = connectionBadge(status);
  const phase = pagePhase({
    loading: false,
    offline: false,
    error: null,
    status,
    planning: state.planning,
    plan: state.plan,
  });
  const connection = status.connection;
  const chosen = state.repositories.find((r) => repositoryLabel(r.owner, r.name) === repository) as
    SyncRepositoryView | undefined;

  return (
    <div className="v-sync" data-testid="sync-page">
      <header className="v-sync__header">
        <div className="v-sync__identity">
          <h1 className="v-sync__title">GitHub sync</h1>
          <p className="v-sync__subtitle">
            Push this project to a repository you already have, or bring its changes back. GitHub is
            optional: everything else works without it.
          </p>
        </div>
        <div className="v-sync__state">
          <Badge tone={TONE[badge.tone] ?? 'neutral'} dot>
            {badge.label}
          </Badge>
          {connection === null ? null : (
            <span className="v-sync__where">
              {repositoryLabel(connection.owner, connection.repository)} · {connection.branch}
            </span>
          )}
        </div>
      </header>

      {state.error === '' ? null : (
        <p className="v-sync__error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice === '' ? null : (
        <p className="v-sync__notice" role="status">
          {state.notice}
        </p>
      )}

      {phase === 'disconnected' ? (
        <section className="v-sync__panel" aria-labelledby="sync-connect-heading">
          <h2 className="v-sync__heading" id="sync-connect-heading">
            Connect a repository
          </h2>
          <p className="v-sync__note">
            Choose a repository the connected GitHub account can reach. A new repository cannot be
            created from here.
          </p>
          <div className="v-sync__form">
            <Select
              label="Repository"
              name="repository"
              placeholder={
                state.repositories.length === 0
                  ? 'No repositories available'
                  : 'Choose a repository'
              }
              options={state.repositories.map((r) => ({
                value: repositoryLabel(r.owner, r.name),
                label: `${repositoryLabel(r.owner, r.name)}${r.visibility === 'private' ? ' (private)' : ''}`,
              }))}
              value={repository}
              disabled={state.busy}
              onChange={(event) => {
                const value = event.target.value;
                setRepository(value);
                const match = state.repositories.find(
                  (r) => repositoryLabel(r.owner, r.name) === value,
                );
                if (match !== undefined) {
                  setOwner(match.owner);
                  setBranch(match.defaultBranch);
                }
              }}
            />
            <Input
              label="Owner"
              name="owner"
              value={owner}
              disabled={state.busy}
              onChange={(event) => setOwner(event.target.value)}
            />
            <Input
              label="Branch"
              name="branch"
              value={branch}
              disabled={state.busy}
              placeholder={chosen?.defaultBranch ?? 'main'}
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
          <div className="v-sync__actions">
            <Button
              variant="primary"
              loading={state.busy}
              disabled={owner.trim() === '' || repository === ''}
              onClick={() =>
                void state.connect({
                  owner: owner.trim(),
                  repository: repository.includes('/')
                    ? (repository.split('/')[1] ?? '')
                    : repository,
                  branch: branch.trim() === '' ? (chosen?.defaultBranch ?? 'main') : branch.trim(),
                })
              }
            >
              Connect
            </Button>
          </div>
        </section>
      ) : null}

      {phase === 'disconnected' ? null : (
        <>
          <section className="v-sync__panel" aria-labelledby="sync-compare-heading">
            <div className="v-sync__panel-head">
              <h2 className="v-sync__heading" id="sync-compare-heading">
                Compare
              </h2>
              <div className="v-sync__actions">
                <Button
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => void state.disconnect()}
                >
                  Disconnect
                </Button>
                <Button
                  variant="primary"
                  loading={state.planning}
                  disabled={state.busy && !state.planning}
                  onClick={() => void state.compare()}
                >
                  Compare with GitHub
                </Button>
              </div>
            </div>

            {phase === 'planning' ? (
              <p className="v-sync__note" role="status">
                <Spinner size="sm" aria-label="Comparing files" /> Comparing both sides…
              </p>
            ) : null}

            {phase === 'no-changes' ? (
              <EmptyState
                title="Both sides match"
                description="Nothing to publish and nothing to bring in. The files on GitHub are the ones in this project."
              />
            ) : null}

            {state.plan === null ? (
              phase === 'planning' || phase === 'no-changes' ? null : (
                <p className="v-sync__note">
                  Compare to see what would be published and what would be brought in. Nothing
                  changes until you apply it.
                </p>
              )
            ) : (
              <PlanPanel
                plan={state.plan}
                busy={state.busy}
                onApprove={() => void state.approve()}
                onApply={() => void state.apply()}
                onCancel={() => void state.cancelPlan()}
              />
            )}
          </section>

          {state.plan === null ? null : (
            <ConflictPanel
              plan={state.plan}
              busy={state.busy}
              onResolve={(id, resolution) => void state.resolve(id, resolution)}
            />
          )}
        </>
      )}

      <section className="v-sync__panel" aria-labelledby="sync-history-heading">
        <h2 className="v-sync__heading" id="sync-history-heading">
          History
        </h2>
        <p className="v-sync__note" data-testid="sync-persistence">
          {state.history === null || state.history.persistence === 'memory'
            ? 'This history is kept in memory by the API, so a restart forgets it.'
            : 'This history is kept by the API.'}
        </p>
        {state.history === null || state.history.entries.length === 0 ? (
          <EmptyState
            title="No syncs yet"
            description="Nothing has been synced from this project."
          />
        ) : (
          <ul className="v-sync__history">
            {[...state.history.entries].reverse().map((entry) => (
              <li key={entry.entryId} className="v-sync__history-row">
                <div className="v-sync__history-main">
                  <span className="v-sync__history-when">{whenText(entry.at)}</span>
                  <span className="v-sync__history-line">{historyLine(entry)}</span>
                </div>
                <Badge tone={entry.outcome === 'success' ? 'success' : 'error'}>
                  {entry.outcome === 'success' ? 'Synced' : 'Failed'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlanPanel({
  plan,
  busy,
  onApprove,
  onApply,
  onCancel,
}: {
  plan: SyncPlan;
  busy: boolean;
  onApprove(): void;
  onApply(): void;
  onCancel(): void;
}) {
  const summary = planSummary(plan);
  return (
    <div className="v-sync__plan" data-testid="sync-plan">
      <div className="v-sync__plan-head">
        <p className="v-sync__plan-headline">{summary.headline}</p>
        <p className="v-sync__plan-meta">
          {summary.unchanged} unchanged · {summary.skipped} left out ·{' '}
          {repositoryLabel(plan.owner, plan.repository)} @ {plan.branch}
        </p>
      </div>

      {summary.blockers.length > 0 ? (
        <ul className="v-sync__blockers" data-testid="sync-blockers">
          {summary.blockers.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="v-sync__columns">
        <section aria-labelledby="sync-push-heading">
          <h3 className="v-sync__subheading" id="sync-push-heading">
            To publish ({summary.pushed})
          </h3>
          {plan.push.length === 0 ? (
            <p className="v-sync__note">Nothing to publish.</p>
          ) : (
            <ul className="v-sync__changes">
              {plan.push.map((change) => (
                <li key={`${change.kind}:${change.path}`} className="v-sync__change">
                  {describeChange(change)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="sync-pull-heading">
          <h3 className="v-sync__subheading" id="sync-pull-heading">
            To bring in ({summary.pulled})
          </h3>
          {plan.pull.length === 0 ? (
            <p className="v-sync__note">Nothing to bring in.</p>
          ) : (
            <ul className="v-sync__changes">
              {plan.pull.map((change) => (
                <li key={`${change.kind}:${change.path}`} className="v-sync__change">
                  {describeChange(change)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {plan.skipped.length === 0 ? null : (
        <section aria-labelledby="sync-skipped-heading">
          <h3 className="v-sync__subheading" id="sync-skipped-heading">
            Left out ({plan.skipped.length})
          </h3>
          <ul className="v-sync__changes">
            {plan.skipped.map((file) => (
              <li
                key={`${file.side}:${file.path}`}
                className="v-sync__change v-sync__change--muted"
              >
                {describeSkip(file)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="v-sync__actions">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Discard comparison
        </Button>
        {summary.needsApproval ? (
          <Button variant="secondary" loading={busy} onClick={onApprove}>
            Approve this sync
          </Button>
        ) : null}
        <Button variant="primary" disabled={busy || !summary.canApply} onClick={onApply}>
          Apply sync
        </Button>
      </div>
      {summary.canApply ? null : (
        <p className="v-sync__note">Apply stays unavailable until the lines above are settled.</p>
      )}
    </div>
  );
}

function ConflictPanel({
  plan,
  busy,
  onResolve,
}: {
  plan: SyncPlan;
  busy: boolean;
  onResolve(id: string, resolution: 'keep-local' | 'keep-remote'): void;
}) {
  const open = plan.conflicts.filter((c) => c.resolution === null);
  if (plan.conflicts.length === 0) return null;
  return (
    <section className="v-sync__panel" aria-labelledby="sync-conflicts-heading">
      <h2 className="v-sync__heading" id="sync-conflicts-heading">
        Changed on both sides ({open.length} left)
      </h2>
      <ul className="v-sync__conflicts">
        {plan.conflicts.map((conflict: SyncConflict) => (
          <li
            key={conflict.id}
            className="v-sync__conflict"
            data-testid={`conflict-${conflict.id}`}
          >
            <p className="v-sync__conflict-line">{describeConflict(conflict)}</p>
            {conflict.resolution === null ? (
              <div className="v-sync__actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onResolve(conflict.id, 'keep-local')}
                >
                  Keep this project&apos;s version
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onResolve(conflict.id, 'keep-remote')}
                >
                  Keep GitHub&apos;s version
                </Button>
              </div>
            ) : (
              <p className="v-sync__note">
                {conflict.resolution === 'keep-local'
                  ? 'Keeping this project’s version.'
                  : conflict.resolution === 'keep-remote'
                    ? 'Keeping GitHub’s version.'
                    : 'Merged by hand.'}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
