import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, ErrorState, Spinner, useToast } from '../../components/ui';
import { errorMessage } from '../../api/client';
import * as codingApi from '../../api/coding';
import * as projectsApi from '../../api/projects';
import * as sourceApi from '../../api/source';
import * as workspacesApi from '../../api/workspaces';
import { SourceExplorer } from '../source/SourceExplorer';
import { BuilderChatPanel, type ChatMessage } from './BuilderChatPanel';
import { BuilderMainPanel } from './BuilderMainPanel';
import { useCodingRun } from './useCodingRun';

/**
 * Frontend Builder workspace (Step 32).
 *
 * Three regions over the systems that already exist: the project explorer
 * (native source storage), the main builder area (overview + read-only file
 * inspection), and the AI builder panel (a conversation with the coding agent).
 *
 * It adds no second storage, no second generation engine and no second approval
 * mechanism. Every mutation goes through a coding run the user approved.
 */

interface FrontendBuilderPageProps {
  readonly projectId: string | null;
}

type MobilePanel = 'files' | 'builder' | 'chat';

export function FrontendBuilderPage({ projectId }: FrontendBuilderPageProps) {
  const { toast } = useToast();
  const [project, setProject] = useState<projectsApi.ProjectView | null>(null);
  const [workspace, setWorkspace] = useState<workspacesApi.WorkspaceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tree, setTree] = useState<sourceApi.SourceTreeView | null>(null);
  const [history, setHistory] = useState<readonly sourceApi.FileHistoryEntry[]>([]);
  const [structure, setStructure] = useState<sourceApi.FrontendStructureView | null>(null);
  const [structureError, setStructureError] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<sourceApi.SourceFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [capabilities, setCapabilities] = useState<codingApi.CodingCapabilities | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('builder');

  const { run, busy, error: runError, decisionsPending, start, decide, cancel } = useCodingRun();
  const annotatedRun = useRef<string | null>(null);
  const composerFocus = useRef<(() => void) | null>(null);

  // -- project + workspace context -----------------------------------------
  useEffect(() => {
    if (projectId === null) {
      setError('No project was selected.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
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
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    void codingApi
      .fetchCodingCapabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, []);

  const workspaceId = workspace?.id;

  // -- structure (server-classified) ---------------------------------------
  const loadStructure = useCallback(async () => {
    if (projectId === null) return;
    setStructureError('');
    try {
      setStructure(await sourceApi.fetchStructure(projectId, workspaceId));
    } catch (structureFailure) {
      setStructure(null);
      setStructureError(errorMessage(structureFailure));
    }
  }, [projectId, workspaceId]);

  useEffect(() => {
    void loadStructure();
  }, [loadStructure, refreshSignal]);

  const handleTreeLoaded = useCallback(
    (nextTree: sourceApi.SourceTreeView, nextHistory: readonly sourceApi.FileHistoryEntry[]) => {
      setTree(nextTree);
      setHistory(nextHistory);
    },
    [],
  );

  // -- file selection ------------------------------------------------------
  useEffect(() => {
    if (projectId === null || selectedPath === null) {
      setFile(null);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    setFileError('');
    void (async () => {
      try {
        const next = await sourceApi.fetchFile(projectId, selectedPath, workspaceId);
        if (!cancelled) setFile(next);
      } catch (readError) {
        if (!cancelled) {
          setFile(null);
          setFileError(errorMessage(readError));
        }
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedPath, workspaceId, refreshSignal]);

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
          text: 'This project has no workspace yet, so the coding agent has nowhere to write. Create a workspace first.',
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

  // One assistant note per finished run, never one per poll.
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
      toast('Builder run finished. Files refreshed.', { tone: 'success' });
      refreshEverything();
    } else if (run.state === 'failed') {
      pushMessage({
        id: `assistant-${run.runId}`,
        role: 'assistant',
        text: `The run stopped: ${run.failure?.message ?? 'an unreported failure'}.`,
      });
      toast('The builder run failed.', { tone: 'error' });
    } else {
      pushMessage({
        id: `assistant-${run.runId}`,
        role: 'assistant',
        text: 'You cancelled the run. Nothing further will be written.',
      });
    }
  }, [pushMessage, refreshEverything, run, toast]);

  const handleReviewChanges = useCallback(() => {
    setSelectedPath(null);
    setMobilePanel('files');
    refreshEverything();
  }, [refreshEverything]);

  const handleStartBuilding = useCallback(() => {
    setMobilePanel('chat');
    composerFocus.current?.();
  }, []);

  const shellNote = useMemo(() => {
    if (workspace === null) return 'No workspace yet';
    return `workspace ${workspace.name}`;
  }, [workspace]);

  if (loading) {
    return (
      <div className="v-fbuilder v-fbuilder--loading" data-testid="frontend-builder">
        <p className="v-fbuilder__note" role="status">
          <Spinner size="sm" aria-label="Loading project" /> Loading project…
        </p>
      </div>
    );
  }

  if (error !== '') {
    return (
      <div className="v-fbuilder" data-testid="frontend-builder">
        <ErrorState
          title="Could not open this project"
          description={error}
          retry={{ label: 'Try again', onClick: () => window.location.reload() }}
        />
      </div>
    );
  }

  if (project === null || projectId === null) {
    return (
      <div className="v-fbuilder" data-testid="frontend-builder">
        <ErrorState title="Project not found" description="Pick a project to open the builder." />
      </div>
    );
  }

  return (
    <div className={`v-fbuilder v-fbuilder--panel-${mobilePanel}`} data-testid="frontend-builder">
      <header className="v-fbuilder__header">
        <div className="v-fbuilder__identity">
          <h1 className="v-fbuilder__title">{project.name}</h1>
          <div className="v-fbuilder__badges">
            <Badge tone={project.status === 'active' ? 'success' : 'warning'}>
              {project.status}
            </Badge>
            <Badge tone="neutral">{project.projectType}</Badge>
            <Badge tone="neutral">{shellNote}</Badge>
          </div>
        </div>
        <nav className="v-fbuilder__tabs" aria-label="Builder panels">
          {(['files', 'builder', 'chat'] as const).map((panel) => (
            <button
              key={panel}
              type="button"
              className={`v-fbuilder__tab${mobilePanel === panel ? ' v-fbuilder__tab--active' : ''}`}
              aria-pressed={mobilePanel === panel}
              onClick={() => setMobilePanel(panel)}
            >
              {panel === 'files' ? 'Files' : panel === 'builder' ? 'Builder' : 'AI chat'}
            </button>
          ))}
        </nav>
      </header>

      <div className="v-fbuilder__body">
        <aside
          className="v-fbuilder__region v-fbuilder__region--explorer"
          aria-label="Project explorer"
        >
          <SourceExplorer
            projectId={projectId}
            {...(workspaceId === undefined ? {} : { workspaceId })}
            showPreview={false}
            selectedPath={selectedPath}
            onSelectFile={setSelectedPath}
            onLoaded={handleTreeLoaded}
            refreshSignal={refreshSignal}
          />
        </aside>

        <div className="v-fbuilder__region v-fbuilder__region--main">
          <BuilderMainPanel
            project={project}
            workspace={workspace}
            tree={tree}
            history={history}
            structure={structure}
            structureError={structureError}
            selectedPath={selectedPath}
            file={file}
            fileLoading={fileLoading}
            fileError={fileError}
            run={run}
            onSelectFile={setSelectedPath}
            onClearSelection={() => setSelectedPath(null)}
            onStartBuilding={handleStartBuilding}
            onRefresh={refreshEverything}
          />
        </div>

        <div className="v-fbuilder__region v-fbuilder__region--chat">
          <BuilderChatPanel
            run={run}
            busy={busy}
            error={runError}
            decisionsPending={decisionsPending}
            capabilities={capabilities}
            messages={messages}
            history={history}
            onSend={(requirement) => void handleSend(requirement)}
            onDecide={(decision) => void decide(decision)}
            onCancel={() => void cancel()}
            onReviewChanges={handleReviewChanges}
          />
        </div>
      </div>

      {project.status === 'archived' && (
        <p className="v-fbuilder__note" role="note">
          This project is archived. Restore it before asking the builder to write files.
        </p>
      )}
      <div className="v-fbuilder__footer">
        <Button variant="secondary" onClick={refreshEverything} aria-label="Refresh project files">
          Refresh project
        </Button>
      </div>
    </div>
  );
}
