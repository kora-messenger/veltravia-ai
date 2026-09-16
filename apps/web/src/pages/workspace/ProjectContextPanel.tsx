import { Badge, Select } from '../../components/ui';
import { formatTimestamp } from '../../api/projects';
import type { ProjectView } from '../../api/projects';
import type { WorkspaceView } from '../../api/workspaces';
import { ProjectStatusBadge } from '../projects/ProjectStatusBadge';
import { WorkspaceFileTree } from './WorkspaceFileTree';

export interface ProjectContextPanelProps {
  project: ProjectView;
  /** The project's workspaces (already scoped to this project by the API). */
  workspaces: readonly WorkspaceView[];
  /** The selected workspace id - the context the AI runs against. */
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
}

const WORKSPACE_STATUS_TONE: Record<WorkspaceView['status'], 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  locked: 'warning',
  archived: 'neutral',
};

const WORKSPACE_STATUS_LABEL: Record<WorkspaceView['status'], string> = {
  active: 'Active',
  locked: 'Locked',
  archived: 'Archived',
};

/**
 * Left workspace panel: the real identity and context of the project
 * being worked on (Step 11C-4) — live project metadata, the selected
 * workspace, and the workspace's actual file tree. Everything here is
 * read-only context; nothing in this panel mutates the project.
 */
export function ProjectContextPanel({
  project,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
}: ProjectContextPanelProps) {
  const workspace =
    workspaces.find((item) => item.id === selectedWorkspaceId) ??
    workspaces.find((item) => item.status === 'active') ??
    workspaces[0] ??
    null;

  return (
    <nav className="v-context-panel" aria-label="Project context">
      <section className="v-context-section" aria-labelledby="v-context-project-heading">
        <h3 className="v-context-section__title" id="v-context-project-heading">
          Project
        </h3>
        <div className="v-context-section__body">
          <p className="v-context-project__name">{project.name}</p>
          <ProjectStatusBadge status={project.status} />
          <div className="v-context-meta">
            <Badge tone="neutral">{project.projectType}</Badge>
            {project.version !== '' && (
              <span className="v-context-meta__item">Version {project.version}</span>
            )}
            <span className="v-context-meta__item">
              Updated {formatTimestamp(project.updatedAt)}
            </span>
          </div>
          {project.description !== '' && (
            <p className="v-context-project__description">{project.description}</p>
          )}
        </div>
      </section>

      <section className="v-context-section" aria-labelledby="v-context-workspace-heading">
        <h3 className="v-context-section__title" id="v-context-workspace-heading">
          Workspace
        </h3>
        <div className="v-context-section__body">
          {workspace === null ? (
            <p className="v-context-empty">
              No workspace yet. AI runs in this project work without workspace context until one is
              created from the project page.
            </p>
          ) : (
            <>
              {workspaces.length > 1 && (
                <Select
                  className="v-context-workspace-picker"
                  label="Workspace"
                  hint="Which workspace's context the AI runs against."
                  value={workspace.id}
                  options={workspaces.map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(event) => onSelectWorkspace(event.target.value)}
                />
              )}
              <p className="v-context-project__name">{workspace.name}</p>
              <Badge tone={WORKSPACE_STATUS_TONE[workspace.status]}>
                {WORKSPACE_STATUS_LABEL[workspace.status]}
              </Badge>
              <p className="v-context-meta__item">Created {formatTimestamp(workspace.createdAt)}</p>
              <p className="v-context-meta__item">
                {workspaces.length > 1
                  ? 'New conversations use the selected workspace.'
                  : 'This workspace is the context for AI runs.'}
              </p>
            </>
          )}
        </div>
      </section>

      <section className="v-context-section" aria-labelledby="v-context-files-heading">
        <h3 className="v-context-section__title" id="v-context-files-heading">
          Files
        </h3>
        <WorkspaceFileTree workspaceId={workspace === null ? null : workspace.id} />
      </section>
    </nav>
  );
}
