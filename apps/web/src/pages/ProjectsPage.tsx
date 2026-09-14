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

type StatusFilter = 'all' | 'active' | 'archived';

const FILTERS: readonly { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
];

/**
 * Project management: the full project list with status filters, creation,
 * and archive/restore actions — all backed by the Project Engine API.
 */
export function ProjectsPage() {
  const resource = useAsyncResource(listProjects, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [statusChange, setStatusChange] = useState<StatusChangeRequest | null>(null);

  const projects = resource.state === 'ready' ? (resource.data ?? []) : [];

  const visible = useMemo(() => {
    if (filter === 'all') return projects;
    return projects.filter((project) => project.status === filter);
  }, [projects, filter]);

  const openProject = (project: ProjectView) => {
    navigateToHash(`#/projects/${encodeURIComponent(project.id)}`);
  };

  return (
    <div className="v-page">
      <header className="v-page-header">
        <div>
          <h2 className="v-page-header__title">Projects</h2>
          <p className="v-page-header__description">
            Create, open, and manage your Veltravia AI projects.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New project</Button>
      </header>

      {resource.state === 'ready' && projects.length > 0 && (
        <div className="v-filter" role="group" aria-label="Filter projects by status">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="v-filter__chip"
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

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

      {resource.state === 'ready' && projects.length > 0 && visible.length === 0 && (
        <div className="v-empty-wide">
          <div className="v-empty-wide__inner">
            <h3 className="v-heading-3">
              {filter === 'archived' ? 'No archived projects' : 'No active projects'}
            </h3>
            <p className="v-empty-wide__hint">
              {filter === 'archived'
                ? 'Projects you archive will appear here.'
                : 'Restore an archived project to see it here.'}
            </p>
          </div>
        </div>
      )}

      {resource.state === 'ready' && visible.length > 0 && (
        <div className="v-project-grid">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={openProject}
              onArchive={(target) => setStatusChange({ project: target, action: 'archive' })}
              onRestore={(target) => setStatusChange({ project: target, action: 'restore' })}
            />
          ))}
        </div>
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
