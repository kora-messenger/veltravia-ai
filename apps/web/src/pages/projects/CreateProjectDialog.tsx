import { useState, type FormEvent } from 'react';
import { Button, Dialog, Input, Select, Textarea, useToast } from '../../components/ui';
import {
  PROJECT_TYPE_OPTIONS,
  createProject,
  type ProjectType,
  type ProjectView,
} from '../../api/projects';
import { errorMessage } from '../../api/client';

export interface CreateProjectDialogProps {
  open: boolean;
  onClose(): void;
  /** Called after a successful create; navigates to the new project. */
  onCreated(project: ProjectView): void;
}

const TYPE_LABELS: Record<ProjectType, string> = {
  web: 'Web application',
  mobile: 'Mobile application',
  backend: 'Backend service',
  fullstack: 'Full-stack application',
  library: 'Library / package',
  other: 'Other',
};

const NAME_MAX = 128;
const DESCRIPTION_MAX = 2000;

/**
 * Create Project flow. Only fields the Project Engine supports are collected;
 * ownership is assigned server-side (never hardcoded in the frontend).
 */
export function CreateProjectDialog({ open, onClose, onCreated }: CreateProjectDialogProps) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectType, setProjectType] = useState<ProjectType>('web');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName('');
    setDescription('');
    setProjectType('web');
    setNameError(null);
    setSubmitError(null);
    setSubmitting(false);
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const validateName = (value: string): string | null => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 'Give the project a name.';
    }
    if (trimmed.length > NAME_MAX) {
      return `Keep the name under ${NAME_MAX + 1} characters.`;
    }
    return null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const error = validateName(name);
    setNameError(error);
    if (error !== null) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        description: description.trim(),
        projectType,
      });
      toast(`Project "${project.name}" created.`, { tone: 'success' });
      reset();
      onCreated(project);
    } catch (failure) {
      setSubmitError(errorMessage(failure));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New project"
      description="Projects hold your workspaces and project data."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="create-project-form" loading={submitting}>
            Create project
          </Button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={submit} noValidate>
        <div className="v-form-field">
          <Input
            label="Project name"
            placeholder="e.g. Portfolio site"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError ?? undefined}
            hint="Shown in lists and dashboards."
            autoFocus
          />
        </div>
        <div className="v-form-field">
          <Select
            label="Project type"
            options={PROJECT_TYPE_OPTIONS.map((type) => ({
              value: type,
              label: TYPE_LABELS[type],
            }))}
            value={projectType}
            onChange={(event) => setProjectType(event.target.value as ProjectType)}
          />
        </div>
        <div className="v-form-field">
          <Textarea
            label="Description"
            placeholder="What is this project for?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            hint={`Optional. Up to ${DESCRIPTION_MAX} characters.`}
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
