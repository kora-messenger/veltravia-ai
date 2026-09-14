import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { ToastProvider } from '../../components/ui';
import { CreateProjectDialog } from './CreateProjectDialog';
import { createProject, type ProjectView } from '../../api/projects';
import { ApiError } from '../../api/client';

vi.mock('../../api/projects', () => ({
  createProject: vi.fn(),
  PROJECT_TYPE_OPTIONS: ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'],
}));

const mockedCreateProject = vi.mocked(createProject);

function createdProject(): ProjectView {
  return {
    id: 'prj-7',
    name: 'New app',
    description: 'A new project',
    status: 'active',
    projectType: 'web',
    version: '1.0.0',
    revision: 1,
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

function renderDialog(onCreated: (project: ProjectView) => void = vi.fn()) {
  const onClose = vi.fn();
  render(
    <ThemeProvider>
      <ToastProvider>
        <CreateProjectDialog open onClose={onClose} onCreated={onCreated} />
      </ToastProvider>
    </ThemeProvider>,
  );
  return { onCreated, onClose };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
});

async function fillName(value: string) {
  const name = screen.getByLabelText(/project name/i);
  await fireEvent.change(name, { target: { value } });
}

describe('CreateProjectDialog', () => {
  it('collects only engine-supported fields', () => {
    renderDialog();
    expect(screen.getByLabelText(/project name/i)).toBeDefined();
    expect(screen.getByLabelText(/description/i)).toBeDefined();
    expect(screen.getByLabelText(/project type/i)).toBeDefined();
  });

  it('blocks submission with a field-level error when the name is empty', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Give the project a name.')).toBeDefined();
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it('shows a friendly API error and keeps the dialog open on failure', async () => {
    mockedCreateProject.mockRejectedValueOnce(
      new ApiError(400, 'PROJECT_INVALID_REQUEST', 'name too long'),
    );
    renderDialog();
    await fillName('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('creates the project, toasts, and hands it to the caller', async () => {
    mockedCreateProject.mockResolvedValueOnce(createdProject());
    const onCreated = vi.fn();
    renderDialog(onCreated);

    await fillName('New app');
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'A new project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'prj-7' })),
    );
    expect(mockedCreateProject).toHaveBeenCalledWith({
      name: 'New app',
      description: 'A new project',
      projectType: 'web',
    });
  });

  it('disables the cancel action while submitting', async () => {
    let resolveCreate: (project: ProjectView) => void = () => undefined;
    mockedCreateProject.mockReturnValueOnce(
      new Promise<ProjectView>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderDialog();
    await fillName('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true));
    resolveCreate(createdProject());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(false),
    );
  });
});
