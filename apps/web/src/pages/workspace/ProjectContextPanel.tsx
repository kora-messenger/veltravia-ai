import { Badge } from '../../components/ui';
import { formatTimestamp } from '../../api/projects';
import type { ProjectView } from '../../api/projects';
import type { WorkspaceView } from '../../api/workspaces';
import { ProjectStatusBadge } from '../projects/ProjectStatusBadge';

export interface ProjectContextPanelProps {
  project: ProjectView;
  /** The project's workspaces; the workspace surface uses the first active one. */
  workspaces: readonly WorkspaceView[];
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
 * File-tree illustration. This is deliberately NOT live data — the real
 * Project Engine file tree is wired in a later checkpoint. The caption says
 * so, and the tree is static markup (no fake API behind it).
 */
function FileTreePreview() {
  return (
    <div className="v-context-files">
      <div className="v-context-files__tree" aria-hidden="true">
        <span className="v-context-files__entry v-context-files__entry--folder">src/</span>
        <span className="v-context-files__entry v-context-files__entry--depth1">components/</span>
        <span className="v-context-files__entry v-context-files__entry--depth1">index.ts</span>
        <span className="v-context-files__entry">package.json</span>
        <span className="v-context-files__entry">README.md</span>
      </div>
      <p className="v-context-files__note">
        Illustration only — your project&rsquo;s real files appear here once the file engine is
        connected in a later release.
      </p>
    </div>
  );
}

/**
 * Left workspace panel: the identity and context of the project being
 * worked on — project, workspace, and (later) its file tree.
 */
export function ProjectContextPanel({ project, workspaces }: ProjectContextPanelProps) {
  const workspace = workspaces.find((item) => item.status === 'active') ?? workspaces[0] ?? null;

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
            <p className="v-context-empty">No workspace yet. Create one from the project page.</p>
          ) : (
            <>
              <p className="v-context-project__name">{workspace.name}</p>
              <Badge tone={WORKSPACE_STATUS_TONE[workspace.status]}>
                {WORKSPACE_STATUS_LABEL[workspace.status]}
              </Badge>
              <p className="v-context-meta__item">Created {formatTimestamp(workspace.createdAt)}</p>
            </>
          )}
        </div>
      </section>

      <section className="v-context-section" aria-labelledby="v-context-files-heading">
        <h3 className="v-context-section__title" id="v-context-files-heading">
          Files
        </h3>
        <FileTreePreview />
      </section>
    </nav>
  );
}
