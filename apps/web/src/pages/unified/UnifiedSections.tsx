import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/client';
import * as codingApi from '../../api/coding';
import * as sourceApi from '../../api/source';
import * as unifiedApi from '../../api/unified';
import { navigateToHash } from '../../shell/useHashRoute';

/**
 * Sections of the unified application workspace (Step 34).
 *
 * Every section renders what the server measured and nothing else. Where a
 * layer has not been inspected, the section says so rather than showing an
 * empty box that reads like "nothing is wrong".
 */

const STATUS_TONE: Record<unifiedApi.UnifiedStatus, 'neutral' | 'info' | 'success' | 'warning'> = {
  detected: 'info',
  configured: 'info',
  tested: 'success',
  running: 'success',
  unavailable: 'warning',
  'not-configured': 'neutral',
};

export function SectionHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <header className="v-uapp__heading">
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

export function HealthPanel({ health }: { readonly health: unifiedApi.AppHealth }) {
  const facts: readonly { key: string; label: string; fact: unifiedApi.StatusFact }[] = [
    { key: 'frontend', label: 'Frontend', fact: health.frontend },
    { key: 'backend', label: 'Backend', fact: health.backend },
    { key: 'api-routes', label: 'API routes', fact: health.apiRoutes },
    { key: 'database', label: 'Database', fact: health.database },
    { key: 'tests', label: 'Tests', fact: health.tests },
    { key: 'runtime', label: 'Runtime', fact: health.runtime },
  ];
  return (
    <section className="v-uapp__panel" aria-labelledby="v-uapp-health-title">
      <h3 id="v-uapp-health-title">Application health</h3>
      <p className="v-uapp__muted">
        Configured, detected, tested and running are different things.{' '}
        {health.inspectedCompletely
          ? 'Every file was inspected.'
          : 'Part of the tree was not read, so this picture is partial.'}
      </p>
      <ul className="v-uapp__health">
        {facts.map((entry) => (
          <li key={entry.key} className="v-uapp__health-item">
            <div className="v-uapp__health-top">
              <span className="v-uapp__health-label">{entry.label}</span>
              <Badge tone={STATUS_TONE[entry.fact.status]}>{entry.fact.label}</Badge>
            </div>
            <p className="v-uapp__health-detail">{entry.fact.detail}</p>
            {entry.fact.evidence.length > 0 ? (
              <p className="v-uapp__evidence">{entry.fact.evidence.join(' · ')}</p>
            ) : null}
          </li>
        ))}
      </ul>
      {health.warnings.length > 0 ? (
        <div className="v-uapp__notices">
          <h4>Warnings</h4>
          <ul>
            {health.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {health.errors.length > 0 ? (
        <div className="v-uapp__notices v-uapp__notices--error">
          <h4>Detected errors</h4>
          <ul>
            {health.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function OverviewSection({
  view,
  onOpenSection,
}: {
  readonly view: unifiedApi.UnifiedAppView;
  readonly onOpenSection: (section: string) => void;
}) {
  const { overview } = view;
  const stackKnown = overview.stack.source === 'detected';
  const facts: readonly { label: string; value: string }[] = [
    { label: 'Project type', value: overview.project.projectType || 'Not set' },
    { label: 'Status', value: overview.project.status },
    {
      label: 'Framework',
      value: stackKnown ? (overview.stack.framework ?? 'Not identified') : 'Unknown',
    },
    {
      label: 'Language',
      value: stackKnown ? (overview.stack.language ?? 'Not identified') : 'Unknown',
    },
    { label: 'Workspace', value: view.workspace?.id ?? 'No workspace' },
    { label: 'Revision', value: view.workspace === null ? '—' : String(view.workspace.revision) },
    { label: 'Files', value: String(overview.counts.files) },
    { label: 'API routes', value: String(overview.counts.apiRoutes) },
    { label: 'Data models', value: String(overview.counts.models) },
    { label: 'Last updated', value: overview.lastUpdated ?? 'Unknown' },
  ];

  return (
    <>
      <SectionHeading
        title={overview.project.name}
        description={
          overview.project.description.length > 0
            ? overview.project.description
            : 'This project has no description yet.'
        }
      />
      <dl className="v-uapp__facts">
        {facts.map((fact) => (
          <div key={fact.label} className="v-uapp__fact">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {overview.notes.length > 0 ? (
        <section className="v-uapp__panel">
          <h3>What we could not establish</h3>
          <ul className="v-uapp__notices-list">
            {overview.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <HealthPanel health={view.health} />

      <section className="v-uapp__panel">
        <h3>Recent changes</h3>
        {overview.recentChanges.length === 0 ? (
          <p className="v-uapp__muted">
            No changes have been recorded for this workspace yet. Changes appear here when a file is
            written through the source API or by an approved agent run.
          </p>
        ) : (
          <ul className="v-uapp__changes">
            {overview.recentChanges.map((change) => (
              <li key={`${change.path}-${change.at}`}>
                <span className="v-uapp__mono">{change.path}</span>
                <span className="v-uapp__muted">
                  {change.action} · {change.at}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="v-uapp__panel">
        <h3>Where to go next</h3>
        <div className="v-uapp__actions">
          <Button variant="secondary" onClick={() => onOpenSection('files')}>
            Browse files
          </Button>
          <Button variant="secondary" onClick={() => onOpenSection('api-routes')}>
            Inspect API routes
          </Button>
          <Button variant="secondary" onClick={() => onOpenSection('build')}>
            Plan a change
          </Button>
        </div>
      </section>
    </>
  );
}

export function LayerSection({
  view,
  layer,
}: {
  readonly view: unifiedApi.UnifiedAppView;
  readonly layer: 'frontend' | 'backend';
}) {
  const isFrontend = layer === 'frontend';
  const group = view.files.groups.find((entry) => entry.group === layer);
  const health = isFrontend ? view.health.frontend : view.health.backend;
  const target = isFrontend
    ? `#/projects/${view.project.id}/builder`
    : `#/projects/${view.project.id}/backend`;

  return (
    <>
      <SectionHeading
        title={isFrontend ? 'Frontend' : 'Backend'}
        description={
          isFrontend
            ? 'The frontend builder, with the same project, workspace and files.'
            : 'The backend builder, with the same project, workspace and files.'
        }
      />
      <section className="v-uapp__panel">
        <div className="v-uapp__facts v-uapp__facts--inline">
          <div className="v-uapp__fact">
            <dt>{isFrontend ? 'Frontend files' : 'Backend files'}</dt>
            <dd>{group?.count ?? 0}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Status</dt>
            <dd>{health.label}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>API routes</dt>
            <dd>{view.overview.counts.apiRoutes}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Models</dt>
            <dd>{view.overview.counts.models}</dd>
          </div>
        </div>
        <p className="v-uapp__muted">{health.detail}</p>
        <div className="v-uapp__actions">
          <Button onClick={() => navigateToHash(target)}>
            {isFrontend ? 'Open the frontend builder' : 'Open the backend builder'}
          </Button>
        </div>
        <p className="v-uapp__muted">
          Both builders work on this project and this workspace. Nothing is copied between them.
        </p>
      </section>
    </>
  );
}

export function DatabaseSection({ view }: { readonly view: unifiedApi.UnifiedAppView }) {
  return (
    <>
      <SectionHeading
        title="Database"
        description="What the project declares about its data. No connection is opened in this release."
      />
      <section className="v-uapp__panel">
        <div className="v-uapp__health-top">
          <span className="v-uapp__health-label">Configuration</span>
          <Badge tone={STATUS_TONE[view.health.database.status]}>
            {view.health.database.label}
          </Badge>
        </div>
        <p className="v-uapp__health-detail">{view.health.database.detail}</p>
        {view.health.database.evidence.length > 0 ? (
          <p className="v-uapp__evidence">{view.health.database.evidence.join(' · ')}</p>
        ) : null}
        <p className="v-uapp__muted">
          {view.overview.counts.models === 0
            ? 'No model was recognised in the files that were read.'
            : `${view.overview.counts.models} model(s) recognised. Their fields and relations are listed in the backend builder's database section.`}
        </p>
        <div className="v-uapp__actions">
          <Button
            variant="secondary"
            onClick={() => navigateToHash(`#/projects/${view.project.id}/backend`)}
          >
            Open the backend builder
          </Button>
        </div>
      </section>
    </>
  );
}

const REASON_WORDS: Record<unifiedApi.UnmatchedRequest['reason'], string> = {
  'no-matching-route': 'no route serves this path',
  'method-mismatch': 'a route has this path but a different method',
  'external-host': 'external host, not part of this project',
  'dynamic-url': 'the URL is built at runtime',
};

export function ApiRoutesSection({
  view,
  onSelectFile,
}: {
  readonly view: unifiedApi.UnifiedAppView;
  readonly onSelectFile: (path: string) => void;
}) {
  const requestLinks = view.links.links.filter((link) => link.kind === 'frontend-request');
  const modelLinks = view.links.links.filter((link) => link.kind === 'handler-model');
  const callersOf = (path: string, method: string): number =>
    requestLinks.filter((link) => link.path === path && link.method === method).length;

  return (
    <>
      <SectionHeading
        title="API routes"
        description="Declarations read from the project's own files, with the callers found in the same workspace."
      />
      {view.overview.counts.apiRoutes === 0 ? (
        <EmptyState
          title="No routes recognised"
          description="No route declaration was found in the files that were read. This is not a statement that the project has no API."
        />
      ) : (
        <section className="v-uapp__panel">
          <h3>Declared routes</h3>
          <ul className="v-uapp__routes">
            {view.links.links
              .filter((link) => link.kind === 'route-handler')
              .map((link) => {
                const callers = callersOf(link.path ?? '', link.method ?? '');
                return (
                  <li
                    key={`${link.method}-${link.path}-${link.from.file}`}
                    className="v-uapp__route"
                  >
                    <div className="v-uapp__route-head">
                      <Badge tone="info">{link.method}</Badge>
                      <span className="v-uapp__mono">{link.path}</span>
                      {link.from.file === '' ? null : (
                        <button
                          type="button"
                          className="v-uapp__link"
                          onClick={() => onSelectFile(link.from.file)}
                        >
                          {link.from.file}:{link.from.line ?? 1}
                        </button>
                      )}
                    </div>
                    <p className="v-uapp__muted">
                      Handler {link.to.label} ·{' '}
                      {callers === 0
                        ? 'no caller found in this workspace'
                        : `${callers} caller(s) found`}
                    </p>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      <section className="v-uapp__panel">
        <h3>Cross-layer connections</h3>
        <p className="v-uapp__muted">{view.links.note}</p>
        <div className="v-uapp__facts v-uapp__facts--inline">
          <div className="v-uapp__fact">
            <dt>Request sites</dt>
            <dd>{view.links.requests}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Matched</dt>
            <dd>{requestLinks.length}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Unmatched</dt>
            <dd>{view.links.unmatchedRequests.length}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Routes without a caller</dt>
            <dd>{view.links.routesWithoutCaller.length}</dd>
          </div>
        </div>
        {view.links.unmatchedRequests.length === 0 ? (
          <p className="v-uapp__muted">
            Every request site read in this workspace matches a declared route.
          </p>
        ) : (
          <ul className="v-uapp__routes">
            {view.links.unmatchedRequests.map((request) => (
              <li key={`${request.file}-${request.line}`} className="v-uapp__route">
                <div className="v-uapp__route-head">
                  <Badge tone="warning">Unmatched</Badge>
                  <span className="v-uapp__mono">
                    {request.method === null ? '' : `${request.method} `}
                    {request.url}
                  </span>
                  <button
                    type="button"
                    className="v-uapp__link"
                    onClick={() => onSelectFile(request.file)}
                  >
                    {request.file}:{request.line}
                  </button>
                </div>
                <p className="v-uapp__muted">{REASON_WORDS[request.reason]}</p>
              </li>
            ))}
          </ul>
        )}
        {modelLinks.length > 0 ? (
          <>
            <h4>Handlers that use a model</h4>
            <ul className="v-uapp__routes">
              {modelLinks.map((link) => (
                <li
                  key={`${link.from.file}-${link.to.label}-${link.method ?? ''}-${link.path ?? ''}`}
                  className="v-uapp__route"
                >
                  <div className="v-uapp__route-head">
                    <Badge tone="info">Data</Badge>
                    <span className="v-uapp__mono">{link.to.label}</span>
                    <button
                      type="button"
                      className="v-uapp__link"
                      onClick={() => onSelectFile(link.to.file)}
                    >
                      {link.to.file}:{link.to.line ?? 1}
                    </button>
                  </div>
                  <p className="v-uapp__muted">{link.from.label} references this model</p>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </>
  );
}

export function FilesSection({
  view,
  selectedPath,
  onSelect,
}: {
  readonly view: unifiedApi.UnifiedAppView;
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const [file, setFile] = useState<sourceApi.SourceFileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedPath === null) {
      setFile(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const content = await sourceApi.fetchFile(view.project.id, selectedPath);
        if (!cancelled) setFile(content);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPath, view.project.id]);

  return (
    <>
      <SectionHeading
        title="Files"
        description="Every file in the workspace, grouped for reading. Paths are the project's own; nothing is moved or renamed."
      />
      {view.files.groups.length === 0 ? (
        <EmptyState
          title="No files yet"
          description="This workspace is empty. Files appear here as soon as the project has any."
        />
      ) : (
        <div className="v-uapp__files">
          <div className="v-uapp__groups">
            {view.files.groups.map((group) => (
              <details key={group.group} className="v-uapp__group" open={group.group !== 'other'}>
                <summary>
                  {group.label} <span className="v-uapp__muted">{group.count}</span>
                </summary>
                <ul>
                  {group.files.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="v-uapp__file"
                        aria-pressed={selectedPath === entry.path}
                        onClick={() => onSelect(entry.path)}
                      >
                        {entry.path}
                      </button>
                    </li>
                  ))}
                </ul>
                {group.omitted > 0 ? (
                  <p className="v-uapp__muted">{group.omitted} more file(s) not listed.</p>
                ) : null}
              </details>
            ))}
          </div>
          <div className="v-uapp__viewer">
            {selectedPath === null ? (
              <p className="v-uapp__muted">Select a file to read it. Content is shown read-only.</p>
            ) : loading ? (
              <Spinner size="md" aria-label="Reading file" />
            ) : error.length > 0 ? (
              <p className="v-uapp__error">{error}</p>
            ) : file === null ? null : (
              <>
                <div className="v-uapp__viewer-head">
                  <span className="v-uapp__mono">{file.path}</span>
                  <span className="v-uapp__muted">
                    revision {file.revision} · {file.size} bytes
                    {file.truncated ? ' · truncated' : ''}
                  </span>
                </div>
                <pre className="v-uapp__code">{file.content}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function ChangeReview({
  projectId,
  run,
  onApprove,
  onReject,
  decisionsPending,
}: {
  readonly projectId: string;
  readonly run: codingApi.CodingRunView | null;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly decisionsPending: boolean;
}) {
  const plan = run?.plan ?? null;
  const paths = useMemo(() => {
    if (plan === null) return [] as string[];
    return [...new Set([...plan.filesToModify, ...plan.filesToInspect])];
  }, [plan]);
  const [groups, setGroups] = useState<Readonly<Record<string, unifiedApi.FileGroup>>>({});
  const [groupError, setGroupError] = useState('');

  useEffect(() => {
    if (paths.length === 0) {
      setGroups({});
      return;
    }
    let cancelled = false;
    setGroupError('');
    void (async () => {
      try {
        const result = await unifiedApi.groupPaths(projectId, paths);
        if (!cancelled) setGroups(result);
      } catch (error) {
        if (!cancelled) setGroupError(errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paths, projectId]);

  if (plan === null) {
    return (
      <section className="v-uapp__panel">
        <h3>Change review</h3>
        <p className="v-uapp__muted">
          No plan is waiting. Describe a change and the agent will draft one here before anything is
          written.
        </p>
      </section>
    );
  }

  const byGroup = (group: unifiedApi.FileGroup): string[] =>
    paths.filter((path) => (groups[path] ?? 'other') === group);

  const layers: readonly { group: unifiedApi.FileGroup; label: string }[] = [
    { group: 'frontend', label: 'Frontend' },
    { group: 'backend', label: 'Backend' },
    { group: 'shared', label: 'Shared' },
    { group: 'configuration', label: 'Configuration' },
    { group: 'tests', label: 'Tests' },
    { group: 'assets', label: 'Assets' },
    { group: 'other', label: 'Other' },
  ];

  const awaiting = run?.state === 'awaiting_approval';

  return (
    <section className="v-uapp__panel" aria-labelledby="v-uapp-review-title">
      <h3 id="v-uapp-review-title">Change review</h3>
      <p className="v-uapp__muted">
        Run {run?.runId ?? ''} · state {(run?.state ?? 'unknown').replace(/_/g, ' ')} · workspace{' '}
        {run?.workspaceId ?? '—'}
      </p>
      {plan.goal.length > 0 ? <p>{plan.goal}</p> : null}

      <div className="v-uapp__review">
        {layers.map((layer) => {
          const files = byGroup(layer.group);
          if (files.length === 0) return null;
          return (
            <div key={layer.group} className="v-uapp__review-layer">
              <h4>
                {layer.label} <span className="v-uapp__muted">{files.length}</span>
              </h4>
              <ul>
                {files.map((path) => (
                  <li key={path} className="v-uapp__mono">
                    {path}
                    {plan.filesToModify.includes(path) ? (
                      <span className="v-uapp__muted"> · will be modified</span>
                    ) : (
                      <span className="v-uapp__muted"> · will be inspected</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {groupError.length > 0 ? <p className="v-uapp__error">{groupError}</p> : null}

      {plan.steps.length > 0 ? (
        <>
          <h4>Steps</h4>
          <ol className="v-uapp__steps">
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      ) : null}

      {awaiting ? (
        <div className="v-uapp__actions">
          <Button onClick={onApprove} loading={decisionsPending}>
            Approve plan
          </Button>
          <Button variant="secondary" onClick={onReject} disabled={decisionsPending}>
            Reject plan
          </Button>
        </div>
      ) : (
        <p className="v-uapp__muted">
          Nothing is written until a plan is approved. Approval only covers the files listed here.
        </p>
      )}
    </section>
  );
}

export function SettingsSection({ view }: { readonly view: unifiedApi.UnifiedAppView }) {
  return (
    <>
      <SectionHeading
        title="Project settings"
        description="Read-only view of the project this workspace is bound to."
      />
      <section className="v-uapp__panel">
        <dl className="v-uapp__facts">
          <div className="v-uapp__fact">
            <dt>Project id</dt>
            <dd className="v-uapp__mono">{view.project.id}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Workspace</dt>
            <dd className="v-uapp__mono">{view.workspace?.id ?? 'none'}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Root revision</dt>
            <dd>{view.source.rootRevision}</dd>
          </div>
          <div className="v-uapp__fact">
            <dt>Files</dt>
            <dd>
              {view.source.files} files · {view.source.directories} directories
            </dd>
          </div>
        </dl>
        <p className="v-uapp__muted">
          Renaming, archiving and workspace creation live on the project page, where revision
          conflicts are handled.
        </p>
        <div className="v-uapp__actions">
          <Button
            variant="secondary"
            onClick={() => navigateToHash(`#/projects/${view.project.id}`)}
          >
            Open project details
          </Button>
        </div>
      </section>
    </>
  );
}
