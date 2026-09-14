import { useMemo, useState } from 'react';
import { navigateToHash } from '../shell/useHashRoute';
import { useAsyncResource } from '../api/use-async-resource';
import { errorMessage } from '../api/client';
import { listProjects, type ProjectView } from '../api/projects';
import { Button, ErrorState, Spinner } from '../components/ui';
import { CreateProjectDialog } from './projects/CreateProjectDialog';
import { ProjectCard } from './projects/ProjectCard';
import {
  ProjectStatusChangeDialog,
  type StatusChangeRequest,
} from './projects/ProjectStatusChangeDialog';

const RECENT_LIMIT = 5;

/**
 * The project dashboard: an overview of the user's projects with direct
 * access to the most recently updated ones and project creation.
 */
export function DashboardPage() {
  const resource = useAsyncResource(listProjects, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [statusChange, setStatusChange] = useState<StatusChangeRequest | null>(null);

  const projects = resource.state === 'ready' ? (resource.data ?? []) : [];

  const stats = useMemo(() => {
    const active = projects.filter((project) => project.status === 'active').length;
    return {
      total: projects.length,
      active,
      archived: projects.length - active,
    };
  }, [projects]);

  const recent = useMemo(
    () =>
      [...projects]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .slice(0, RECENT_LIMIT),
    [projects],
  );

  const openProject = (project: ProjectView) => {
    navigateToHash(`#/projects/${encodeURIComponent(project.id)}`);
  };

  return (
    <div className="v-page">
      <header className="v-page-header">
        <div>
          <h2 className="v-page-header__title">Overview</h2>
          <p className="v-page-header__description">
            Your Veltravia AI projects, workspaces, and activity at a glance.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New project</Button>
      </header>

      {resource.state === 'loading' && (
        <div className="v-loading" role="status">
          <Spinner size="lg" />
        </div>
      )}

      {resource.state === 'error' && (
        <ErrorState
          description={errorMessage(resource.error)}
          retry={{ onClick: resource.reload }}
        />
      )}

      {resource.state === 'ready' && projects.length === 0 && (
        <div className="v-empty-wide">
          <div className="v-empty-wide__inner">
            <h3 className="v-heading-3">No projects yet</h3>
            <p className="v-empty-wide__hint">
              Create your first Veltravia project and start building.
            </p>
            <Button onClick={() => setCreateOpen(true)}>Create a project</Button>
          </div>
        </div>
      )}

      {resource.state === 'ready' && projects.length > 0 && (
        <>
          <section aria-label="Project overview" className="v-stat-grid">
            <div className="v-stat-tile">
              <span className="v-stat-tile__label">Total projects</span>
              <span className="v-stat-tile__value">{stats.total}</span>
            </div>
            <div className="v-stat-tile">
              <span className="v-stat-tile__label">Active</span>
              <span className="v-stat-tile__value">{stats.active}</span>
            </div>
            <div className="v-stat-tile">
              <span className="v-stat-tile__label">Archived</span>
              <span className="v-stat-tile__value">{stats.archived}</span>
            </div>
          </section>

          <section aria-label="Recently updated projects" className="v-page-section">
            <div className="v-page-section__header">
              <h3 className="v-heading-3">Recently updated</h3>
              <Button variant="ghost" size="sm" onClick={() => navigateToHash('#/projects')}>
                View all projects
              </Button>
            </div>
            <div className="v-project-grid v-project-grid--recent">
              {recent.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={openProject}
                  onArchive={(target) => setStatusChange({ project: target, action: 'archive' })}
                  onRestore={(target) => setStatusChange({ project: target, action: 'restore' })}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <ProjectStatusChangeDialog
        request={statusChange}
        onClose={() => setStatusChange(null)}
        onDone={() => {
          setStatusChange(null);
          resource.reload();
        }}
      />

      <CreateProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(project) => {
          setCreateOpen(false);
          navigateToHash(`#/projects/${encodeURIComponent(project.id)}`);
        }}
      />
    </div>
  );
}
