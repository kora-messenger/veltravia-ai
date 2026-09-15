import { useCallback, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { getProject, type ProjectView } from '../api/projects';
import { listWorkspaces, type WorkspaceView } from '../api/workspaces';
import { useAsyncResource } from '../api/use-async-resource';
import { ErrorState, Spinner, useToast } from '../components/ui';
import { navigateToHash } from '../shell/useHashRoute';
import { ProjectContextPanel } from './workspace/ProjectContextPanel';
import { ConversationArea } from './workspace/ConversationArea';
import { MessageComposer } from './workspace/MessageComposer';
import { ActivityPanel } from './workspace/ActivityPanel';
import { WorkspaceDrawer } from './workspace/WorkspaceDrawer';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import type { WorkspaceMessageView } from './workspace/message-model';

interface WorkspaceDetail {
  readonly project: ProjectView;
  readonly workspaces: readonly WorkspaceView[];
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
  const { toast } = useToast();
  const [messages, setMessages] = useState<readonly WorkspaceMessageView[]>([]);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);

  const onSend = useCallback(
    (text: string) => {
      // Step 11C-1: the composer is a shell. Nothing is transmitted; the
      // message is only echoed locally so the user sees their own words in
      // the conversation. A real assistant reply arrives with Step 11C-2.
      setMessages((previous) => [
        ...previous,
        { id: `local-${previous.length + 1}`, origin: 'user', text, timestamp: null },
      ]);
      toast('Added to the conversation — AI replies arrive in a later release.', {
        tone: 'info',
      });
    },
    [toast],
  );

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
  const composerDisabled = project.status === 'archived';

  return (
    <div className="v-workspace">
      <WorkspaceHeader
        project={project}
        onOpenContext={() => setContextDrawerOpen(true)}
        onOpenActivity={() => setActivityDrawerOpen(true)}
      />

      <div className="v-workspace__body">
        <ProjectContextPanel project={project} workspaces={workspaces} />

        <div className="v-workspace__center">
          <ConversationArea messages={messages} />
          <MessageComposer onSend={onSend} disabled={composerDisabled} />
        </div>

        <ActivityPanel agentEntries={[]} toolEntries={[]} />
      </div>

      <WorkspaceDrawer
        open={contextDrawerOpen}
        onClose={closeContextDrawer}
        label={`${project.name} context`}
      >
        <ProjectContextPanel project={project} workspaces={workspaces} />
      </WorkspaceDrawer>

      <WorkspaceDrawer open={activityDrawerOpen} onClose={closeActivityDrawer} label="Activity">
        <ActivityPanel agentEntries={[]} toolEntries={[]} />
      </WorkspaceDrawer>
    </div>
  );
}
