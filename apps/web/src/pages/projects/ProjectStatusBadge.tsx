import { Badge } from '../../components/ui';
import type { ProjectStatus } from '../../api/projects';

/** Project status as text + tone; never color-only (the label is the truth). */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  if (status === 'active') {
    return (
      <Badge tone="success" dot>
        Active
      </Badge>
    );
  }
  return (
    <Badge tone="warning" dot>
      Archived
    </Badge>
  );
}
