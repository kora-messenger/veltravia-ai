import { useState } from 'react';
import { useToast } from '../../components/ui';
import { errorMessage } from '../../api/client';
import { archiveProject, restoreProject, type ProjectView } from '../../api/projects';
import { ConfirmDialog } from './ConfirmDialog';

export interface StatusChangeRequest {
  readonly project: ProjectView;
  readonly action: 'archive' | 'restore';
}

export interface ProjectStatusChangeDialogProps {
  request: StatusChangeRequest | null;
  onClose(): void;
  /** Called after a successful archive/restore with the updated project. */
  onDone(project: ProjectView): void;
}

/**
 * Confirmation + execution for archive/restore. The project engine treats
 * these as state transitions (archived → active and back); the dialog makes
 * the consequence explicit before the request is sent.
 */
export function ProjectStatusChangeDialog({
  request,
  onClose,
  onDone,
}: ProjectStatusChangeDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const open = request !== null;
  const project = request?.project ?? null;

  const confirm = async () => {
    if (request === null || project === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const updated =
        request.action === 'archive'
          ? await archiveProject(project.id)
          : await restoreProject(project.id);
      toast(
        request.action === 'archive'
          ? `Project "${updated.name}" archived.`
          : `Project "${updated.name}" restored.`,
        { tone: 'success' },
      );
      onDone(updated);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title={request?.action === 'archive' ? 'Archive project' : 'Restore project'}
      description={
        <>
          {request?.action === 'archive' ? (
            <span>
              Archive “{project?.name}”? Archived projects stay available and can be restored later.
            </span>
          ) : (
            <span>Restore “{project?.name}” to active status?</span>
          )}
          {failure !== null && (
            <span className="v-form-error" role="alert">
              {failure}
            </span>
          )}
        </>
      }
      confirmLabel={request?.action === 'archive' ? 'Archive project' : 'Restore project'}
      busy={busy}
      onConfirm={confirm}
      onClose={onClose}
    />
  );
}
