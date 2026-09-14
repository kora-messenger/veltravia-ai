import { useState } from 'react';
import { navigateToHash } from '../shell/useHashRoute';
import { useAsyncResource } from '../api/use-async-resource';
import { ApiError, errorMessage } from '../api/client';
import { formatTimestamp, getProject, type ProjectView } from '../api/projects';
import { createWorkspace, listWorkspaces, type WorkspaceView } from '../api/workspaces';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Input,
  Menu,
  Spinner,
  useToast,
} from '../components/ui';
import { EditProjectDialog } from './projects/EditProjectDialog';
import { ProjectStatusBadge } from './projects/ProjectStatusBadge';
import {
  ProjectStatusChangeDialog,
  type StatusChangeRequest,
} from './projects/ProjectStatusChangeDialog';

interface ProjectDetail {
  readonly project: ProjectView;
  readonly workspaces: readonly WorkspaceView[];
}

async function loadDetail(projectId: string): Promise<ProjectDetail> {
  const [project, workspaces] = await Promise.all([
    getProject(projectId),
    listWorkspaces(projectId),
  ]);
  return { project, workspaces };
}

const WORKSPACE_STATUS_LABELS: Record<WorkspaceView['status'], string> = {
  active: 'Active',
  locked: 'Locked',
  archived: 'Archived',
};

/**
 * Project detail: identity, status, workspace overview, and the project
 * actions the engine supports. The code editor and AI workspace arrive in
 * later checkpoints — nothing here pretends otherwise.
 */
export function ProjectDetailPage({ projectId }: { projectId: string | null }) {
  const resource = useAsyncResource(async () => loadDetail(projectId ?? ''), [projectId]);
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [statusChange, setStatusChange] = useState<StatusChangeRequest | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);

  const detail = resource.state === 'ready' ? resource.data : null;
  const project = detail?.project ?? null;
  const workspaces = detail?.workspaces ?? [];
  const notFound =
    resource.state === 'error' &&
    resource.error instanceof ApiError &&
    (resource.error.status === 404 ||
      resource.error.code === 'PROJECT_NOT_FOUND' ||
      resource.error.code === 'WORKSPACE_NOT_FOUND');

  return (
    <div className="v-page v-detail">
      <Button variant="ghost" size="sm" onClick={() => navigateToHash('#/projects')}>
        ← Projects
      </Button>

      {resource.state === 'loading' && (
        <div className="v-loading" role="status">
          <Spinner size="lg" />
        </div>
      )}

      {resource.state === 'error' && notFound && (
        <ErrorState
          title="Project not found"
          description="This project no longer exists or could not be found."
          retry={{ label: 'Back to projects', onClick: () => navigateToHash('#/projects') }}
        />
      )}

      {resource.state === 'error' && !notFound && (
        <ErrorState
          description={errorMessage(resource.error)}
          retry={{ onClick: resource.reload }}
        />
      )}

      {resource.state === 'ready' && project !== null && (
        <>
          <header className="v-detail-header">
            <div className="v-detail-header__identity">
              <div className="v-detail-header__row">
                <h2 className="v-page-header__title">{project.name}</h2>
                <ProjectStatusBadge status={project.status} />
              </div>
              {project.description !== '' && (
                <p className="v-page-header__description">{project.description}</p>
              )}
              <div className="v-detail-header__meta">
                <Badge tone="neutral">{project.projectType}</Badge>
                {project.version !== '' && (
                  <span className="v-detail-header__meta-item">Version {project.version}</span>
                )}
                <span className="v-detail-header__meta-item">
                  Created {formatTimestamp(project.createdAt)}
                </span>
                <span className="v-detail-header__meta-item">
                  Updated {formatTimestamp(project.updatedAt)}
                </span>
              </div>
            </div>
            <Menu
              triggerLabel={`Actions for ${project.name}`}
              trigger={<span aria-hidden="true">⋯</span>}
              items={[
                { id: 'edit', label: 'Edit details', onSelect: () => setEditOpen(true) },
                project.status === 'active'
                  ? {
                      id: 'archive',
                      label: 'Archive project',
                      onSelect: () => setStatusChange({ project, action: 'archive' }),
                    }
                  : {
                      id: 'restore',
                      label: 'Restore project',
                      onSelect: () => setStatusChange({ project, action: 'restore' }),
                    },
              ]}
            />
          </header>

          <section aria-label="Workspaces" className="v-page-section">
            <div className="v-page-section__header">
              <h3 className="v-heading-3">Workspaces</h3>
              {project.status === 'active' && (
                <Button size="sm" variant="secondary" onClick={() => setWorkspaceDialogOpen(true)}>
                  New workspace
                </Button>
              )}
            </div>
            {project.status === 'archived' && (
              <p className="v-muted-note">
                This project is archived. Restore it to create new workspaces.
              </p>
            )}
            {workspaces.length === 0 ? (
              <p className="v-muted-note">
                No workspaces yet. Workspaces hold this project&rsquo;s files; the file tree and
                editor arrive in a later release.
              </p>
            ) : (
              <ul className="v-workspace-list">
                {workspaces.map((workspace) => (
                  <li key={workspace.id} className="v-workspace-row">
                    <span className="v-workspace-row__name">{workspace.name}</span>
                    <Badge tone={workspace.status === 'active' ? 'success' : 'neutral'}>
                      {WORKSPACE_STATUS_LABELS[workspace.status]}
                    </Badge>
                    <span className="v-workspace-row__created">
                      Created {formatTimestamp(workspace.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {editOpen && project !== null && (
            <EditProjectDialog
              open
              project={project}
              onClose={() => setEditOpen(false)}
              onUpdated={() => {
                setEditOpen(false);
                resource.reload();
              }}
              onConflict={() => resource.reload()}
            />
          )}

          <ProjectStatusChangeDialog
            request={statusChange}
            onClose={() => setStatusChange(null)}
            onDone={() => {
              setStatusChange(null);
              resource.reload();
            }}
          />

          <CreateWorkspaceDialog
            open={workspaceDialogOpen}
            projectId={project.id}
            onClose={() => setWorkspaceDialogOpen(false)}
            onCreated={(workspace) => {
              setWorkspaceDialogOpen(false);
              toast(`Workspace "${workspace.name}" created.`, { tone: 'success' });
              resource.reload();
            }}
          />
        </>
      )}
    </div>
  );
}

const WORKSPACE_NAME_MAX = 128;

export interface CreateWorkspaceDialogProps {
  open: boolean;
  projectId: string;
  onClose(): void;
  onCreated(workspace: WorkspaceView): void;
}

/** Minimal workspace creation UX, per the Project Engine contract. */
export function CreateWorkspaceDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    if (submitting) return;
    setName('');
    setNameError(null);
    setSubmitError(null);
    onClose();
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError('Give the workspace a name.');
      return;
    }
    if (trimmed.length > WORKSPACE_NAME_MAX) {
      setNameError(`Keep the name under ${WORKSPACE_NAME_MAX + 1} characters.`);
      return;
    }
    setNameError(null);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const workspace = await createWorkspace(projectId, { name: trimmed });
      setName('');
      onCreated(workspace);
    } catch (failure) {
      setSubmitError(errorMessage(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New workspace"
      description="A workspace holds this project's files."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            Create workspace
          </Button>
        </>
      }
    >
      <div className="v-form-field">
        <Input
          label="Workspace name"
          placeholder="e.g. Main"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError ?? undefined}
          autoFocus
        />
      </div>
      {submitError !== null && (
        <p className="v-form-error" role="alert">
          {submitError}
        </p>
      )}
    </Dialog>
  );
}
