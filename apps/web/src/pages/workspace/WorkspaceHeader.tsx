import { navigateToHash } from '../../shell/useHashRoute';
import type { ProjectView } from '../../api/projects';
import { ProjectStatusBadge } from '../projects/ProjectStatusBadge';

export interface WorkspaceHeaderProps {
  project: ProjectView;
  /** Whether the side panels are toggled (used by mobile panel buttons). */
  onOpenContext(): void;
  onOpenMemory(): void;
  onOpenActivity(): void;
}

/**
 * The workspace top bar: where you are (project + status), the way back to
 * the project page, and — on small screens — triggers for the context and
 * activity drawers. Global branding and account controls stay in the
 * application top bar (Step 11A shell).
 */
export function WorkspaceHeader({
  project,
  onOpenContext,
  onOpenMemory,
  onOpenActivity,
}: WorkspaceHeaderProps) {
  return (
    <header className="v-workspace-header">
      <div className="v-workspace-header__crumbs">
        <button
          type="button"
          className="v-workspace-header__back"
          onClick={() => navigateToHash(`#/projects/${project.id}`)}
        >
          ← Project
        </button>
        {/* The workspace's page-level heading; panel sections are h3s. */}
        <h2 className="v-workspace-header__name">{project.name}</h2>
        <ProjectStatusBadge status={project.status} />
      </div>
      <div className="v-workspace-header__panel-actions">
        <button type="button" className="v-workspace-header__panel-btn" onClick={onOpenContext}>
          Project context
        </button>
        <button type="button" className="v-workspace-header__panel-btn" onClick={onOpenMemory}>
          Memory
        </button>
        <button type="button" className="v-workspace-header__panel-btn" onClick={onOpenActivity}>
          Activity
        </button>
      </div>
    </header>
  );
}
