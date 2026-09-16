import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { getProject, type ProjectView } from '../api/projects';
import { listWorkspaces, type WorkspaceView } from '../api/workspaces';
import { listAgents, type AgentSummaryView } from '../api/agents';
import { useAsyncResource } from '../api/use-async-resource';
import { ErrorState, Select, Spinner, useToast } from '../components/ui';
import { navigateToHash } from '../shell/useHashRoute';
import { ProjectContextPanel } from './workspace/ProjectContextPanel';
import { ConversationArea } from './workspace/ConversationArea';
import { MessageComposer } from './workspace/MessageComposer';
import { ActivityPanel } from './workspace/ActivityPanel';
import { WorkspaceDrawer } from './workspace/WorkspaceDrawer';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import { RunStatus } from './workspace/RunStatus';
import { useAgentRun } from './workspace/use-agent-run';
import { runActivityEntries, toolActivityEntries } from './workspace/tool-activity';
import { ConfirmationCard } from './workspace/ConfirmationCard';
import type { WorkspaceMessageView } from './workspace/message-model';

interface WorkspaceDetail {
  readonly project: ProjectView;
  readonly workspaces: readonly WorkspaceView[];
}

/**
 * Development agent preference (documented limitation): the API currently
 * offers scripted demo agents. The workspace picks the direct-answer agent
 * when present, otherwise the first agent the API lists. Swapping in the
 * real workspace agent changes nothing else.
 */
const PREFERRED_AGENT_IDS: readonly string[] = ['agent.demo.answer', 'agent.demo'];

function selectAgent(agents: readonly AgentSummaryView[]): string | null {
  for (const preferred of PREFERRED_AGENT_IDS) {
    const match = agents.find((agent) => agent.id === preferred);
    if (match !== undefined) return match.id;
  }
  return agents.length > 0 ? (agents[0]?.id ?? null) : null;
}

async function loadWorkspaceDetail(projectId: string): Promise<WorkspaceDetail> {
  const [project, workspaces] = await Promise.all([
    getProject(projectId),
    listWorkspaces(projectId),
  ]);
  return { project, workspaces };
}

/**
 * The AI Workspace shell for one project (Step 11C-1).
 *
 * STRUCTURE ONLY: the three-panel layout, conversation surface, composer,
 * and activity panels exist; live AI interaction, the file tree, tools,
 * and the coding agent arrive in later checkpoints and are never
 * simulated here. The only backend calls are the existing safe
 * project/workspace reads needed to identify this project.
 */
export function ProjectWorkspacePage({ projectId }: { projectId: string | null }) {
  const resource = useAsyncResource(async () => loadWorkspaceDetail(projectId ?? ''), [projectId]);
  const agentsResource = useAsyncResource(async () => listAgents(), []);
  const { toast } = useToast();
  const [messages, setMessages] = useState<readonly WorkspaceMessageView[]>([]);
  const [chosenAgentId, setChosenAgentId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);

  const agents = agentsResource.state === 'ready' ? agentsResource.data : null;
  const agentId = chosenAgentId ?? (agents !== null ? selectAgent(agents) : null);

  // Default to the first active workspace once the workspaces are known.
  // Runs started BEFORE a switch keep their original association (each run
  // pins its ids server-side); only NEW runs use the new selection.
  useEffect(() => {
    if (selectedWorkspaceId !== null || resource.state !== 'ready') return;
    const workspaces = resource.data?.workspaces ?? [];
    const preferred = workspaces.find((item) => item.status === 'active') ?? workspaces[0];
    if (preferred !== undefined) setSelectedWorkspaceId(preferred.id);
  }, [resource.state, resource.data, selectedWorkspaceId]);

  const run = useAgentRun({ agentId, projectId, workspaceId: selectedWorkspaceId });

  // Appends the run's real outcome to the conversation exactly once per
  // run: the assistant answer on completion, an honest system note on
  // cancelled/failed/limit-reached. Nothing is invented here — the text
  // comes from the backend-confirmed run state.
  const settledRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    const { phase, runId, finalOutput, failureMessage } = run.state;
    if (phase === 'completed' && runId !== null && finalOutput !== null) {
      if (settledRunIdRef.current === runId) return;
      settledRunIdRef.current = runId;
      setMessages((previous) => [
        ...previous,
        { id: `run-${runId}`, origin: 'assistant', text: finalOutput, timestamp: null },
      ]);
      return;
    }
    if (
      (phase === 'cancelled' || phase === 'failed' || phase === 'limit-reached') &&
      runId !== null
    ) {
      if (settledRunIdRef.current === runId) return;
      settledRunIdRef.current = runId;
      const note =
        phase === 'cancelled'
          ? 'This run was cancelled.'
          : (failureMessage ?? 'This run did not finish.');
      setMessages((previous) => [
        ...previous,
        { id: `run-${runId}-note`, origin: 'system', text: note, timestamp: null },
      ]);
    }
  }, [run.state]);

  const onSend = useCallback(
    (text: string) => {
      if (agentId === null) {
        toast('No agent is available to answer right now.', { tone: 'error' });
        return;
      }
      setMessages((previous) => [
        ...previous,
        { id: `user-${previous.length + 1}`, origin: 'user', text, timestamp: null },
      ]);
      run.start(text);
    },
    [agentId, run, toast],
  );

  const onSelectWorkspace = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
  }, []);

  const closeContextDrawer = useCallback(() => setContextDrawerOpen(false), []);
  const closeActivityDrawer = useCallback(() => setActivityDrawerOpen(false), []);

  const notFound =
    resource.state === 'error' &&
    resource.error instanceof ApiError &&
    (resource.error.status === 404 ||
      resource.error.code === 'PROJECT_NOT_FOUND' ||
      resource.error.code === 'WORKSPACE_NOT_FOUND');

  if (resource.state === 'loading') {
    return (
      <div className="v-workspace v-workspace--loading">
        <div className="v-loading" role="status">
          <Spinner size="lg" />
        </div>
      </div>
    );
  }

  if (resource.state === 'error') {
    return (
      <div className="v-workspace v-workspace--error">
        {notFound ? (
          <ErrorState
            title="Project not found"
            description="This project no longer exists or could not be found."
            retry={{ label: 'Back to projects', onClick: () => navigateToHash('#/projects') }}
          />
        ) : (
          <ErrorState
            title="Workspace unavailable"
            description={errorMessage(resource.error)}
            retry={{ onClick: resource.reload }}
          />
        )}
      </div>
    );
  }

  const detail = resource.data;
  if (detail === null) return null;
  const { project, workspaces } = detail;
  const runBusy =
    run.state.phase === 'creating' || run.state.phase === 'running' || run.state.phase === 'paused';
  const composerDisabled = project.status === 'archived' || agentId === null;
  const agentEntries = runActivityEntries(run.state);
  const toolEntries = toolActivityEntries(run.state.toolResults, run.state.pendingConfirmation);

  return (
    <div className="v-workspace">
      <WorkspaceHeader
        project={project}
        onOpenContext={() => setContextDrawerOpen(true)}
        onOpenActivity={() => setActivityDrawerOpen(true)}
      />

      <div className="v-workspace__body">
        <ProjectContextPanel
          project={project}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
        />

        <div className="v-workspace__center">
          <ConversationArea messages={messages}>
            <RunStatus
              state={run.state}
              onRetry={run.retry}
              onCancel={run.cancel}
              onRefresh={run.refresh}
            />
            {run.state.pendingConfirmation !== null && run.state.phase === 'paused' && (
              <ConfirmationCard
                pendingConfirmation={run.state.pendingConfirmation}
                submitting={run.state.confirmationSubmitting}
                error={run.state.confirmationError}
                onDecision={run.submitConfirmation}
              />
            )}
          </ConversationArea>
          {agents !== null && agents.length > 0 && (
            <Select
              className="v-workspace__agent-picker"
              label="Agent"
              hint="Which registered agent answers this conversation."
              value={agentId ?? undefined}
              disabled={runBusy}
              options={agents.map((agent) => ({
                value: agent.id,
                label: agent.displayName,
              }))}
              onChange={(event) => setChosenAgentId(event.target.value)}
            />
          )}
          <MessageComposer onSend={onSend} busy={runBusy} disabled={composerDisabled} />
        </div>

        <ActivityPanel agentEntries={agentEntries} toolEntries={toolEntries} />
      </div>

      <WorkspaceDrawer
        open={contextDrawerOpen}
        onClose={closeContextDrawer}
        label={`${project.name} context`}
      >
        <ProjectContextPanel
          project={project}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
        />
      </WorkspaceDrawer>

      <WorkspaceDrawer open={activityDrawerOpen} onClose={closeActivityDrawer} label="Activity">
        <ActivityPanel agentEntries={agentEntries} toolEntries={toolEntries} />
      </WorkspaceDrawer>
    </div>
  );
}
