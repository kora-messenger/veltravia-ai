import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, ErrorState, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/client';
import * as codingApi from '../../api/coding';
import * as sourceApi from '../../api/source';
import * as unifiedApi from '../../api/unified';
import { BuilderChatPanel, type ChatMessage } from '../builder/BuilderChatPanel';
import { useCodingRun } from '../builder/useCodingRun';
import {
  ApiRoutesSection,
  ChangeReview,
  DatabaseSection,
  FilesSection,
  LayerSection,
  OverviewSection,
  SectionHeading,
  SettingsSection,
} from './UnifiedSections';
import './unified.css';

/**
 * Unified application workspace (Step 34).
 *
 * One project is one application, so this page is a single shell over systems
 * that already exist: the same project, the same workspace, the same files, the
 * same coding agent and the same approvals. Frontend and backend are sections
 * here and pages of their own; the project context survives the move because it
 * lives in the URL and in the shared source layer, not in a copy.
 */

interface UnifiedAppPageProps {
  readonly projectId: string | null;
}

interface SectionDef {
  readonly id: string;
  readonly label: string;
  readonly group: 'structure' | 'work';
}

const SECTIONS: readonly SectionDef[] = [
  { id: 'overview', label: 'Overview', group: 'structure' },
  { id: 'build', label: 'Build', group: 'work' },
  { id: 'frontend', label: 'Frontend', group: 'structure' },
  { id: 'backend', label: 'Backend', group: 'structure' },
  { id: 'database', label: 'Database', group: 'structure' },
  { id: 'api-routes', label: 'API routes', group: 'structure' },
  { id: 'files', label: 'Files', group: 'structure' },
  { id: 'ai-assistant', label: 'AI assistant', group: 'work' },
  { id: 'settings', label: 'Project settings', group: 'structure' },
];

const SUGGESTIONS: readonly string[] = [
  'Build a page that lists the users',
  'Add an endpoint that returns invoices',
  'Connect the sign-up form to the API',
  'Add a data model for invoices',
  'Explain how the frontend and backend fit together',
];

function nextMessageId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function UnifiedAppPage({ projectId }: UnifiedAppPageProps) {
  const [view, setView] = useState<unifiedApi.UnifiedAppView | null>(null);
  const [capabilities, setCapabilities] = useState<unifiedApi.UnifiedCapabilities | null>(null);
  const [codingCaps, setCodingCaps] = useState<codingApi.CodingCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = useState<string>('overview');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [history, setHistory] = useState<readonly sourceApi.FileHistoryEntry[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  const { run, busy, error: runError, decisionsPending, start, decide, cancel } = useCodingRun();

  const load = useCallback(async () => {
    if (projectId === null) {
      setError('No project was selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [nextView, nextCaps, nextCoding] = await Promise.all([
        unifiedApi.fetchUnifiedApp(projectId),
        unifiedApi.fetchUnifiedCapabilities().catch(() => null),
        codingApi.fetchCodingCapabilities().catch(() => null),
      ]);
      setView(nextView);
      setCapabilities(nextCaps);
      setCodingCaps(nextCoding);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await sourceApi.fetchHistory(projectId, 10).catch(() => []);
        if (!cancelled) setHistory(entries);
      } catch {
        if (!cancelled) setHistory([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshToken]);

  const workspaceId = view?.workspace?.id ?? null;

  const send = useCallback(
    async (requirement: string) => {
      if (projectId === null || workspaceId === null) return;
      const text = requirement.trim();
      if (text.length === 0) return;
      setMessages((current) => [...current, { id: nextMessageId('user'), role: 'user', text }]);
      const ok = await start({ projectId, workspaceId, userRequirement: text });
      if (!ok) {
        setMessages((current) => [
          ...current,
          {
            id: nextMessageId('system'),
            role: 'system',
            text: 'The request could not be started. Nothing was written.',
          },
        ]);
      }
    },
    [projectId, workspaceId, start],
  );

  // The run's own output becomes the conversation: the panel never invents a
  // reply, and a finished run refreshes the workspace so the counts match.
  useEffect(() => {
    if (run === null) return;
    const detail: string[] = [];
    if (run.summary !== null && run.summary.length > 0) detail.push(run.summary);
    if (run.changedFiles.length > 0)
      detail.push(...run.changedFiles.map((path) => `changed: ${path}`));
    setMessages((current) => {
      const existingIndex = current.findIndex((message) => message.id === `run-${run.runId}`);
      const message: ChatMessage = {
        id: `run-${run.runId}`,
        role: 'assistant',
        text: `Run ${run.runId} is ${run.state.replace(/_/g, ' ')}.`,
        detail,
      };
      if (existingIndex === -1) return [...current, message];
      const next = [...current];
      next[existingIndex] = message;
      return next;
    });
    if (run.state === 'completed') setRefreshToken((token) => token + 1);
  }, [run]);

  const openFile = useCallback((path: string) => {
    setSelectedPath(path);
    setSection('files');
  }, []);

  const reviewChanges = useCallback(() => setSection('build'), []);

  const activeLabel = useMemo(
    () => SECTIONS.find((entry) => entry.id === section)?.label ?? 'Overview',
    [section],
  );

  if (loading) {
    return (
      <div className="v-uapp v-uapp--state">
        <Spinner size="lg" aria-label="Loading application workspace" />
      </div>
    );
  }

  if (error.length > 0 || view === null) {
    return (
      <div className="v-uapp v-uapp--state">
        <ErrorState
          title="The application workspace could not be loaded"
          description={error.length > 0 ? error : 'This project is unavailable.'}
          retry={{ label: 'Try again', onClick: () => setRefreshToken((token) => token + 1) }}
        />
      </div>
    );
  }

  return (
    <div className="v-uapp">
      <header className="v-uapp__topbar">
        <div>
          <h1>{view.project.name}</h1>
          <p className="v-uapp__muted">
            {view.workspace === null
              ? 'No workspace'
              : `Workspace ${view.workspace.id} · revision ${view.workspace.revision}`}
            {view.project.projectType.length > 0 ? ` · ${view.project.projectType}` : ''}
          </p>
        </div>
        <div className="v-uapp__topbar-actions">
          {codingCaps !== null ? (
            <Badge tone={codingCaps.decisionSource === 'scripted-demo' ? 'warning' : 'info'}>
              {codingCaps.decisionSource === 'scripted-demo'
                ? 'Scripted demo plans'
                : 'Model-backed plans'}
            </Badge>
          ) : null}
          <Button variant="secondary" onClick={() => setRefreshToken((token) => token + 1)}>
            Refresh
          </Button>
        </div>
      </header>

      <nav className="v-uapp__rail" aria-label="Application sections">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`v-uapp__rail-item${entry.id === section ? ' is-active' : ''}`}
            aria-current={entry.id === section ? 'page' : undefined}
            onClick={() => setSection(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="v-uapp__mobile-nav">
        <label className="v-uapp__mobile-label" htmlFor="v-uapp-section">
          Section
        </label>
        <select
          id="v-uapp-section"
          className="v-uapp__select"
          value={section}
          onChange={(event) => setSection(event.target.value)}
          aria-label={`Application section, currently ${activeLabel}`}
        >
          {SECTIONS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <main className="v-uapp__main" aria-live="polite">
        {section === 'overview' ? <OverviewSection view={view} onOpenSection={setSection} /> : null}
        {section === 'build' ? (
          <>
            <SectionHeading
              title="Build"
              description="Describe a change, review the plan as files, then approve. The plan is the agent's own declaration; it is shown here before anything is written."
            />
            <ChangeReview
              projectId={view.project.id}
              run={run}
              decisionsPending={decisionsPending}
              onApprove={() => void decide('approve')}
              onReject={() => void decide('reject')}
            />
            <div className="v-uapp__build">
              <BuilderChatPanel
                run={run}
                busy={busy}
                error={runError}
                decisionsPending={decisionsPending}
                capabilities={codingCaps}
                messages={messages}
                history={history}
                onSend={(requirement) => void send(requirement)}
                onDecide={(decision) => void decide(decision)}
                onCancel={() => void cancel()}
                onReviewChanges={reviewChanges}
                heading="Plan a change"
                emptyTitle="No change requested yet"
                emptyDescription="Describe what you want to build. The agent drafts a plan and waits for approval."
                placeholder="Add an invoices endpoint and a page that lists them"
                submitLabel="Draft a plan"
                suggestions={SUGGESTIONS}
                reviewChangesLabel="Review the plan"
              />
            </div>
          </>
        ) : null}
        {section === 'frontend' ? <LayerSection view={view} layer="frontend" /> : null}
        {section === 'backend' ? <LayerSection view={view} layer="backend" /> : null}
        {section === 'database' ? <DatabaseSection view={view} /> : null}
        {section === 'api-routes' ? <ApiRoutesSection view={view} onSelectFile={openFile} /> : null}
        {section === 'files' ? (
          <FilesSection view={view} selectedPath={selectedPath} onSelect={setSelectedPath} />
        ) : null}
        {section === 'ai-assistant' ? (
          <>
            <SectionHeading
              title="AI assistant"
              description="One conversation with the coding agent for this project. Requests become bounded runs, plans need approval, and nothing runs without the Tool System."
            />
            <div className="v-uapp__build">
              <BuilderChatPanel
                run={run}
                busy={busy}
                error={runError}
                decisionsPending={decisionsPending}
                capabilities={codingCaps}
                messages={messages}
                history={history}
                onSend={(requirement) => void send(requirement)}
                onDecide={(decision) => void decide(decision)}
                onCancel={() => void cancel()}
                onReviewChanges={reviewChanges}
                heading="Assistant"
                emptyTitle="Ask about this application"
                emptyDescription="Ask for a change, an explanation, or a review of the structure."
                placeholder="Find the frontend requests that have no backend route"
                submitLabel="Send"
                suggestions={SUGGESTIONS}
                reviewChangesLabel="Review changes"
              />
            </div>
            {capabilities !== null ? (
              <section className="v-uapp__panel">
                <h3>What this assistant can and cannot do</h3>
                <ul className="v-uapp__notices-list">
                  <li>Runs use the shared coding agent, not a second AI system.</li>
                  <li>Plans require approval; files are written only after it.</li>
                  <li>
                    Decision source:{' '}
                    {codingCaps?.decisionSource === 'scripted-demo'
                      ? 'scripted demonstration plans (no model is being called)'
                      : 'a connected model'}
                    .
                  </li>
                  {capabilities.unavailable.map((item) => (
                    <li key={item}>Not available in this release: {item}.</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
        {section === 'settings' ? <SettingsSection view={view} /> : null}
      </main>
    </div>
  );
}
