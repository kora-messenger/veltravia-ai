import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, Spinner, useToast } from '../../components/ui';
import { errorMessage } from '../../api/client';
import * as backendApi from '../../api/backend';
import * as codingApi from '../../api/coding';
import * as projectsApi from '../../api/projects';
import * as sourceApi from '../../api/source';
import * as workspacesApi from '../../api/workspaces';
import { BuilderChatPanel, type ChatMessage } from '../builder/BuilderChatPanel';
import { useCodingRun } from '../builder/useCodingRun';
import { BackendNav, BackendSectionView } from './BackendSections';

/**
 * Backend Builder workspace (Step 33).
 *
 * Three regions over systems that already exist: the section navigator, the
 * section itself (routes, database, models, functions, auth, environment, logs),
 * and the AI panel, which is the SAME coding agent the frontend builder uses.
 * A run the user approves is the only way anything here changes; the panels
 * themselves are read-only descriptions with their evidence attached.
 */

interface BackendBuilderPageProps {
  readonly projectId: string | null;
}

type MobilePanel = 'sections' | 'workspace' | 'chat';

const BACKEND_SUGGESTIONS: readonly string[] = [
  'Add a health check endpoint',
  'Add validation to the create endpoint',
  'Add a database model for invoices',
  'Add authentication middleware to the write routes',
];

export function BackendBuilderPage({ projectId }: BackendBuilderPageProps) {
  const { toast } = useToast();
  const [project, setProject] = useState<projectsApi.ProjectView | null>(null);
  const [workspace, setWorkspace] = useState<workspacesApi.WorkspaceView | null>(null);
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(true);

  const [report, setReport] = useState<backendApi.BackendReport | null>(null);
  const [capabilities, setCapabilities] = useState<backendApi.BackendCapabilities | null>(null);
  const [codingCaps, setCodingCaps] = useState<codingApi.CodingCapabilities | null>(null);
  const [reportError, setReportError] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const [section, setSection] = useState<backendApi.BackendSection>('overview');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('workspace');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [history, setHistory] = useState<readonly sourceApi.FileHistoryEntry[]>([]);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const { run, busy, error: runError, decisionsPending, start, decide, cancel } = useCodingRun();
  const annotatedRun = useRef<string | null>(null);

  // -- project + workspace -------------------------------------------------
  useEffect(() => {
    if (projectId === null) {
      setContextError('No project was selected.');
      setContextLoading(false);
      return;
    }
    let cancelled = false;
    setContextLoading(true);
    setContextError('');
    void (async () => {
      try {
        const [nextProject, nextWorkspaces] = await Promise.all([
          projectsApi.getProject(projectId),
          workspacesApi.listWorkspaces(projectId),
        ]);
        if (cancelled) return;
        setProject(nextProject);
        const active = nextWorkspaces.find((entry) => entry.status === 'active');
        setWorkspace(active ?? nextWorkspaces[0] ?? null);
      } catch (loadError) {
        if (!cancelled) setContextError(errorMessage(loadError));
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Two different statements: what the backend scan can see, and which decision
  // source the coding agent is running on. Neither is inferred from the other.
  useEffect(() => {
    void backendApi
      .fetchBackendCapabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
    void codingApi
      .fetchCodingCapabilities()
      .then(setCodingCaps)
      .catch(() => setCodingCaps(null));
  }, []);

  const workspaceId = workspace?.id;

  // -- the backend report --------------------------------------------------
  useEffect(() => {
    if (projectId === null || contextLoading) return;
    let cancelled = false;
    setReportLoading(true);
    setReportError('');
    void (async () => {
      try {
        const next = await backendApi.fetchBackendReport(projectId, {
          ...(workspaceId === undefined ? {} : { workspaceId }),
        });
        if (!cancelled) setReport(next);
      } catch (readError) {
        if (!cancelled) {
          setReport(null);
          setReportError(errorMessage(readError));
        }
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contextLoading, projectId, refreshSignal, workspaceId]);

  // Source history feeds the chat's change markers; it is optional.
  useEffect(() => {
    if (projectId === null || workspaceId === undefined) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    void sourceApi
      .fetchHistory(projectId, 20, workspaceId)
      .then((entries) => {
        if (!cancelled) setHistory(entries.slice(0, 20));
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshSignal, workspaceId]);

  const refreshEverything = useCallback(() => {
    setRefreshSignal((value) => value + 1);
  }, []);

  // -- conversation --------------------------------------------------------
  const pushMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const handleSend = useCallback(
    async (requirement: string) => {
      if (projectId === null) return;
      if (workspace === null) {
        pushMessage({
          id: `note-${Date.now()}`,
          role: 'system',
          text: 'This project has no workspace yet, so the agent has nowhere to write. Create a workspace first.',
        });
        return;
      }
      setMessages((current) => [
        ...current,
        { id: `user-${Date.now()}`, role: 'user', text: requirement },
      ]);
      const ok = await start({
        projectId,
        workspaceId: workspace.id,
        userRequirement: requirement,
      });
      if (ok) setMobilePanel('chat');
    },
    [projectId, pushMessage, start, workspace],
  );

  useEffect(() => {
    if (run === null) return;
    if (annotatedRun.current === run.runId) return;
    if (!codingApi.isCodingRunTerminal(run.state)) return;
    annotatedRun.current = run.runId;
    if (run.state === 'completed') {
      pushMessage({
        id: `assistant-${run.runId}`,
        role: 'assistant',
        text: run.summary ?? 'The run finished.',
        detail: run.changedFiles.length > 0 ? run.changedFiles : undefined,
      });
      toast('Run finished. Backend report refreshed.', { tone: 'success' });
      refreshEverything();
    } else if (run.state === 'failed') {
      pushMessage({
        id: `assistant-${run.runId}`,
        role: 'assistant',
        text: `The run stopped: ${run.failure?.message ?? 'an unreported failure'}.`,
      });
      toast('The run failed.', { tone: 'error' });
    } else {
      pushMessage({
        id: `assistant-${run.runId}`,
        role: 'assistant',
        text: 'You cancelled the run. Nothing further was written.',
      });
    }
  }, [pushMessage, refreshEverything, run, toast]);

  const basedOn = useMemo(() => {
    if (report === null) return '';
    const parts = [`${report.scanned.read} files read`];
    if (report.scanned.skipped > 0) parts.push(`${report.scanned.skipped} beyond the read budget`);
    if (report.scanned.truncated) parts.push('some files truncated');
    return parts.join(' · ');
  }, [report]);

  if (contextLoading) {
    return (
      <div className="v-bbuilder v-bbuilder--loading" data-testid="backend-builder">
        <p className="v-bbuilder__note" role="status">
          <Spinner size="sm" aria-label="Loading project" /> Loading project…
        </p>
      </div>
    );
  }

  if (contextError !== '') {
    return (
      <div className="v-bbuilder" data-testid="backend-builder">
        <ErrorState
          title="Could not open this project"
          description={contextError}
          retry={{ label: 'Try again', onClick: () => window.location.reload() }}
        />
      </div>
    );
  }

  if (project === null || projectId === null) {
    return (
      <div className="v-bbuilder" data-testid="backend-builder">
        <ErrorState title="Project not found" description="Pick a project to open its backend." />
      </div>
    );
  }

  return (
    <div className={`v-bbuilder v-bbuilder--panel-${mobilePanel}`} data-testid="backend-builder">
      <header className="v-bbuilder__header">
        <div className="v-bbuilder__identity">
          <h1 className="v-bbuilder__title">{project.name}</h1>
          <div className="v-bbuilder__badges">
            <Badge tone={project.status === 'active' ? 'success' : 'warning'}>
              {project.status}
            </Badge>
            <Badge tone="neutral">{workspace === null ? 'no workspace' : workspace.name}</Badge>
            <Badge tone="info">backend · read-only</Badge>
          </div>
        </div>
        <nav className="v-bbuilder__tabs" aria-label="Backend builder panels">
          {(['sections', 'workspace', 'chat'] as const).map((panel) => (
            <button
              key={panel}
              type="button"
              className={`v-bbuilder__tab${mobilePanel === panel ? ' v-bbuilder__tab--active' : ''}`}
              aria-pressed={mobilePanel === panel}
              onClick={() => setMobilePanel(panel)}
            >
              {panel === 'sections' ? 'Sections' : panel === 'workspace' ? 'Workspace' : 'AI chat'}
            </button>
          ))}
        </nav>
      </header>

      <div className="v-bbuilder__body">
        <aside className="v-bbuilder__region v-bbuilder__region--nav" aria-label="Backend sections">
          <BackendNav
            report={report}
            capabilities={capabilities}
            active={section}
            onSelect={(next) => {
              setSection(next);
              setMobilePanel('workspace');
            }}
          />
        </aside>

        <div className="v-bbuilder__region v-bbuilder__region--main">
          {reportLoading && report === null && (
            <p className="v-bbuilder__note" role="status" data-testid="backend-loading">
              <Spinner size="sm" aria-label="Reading backend files" /> Reading backend files…
            </p>
          )}

          {reportError !== '' && (
            <ErrorState
              title="Could not read the backend"
              description={reportError}
              retry={{ label: 'Try again', onClick: refreshEverything }}
            />
          )}

          {report === null && !reportLoading && reportError === '' && workspace === null && (
            <EmptyState
              title="No workspace yet"
              description="A project needs a workspace before its backend can be described. Create one from the project page."
            />
          )}

          {report !== null && (
            <>
              <p className="v-bbuilder__scan-note" role="note">
                Read from the project's own files: {basedOn}.
              </p>
              {report.warnings.length > 0 && (
                <ul className="v-bbuilder__warnings" aria-label="Reading caveats">
                  {report.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <BackendSectionView section={section} report={report} capabilities={capabilities} />
            </>
          )}
        </div>

        <div className="v-bbuilder__region v-bbuilder__region--chat">
          <BuilderChatPanel
            run={run}
            busy={busy}
            error={runError}
            decisionsPending={decisionsPending}
            capabilities={codingCaps}
            messages={messages}
            history={history}
            onSend={(requirement) => void handleSend(requirement)}
            onDecide={(decision) => void decide(decision)}
            onCancel={() => void cancel()}
            onReviewChanges={refreshEverything}
            heading="AI backend engineer"
            emptyTitle="Ask for a backend change"
            emptyDescription="Requests become a bounded coding run: a plan, your approval, then real file changes in this project."
            placeholder="What should the backend do?"
            submitLabel="Send request"
            suggestions={BACKEND_SUGGESTIONS}
            reviewChangesLabel="Refresh the backend report"
          />
        </div>
      </div>

      {project.status === 'archived' && (
        <p className="v-bbuilder__note" role="note">
          This project is archived. Restore it before asking the agent to change files.
        </p>
      )}

      <div className="v-bbuilder__footer">
        <Button variant="secondary" onClick={refreshEverything} aria-label="Refresh backend report">
          Refresh report
        </Button>
      </div>
    </div>
  );
}
