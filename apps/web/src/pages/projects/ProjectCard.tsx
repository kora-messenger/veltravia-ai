import { Badge, Button, Menu } from '../../components/ui';
import { formatTimestamp, type ProjectView } from '../../api/projects';
import { ProjectStatusBadge } from './ProjectStatusBadge';

export interface ProjectCardProps {
  project: ProjectView;
  onOpen(project: ProjectView): void;
  onArchive(project: ProjectView): void;
  onRestore(project: ProjectView): void;
}

/** Summary card for a project, used on the dashboard and the projects page. */
export function ProjectCard({ project, onOpen, onArchive, onRestore }: ProjectCardProps) {
  return (
    <article className="v-project-card" aria-label={`Project ${project.name}`}>
      <div className="v-project-card__header">
        <h3 className="v-project-card__name">{project.name}</h3>
        <ProjectStatusBadge status={project.status} />
      </div>
      {project.description !== '' && (
        <p className="v-project-card__description">{project.description}</p>
      )}
      <div className="v-project-card__meta">
        <Badge tone="neutral">{project.projectType}</Badge>
        <span className="v-project-card__updated">
          Updated {formatTimestamp(project.updatedAt)}
        </span>
      </div>
      <div className="v-project-card__footer">
        <Button size="sm" onClick={() => onOpen(project)}>
          Open
        </Button>
        <Menu
          triggerLabel={`More actions for ${project.name}`}
          trigger={<span aria-hidden="true">⋯</span>}
          items={[
            project.status === 'active'
              ? {
                  id: 'archive',
                  label: 'Archive project',
                  onSelect: () => onArchive(project),
                }
              : {
                  id: 'restore',
                  label: 'Restore project',
                  onSelect: () => onRestore(project),
                },
          ]}
        />
      </div>
    </article>
  );
}
