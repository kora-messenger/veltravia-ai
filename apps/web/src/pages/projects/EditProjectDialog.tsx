import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { errorMessage } from '../../api/client';
import { updateProject, type ProjectView } from '../../api/projects';
import { Button, Dialog, Input, Textarea, useToast } from '../../components/ui';

export interface EditProjectDialogProps {
  open: boolean;
  project: ProjectView;
  onClose(): void;
  /** Called after a successful update. */
  onUpdated(project: ProjectView): void;
  /**
   * Called when the server rejected the write because the project moved on
   * (revision conflict). The parent reloads the latest project state; the
   * user retries against the fresh revision. The UI never overwrites silently.
   */
  onConflict(): void;
}

const NAME_MAX = 128;

/** Edit project identity (name/description) with revision protection. */
export function EditProjectDialog({
  open,
  project,
  onClose,
  onUpdated,
  onConflict,
}: EditProjectDialogProps) {
  const { toast } = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    if (submitting) return;
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError('Give the project a name.');
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setNameError(`Keep the name under ${NAME_MAX + 1} characters.`);
      return;
    }
    setNameError(null);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await updateProject(
        project.id,
        {
          name: trimmed,
          description: description.trim(),
        },
        // Revision safety: send the revision this form was opened against.
        project.revision,
      );
      toast('Project updated.', { tone: 'success' });
      onUpdated(updated);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'REVISION_CONFLICT') {
        setConflict(true);
        setSubmitError(
          'This project changed on the server while you were editing. The latest version has been loaded — review it and save again if your change still applies.',
        );
        onConflict();
      } else {
        setSubmitError(errorMessage(failure));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Edit project"
      description={conflict ? 'A newer version exists on the server.' : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="edit-project-form" loading={submitting}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-project-form" onSubmit={submit} noValidate>
        <div className="v-form-field">
          <Input
            label="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError ?? undefined}
            autoFocus
          />
        </div>
        <div className="v-form-field">
          <Textarea
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        {submitError !== null && (
          <p className="v-form-error" role="alert">
            {submitError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
