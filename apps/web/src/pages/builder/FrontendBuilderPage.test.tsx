// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { FrontendBuilderPage } from './FrontendBuilderPage';
import * as codingApi from '../../api/coding';
import * as projectsApi from '../../api/projects';
import * as sourceApi from '../../api/source';
import * as workspacesApi from '../../api/workspaces';
import { ApiError } from '../../api/client';

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  updateProject: vi.fn(),
}));
vi.mock('../../api/workspaces', () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));
vi.mock('../../api/source', () => ({
  fetchTree: vi.fn(),
  fetchHistory: vi.fn(),
  fetchFile: vi.fn(),
  fetchStructure: vi.fn(),
}));
vi.mock('../../api/coding', async () => {
  const actual = await vi.importActual<typeof import('../../api/coding')>('../../api/coding');
  return {
    ...actual,
    fetchCodingCapabilities: vi.fn(),
    startCodingRun: vi.fn(),
    fetchCodingRun: vi.fn(),
    submitCodingDecision: vi.fn(),
    cancelCodingRun: vi.fn(),
  };
});

const project: projectsApi.ProjectView = {
  id: 'proj-1',
  name: 'Portfolio site',
  description: 'A personal site.',
  projectType: 'web',
  status: 'active',
  version: 2,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

const workspace: workspacesApi.WorkspaceView = {
  id: 'ws-1',
  projectId: 'proj-1',
  name: 'main',
  status: 'active',
  revision: 4,
  createdAt: '2026-10-01T09:05:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

const tree: sourceApi.SourceTreeView = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  rootRevision: 4,
  files: [
    {
      path: 'src/pages/Home.tsx',
      type: 'file',
      size: 420,
      revision: 3,
      contentHash: 'sha256-abc',
      updatedAt: '2026-10-02T08:00:00.000Z',
    },
  ],
  directories: ['src', 'src/pages'],
  totals: { files: 1, bytes: 420 },
};

const history: readonly sourceApi.FileHistoryEntry[] = [
  {
    id: 'h1',
    path: 'src/pages/Home.tsx',
    changeKind: 'created',
    revision: 3,
    actor: 'coding-agent',
    at: '2026-10-02T08:00:00.000Z',
    bytes: 420,
  },
];

const structure: sourceApi.FrontendStructureView = {
  layout: 'component-based',
  framework: 'react',
  totals: { files: 1, bytes: 420 },
  sections: [
    {
      section: 'pages',
      label: 'Pages',
      count: 1,
      bytes: 420,
      files: [{ path: 'src/pages/Home.tsx', size: 420 }],
      omitted: 0,
    },
    { section: 'components', label: 'Components', count: 0, bytes: 0, files: [], omitted: 0 },
  ],
  pages: ['src/pages/Home.tsx'],
  components: [],
};

const capabilities: codingApi.CodingCapabilities = {
  decisionSource: 'scripted-demo',
  unavailableReason: null,
  planApprovalRequired: true,
  toolConfirmationsRequired: true,
  phases: ['planning', 'awaiting_approval', 'completed'],
};

function runView(overrides: Partial<codingApi.CodingRunView> = {}): codingApi.CodingRunView {
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    state: 'awaiting_approval',
    summary: null,
    changedFiles: [],
    iterations: 0,
    toolCalls: 1,
    startedAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:05.000Z',
    pendingApproval: { kind: 'plan_approval' },
    plan: {
      goal: 'Add a pricing page',
      steps: ['Read the router', 'Create the page'],
      filesToInspect: ['src/App.tsx'],
      filesToModify: ['src/pages/Pricing.tsx'],
      filesToCreate: ['src/pages/Pricing.tsx'],
      filesToDelete: [],
      validations: ['npm run build'],
      acceptanceCriteria: ['Build passes'],
      requestSummary: 'Add a pricing page',
      projectUnderstanding: 'Pages live in src/pages',
      approach: 'Register the page in the router',
      risks: [],
      validationStrategy: ['npm run build'],
      approvalRequirements: [],
      origin: 'script',
    },
    failure: null,
    phase: 'awaiting_approval',
    validationResults: [],
    model: null,
    ...overrides,
  };
}

function renderPage(projectId: string | null = 'proj-1') {
  return render(
    <ToastProvider>
      <FrontendBuilderPage projectId={projectId} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(projectsApi.getProject).mockResolvedValue(project);
  vi.mocked(workspacesApi.listWorkspaces).mockResolvedValue([workspace]);
  vi.mocked(sourceApi.fetchTree).mockResolvedValue(tree);
  vi.mocked(sourceApi.fetchHistory).mockResolvedValue(history);
  vi.mocked(sourceApi.fetchStructure).mockResolvedValue(structure);
  vi.mocked(sourceApi.fetchFile).mockResolvedValue({
    path: 'src/pages/Home.tsx',
    content: 'export default function Home() {}',
    revision: 3,
    size: 420,
    truncated: false,
  });
  vi.mocked(codingApi.fetchCodingCapabilities).mockResolvedValue(capabilities);
  vi.mocked(codingApi.startCodingRun).mockResolvedValue(runView());
  vi.mocked(codingApi.fetchCodingRun).mockResolvedValue(runView());
  vi.mocked(codingApi.submitCodingDecision).mockResolvedValue(
    runView({
      state: 'completed',
      summary: 'Created the pricing page.',
      changedFiles: ['src/pages/Pricing.tsx'],
      pendingApproval: null,
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('frontend builder page', () => {
  it('shows the project, real file totals and classified pages', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Portfolio site', level: 1 })).toBeDefined();
    expect(await screen.findByText('src/pages/Home.tsx')).toBeDefined();
    expect(screen.getAllByText('Pages').length).toBeGreaterThan(0);
    // Detection said react, so the header may name it; a null framework must not.
    expect(screen.getAllByRole('heading', { name: 'Portfolio site' }).length).toBe(2);
  });

  it('says plainly when the agent is a scripted demo', async () => {
    renderPage();
    expect(await screen.findByText('scripted demo agent')).toBeDefined();
    expect(screen.getByText(/runs the coding agent on a deterministic script/i)).toBeDefined();
  });

  it('shows an honest empty state for a project with no files', async () => {
    vi.mocked(sourceApi.fetchTree).mockResolvedValue({
      ...tree,
      files: [],
      directories: [],
      totals: { files: 0, bytes: 0 },
    });
    vi.mocked(sourceApi.fetchHistory).mockResolvedValue([]);
    vi.mocked(sourceApi.fetchStructure).mockResolvedValue({
      ...structure,
      pages: [],
      components: [],
      sections: [],
    });
    renderPage();
    expect(await screen.findByText('This project has no files yet')).toBeDefined();
    expect(screen.getByText(/No changes are recorded yet/i)).toBeDefined();
  });

  it('surfaces a project load failure with a retry', async () => {
    vi.mocked(projectsApi.getProject).mockRejectedValue(
      new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.'),
    );
    renderPage();
    expect(await screen.findByText('Could not open this project')).toBeDefined();
    expect(screen.getByText('Project not found.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('asks the agent, shows the plan, and only reports changes after approval', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Portfolio site', level: 1 });

    const composer = screen.getByLabelText('What should the builder do?');
    fireEvent.change(composer, { target: { value: 'Add a pricing page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(vi.mocked(codingApi.startCodingRun)).toHaveBeenCalled());
    expect(vi.mocked(codingApi.startCodingRun).mock.calls[0]?.[0]).toMatchObject({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      userRequirement: 'Add a pricing page',
    });

    // The plan is reviewable BEFORE anything is written.
    expect(await screen.findByTestId('plan-review')).toBeDefined();
    // Appears twice: the user's request and the plan's goal.
    expect(screen.getAllByText('Add a pricing page').length).toBeGreaterThanOrEqual(2);
    // The path is named in both "Will create" and "Intended files" (Step 35
    // added the create list), so the assertion counts rather than assumes one.
    expect(screen.getAllByText(/src\/pages\/Pricing\.tsx/).length).toBeGreaterThanOrEqual(1);
    // No changes claimed yet.
    expect(screen.queryByTestId('run-changes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() =>
      expect(vi.mocked(codingApi.submitCodingDecision)).toHaveBeenCalledWith('run-1', 'approve'),
    );

    const changes = await screen.findByTestId('run-changes');
    expect(changes.textContent).toContain('src/pages/Pricing.tsx');
    expect(changes.textContent).toContain('Created the pricing page.');
  });

  it('does not claim a run finished when the agent rejects the approval', async () => {
    vi.mocked(codingApi.submitCodingDecision).mockRejectedValue(
      new ApiError(409, 'CODING_INVALID_STATE', 'This run is not awaiting approval.'),
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Portfolio site', level: 1 });
    fireEvent.change(screen.getByLabelText('What should the builder do?'), {
      target: { value: 'Add a pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByTestId('plan-review');
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));

    expect(await screen.findByText('This run is not awaiting approval.')).toBeDefined();
    expect(screen.queryByTestId('run-changes')).toBeNull();
  });

  it('loads a file read-only when one is picked from the overview', async () => {
    renderPage();
    const chips = await screen.findAllByRole('button', { name: 'src/pages/Home.tsx' });
    fireEvent.click(chips[0] as HTMLElement);
    await waitFor(() =>
      expect(vi.mocked(sourceApi.fetchFile)).toHaveBeenCalledWith(
        'proj-1',
        'src/pages/Home.tsx',
        'ws-1',
      ),
    );
    const code = await screen.findByLabelText('Contents of src/pages/Home.tsx');
    expect(code.textContent).toContain('export default function Home() {}');
    expect(screen.getByText(/read-only preview/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    expect(await screen.findByRole('heading', { name: 'Portfolio site', level: 1 })).toBeDefined();
  });

  it('switches panels on a phone-width layout', async () => {
    renderPage();
    const container = await screen.findByTestId('frontend-builder');
    expect(container.className).toContain('v-fbuilder--panel-builder');
    fireEvent.click(screen.getByRole('button', { name: 'AI chat' }));
    expect(container.className).toContain('v-fbuilder--panel-chat');
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(container.className).toContain('v-fbuilder--panel-files');
  });

  it('tells the user a project without a workspace cannot be built yet', async () => {
    vi.mocked(workspacesApi.listWorkspaces).mockResolvedValue([]);
    renderPage();
    await screen.findByRole('heading', { name: 'Portfolio site', level: 1 });
    fireEvent.change(screen.getByLabelText('What should the builder do?'), {
      target: { value: 'Add a page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText(/no workspace yet, so the coding agent has nowhere to write/i),
    ).toBeDefined();
    expect(vi.mocked(codingApi.startCodingRun)).not.toHaveBeenCalled();
  });

  it('refuses to render without a project id', async () => {
    renderPage(null);
    expect(await screen.findByText('No project was selected.')).toBeDefined();
  });
});
