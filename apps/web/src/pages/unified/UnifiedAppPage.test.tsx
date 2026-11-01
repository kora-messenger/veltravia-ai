// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { UnifiedAppPage } from './UnifiedAppPage';
import { ChangeReview } from './UnifiedSections';
import * as codingApi from '../../api/coding';
import * as sourceApi from '../../api/source';
import * as unifiedApi from '../../api/unified';
import { ApiError } from '../../api/client';

vi.mock('../../api/unified', () => ({
  fetchUnifiedApp: vi.fn(),
  fetchUnifiedCapabilities: vi.fn(),
  groupPaths: vi.fn(),
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
vi.mock('../../api/source', () => ({
  fetchFile: vi.fn(),
  fetchHistory: vi.fn(),
}));

function fact(
  status: unifiedApi.UnifiedStatus,
  detail = 'detail',
  evidence: string[] = [],
): unifiedApi.StatusFact {
  const labels: Record<unifiedApi.UnifiedStatus, string> = {
    configured: 'Configured',
    detected: 'Detected',
    tested: 'Tested',
    running: 'Running',
    unavailable: 'Unavailable',
    'not-configured': 'Not configured',
  };
  return { status, label: labels[status], detail, evidence };
}

function buildView(overrides: Partial<unifiedApi.UnifiedAppView> = {}): unifiedApi.UnifiedAppView {
  const health: unifiedApi.AppHealth = {
    frontend: fact('detected', '3 frontend file(s) classified as a component-based layout.'),
    backend: fact('detected', '2 route(s) and 1 model(s) were read from 2 backend file(s).'),
    apiRoutes: fact('detected', '2 route declaration(s) recognised across 1 file(s).'),
    database: fact('configured', 'A database provider is declared (Prisma) with 1 model(s).'),
    tests: fact('detected', '1 test file(s) found. No test run is recorded.'),
    runtime: fact('unavailable', 'No runtime has been started for this workspace.'),
    errors: [],
    warnings: ['1 frontend request(s) have no matching backend route in the files that were read.'],
    inspectedCompletely: true,
  };

  return {
    project: {
      id: 'prj-1',
      name: 'Unified demo',
      description: 'One project, both layers.',
      projectType: 'fullstack',
      status: 'active',
      updatedAt: '2026-11-01T09:00:00.000Z',
    },
    workspace: { id: 'ws-1', name: 'ws-1', branch: '', revision: 12 },
    source: { rootRevision: 12, files: 6, directories: 3, bytes: 900 },
    overview: {
      project: {
        id: 'prj-1',
        name: 'Unified demo',
        description: 'One project, both layers.',
        projectType: 'fullstack',
        status: 'active',
        updatedAt: '2026-11-01T09:00:00.000Z',
      },
      workspace: { id: 'ws-1', name: 'ws-1', branch: '', revision: 12 },
      stack: { framework: 'react', language: 'typescript', runtime: null, source: 'detected' },
      counts: {
        files: 6,
        bytes: 900,
        frontendFiles: 3,
        backendFiles: 2,
        configurationFiles: 1,
        testFiles: 1,
        apiRoutes: 2,
        models: 1,
        requestSites: 2,
        matchedLinks: 1,
      },
      recentChanges: [
        { path: 'src/routes/users.ts', action: 'created', at: '2026-11-01T09:00:00.000Z' },
      ],
      lastUpdated: '2026-11-01T09:00:00.000Z',
      notes: [],
    },
    health,
    files: {
      groups: [
        {
          group: 'frontend',
          label: 'Frontend',
          count: 1,
          files: [{ path: 'src/components/UserList.tsx', size: 100, group: 'frontend' }],
          omitted: 0,
        },
        {
          group: 'backend',
          label: 'Backend',
          count: 1,
          files: [{ path: 'src/routes/users.ts', size: 200, group: 'backend' }],
          omitted: 0,
        },
      ],
      totals: { files: 6, bytes: 900 },
    },
    links: {
      links: [
        {
          kind: 'frontend-request',
          from: { label: 'GET /api/users', file: 'src/components/UserList.tsx', line: 3 },
          to: { label: 'GET /api/users', file: 'src/routes/users.ts', line: 4 },
          method: 'GET',
          path: '/api/users',
          confidence: 'exact',
          evidence: "fetch('/api/users')",
        },
        {
          kind: 'route-handler',
          from: { label: 'GET /api/users', file: 'src/routes/users.ts', line: 4 },
          to: { label: 'listUsers', file: 'src/routes/users.ts', line: 4 },
          method: 'GET',
          path: '/api/users',
          confidence: 'exact',
          evidence: "app.get('/api/users', listUsers);",
        },
        {
          kind: 'handler-model',
          from: { label: 'listUsers', file: 'src/routes/users.ts', line: 5 },
          to: { label: 'User', file: 'prisma/schema.prisma', line: 1 },
          method: 'GET',
          path: '/api/users',
          confidence: 'exact',
          evidence: 'prisma.user.findMany()',
        },
      ],
      requests: 2,
      unmatchedRequests: [
        {
          file: 'src/components/UserList.tsx',
          line: 4,
          method: null,
          url: '/api/invoices',
          reason: 'no-matching-route',
        },
      ],
      routesWithoutCaller: [{ method: 'POST', path: '/api/users' }],
      note: 'An unmatched route is not an error.',
    },
    ...overrides,
  };
}

const capabilities: unifiedApi.UnifiedCapabilities = {
  readOnly: true,
  sections: { overview: 'implemented' },
  composition: {
    sourceOfTruth: 'the project engine',
    duplicateStores: false,
    secondAiSystem: false,
    scans: 'bounded',
  },
  unavailable: ['deployment', 'database connections'],
  writes: 'coding-agent-run-with-human-approval',
};

const codingCaps: codingApi.CodingCapabilities = {
  decisionSource: 'scripted-demo',
  planApprovalRequired: true,
  toolConfirmationsRequired: true,
};

beforeEach(() => {
  vi.mocked(unifiedApi.fetchUnifiedApp).mockResolvedValue(buildView());
  vi.mocked(unifiedApi.fetchUnifiedCapabilities).mockResolvedValue(capabilities);
  vi.mocked(unifiedApi.groupPaths).mockResolvedValue({
    'src/components/UserList.tsx': 'frontend',
    'src/routes/users.ts': 'backend',
  } as unknown as Readonly<Record<string, unifiedApi.FileGroup>>);
  vi.mocked(codingApi.fetchCodingCapabilities).mockResolvedValue(codingCaps);
  vi.mocked(sourceApi.fetchHistory).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(projectId = 'prj-1') {
  return render(
    <ToastProvider>
      <UnifiedAppPage projectId={projectId} />
    </ToastProvider>,
  );
}

describe('unified workspace: overview', () => {
  it('shows the project facts and the measured counts', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Unified demo' })).toBeDefined();
    await waitFor(() => expect(screen.getByText('fullstack')).toBeDefined());
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getAllByText('Detected').length).toBeGreaterThan(0);
    expect(screen.getByText('No runtime has been started for this workspace.')).toBeDefined();
    expect(screen.getAllByText(/no matching backend route/i).length).toBeGreaterThan(0);
  });

  it('says the stack is unknown instead of guessing', async () => {
    const view = buildView();
    view.overview.stack = { framework: null, language: null, runtime: null, source: 'unknown' };
    view.overview.notes = [
      'No manifest or entry point identified the stack, so framework and language are unknown.',
    ];
    vi.mocked(unifiedApi.fetchUnifiedApp).mockResolvedValue(view);
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByText(/framework and language are unknown/i)).toBeDefined();
  });

  it('reports a failed load honestly with a retry', async () => {
    vi.mocked(unifiedApi.fetchUnifiedApp).mockRejectedValueOnce(
      new ApiError(
        404,
        'PROJECT_NOT_FOUND',
        'This project no longer exists or could not be found.',
      ),
    );
    renderPage();
    expect(await screen.findByText(/could not be found/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('shows a missing project selection instead of loading forever', async () => {
    renderPage(null as unknown as string);
    expect(await screen.findByText(/no project was selected/i)).toBeDefined();
  });
});

describe('unified workspace: navigation', () => {
  it('lists every section in the rail and the mobile picker', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    const rail = screen.getByRole('navigation', { name: /application sections/i });
    const railButtons = Array.from(rail.querySelectorAll('button')).map(
      (button) => button.textContent,
    );
    expect(railButtons).toEqual([
      'Overview',
      'Build',
      'Frontend',
      'Backend',
      'Database',
      'API routes',
      'Files',
      'AI assistant',
      'Project settings',
    ]);
    const select = screen.getByRole('combobox');
    expect(select.querySelectorAll('option')).toHaveLength(9);
  });

  it('moves between frontend and backend without losing the project', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.click(screen.getByRole('button', { name: 'Backend' }));
    expect(await screen.findByRole('heading', { name: 'Backend' })).toBeDefined();
    expect(screen.getByRole('button', { name: /open the backend builder/i })).toBeDefined();
    // The project identity is in the URL of both layer builders.
    const projectHeading = screen.getByRole('heading', { level: 1, name: 'Unified demo' });
    expect(projectHeading).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Frontend' }));
    expect(await screen.findByRole('button', { name: /open the frontend builder/i })).toBeDefined();
  });

  it('switches sections through the mobile picker', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'settings' } });
    expect(await screen.findByRole('heading', { name: 'Project settings' })).toBeDefined();
  });
});

describe('unified workspace: files', () => {
  it('groups the real paths and reads a file read-only', async () => {
    vi.mocked(sourceApi.fetchFile).mockResolvedValue({
      path: 'src/components/UserList.tsx',
      revision: 3,
      size: 42,
      contentHash: 'hash',
      content: 'export function UserList() {}',
      truncated: false,
    });
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() =>
      expect(document.querySelector('.v-uapp__groups')?.textContent).toContain('Frontend'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'src/components/UserList.tsx' }));
    expect(await screen.findByText(/export function UserList/)).toBeDefined();
    expect(sourceApi.fetchFile).toHaveBeenCalledWith('prj-1', 'src/components/UserList.tsx');
    expect(screen.getByText(/revision 3/)).toBeDefined();
  });

  it('reports a file that cannot be read without breaking the section', async () => {
    vi.mocked(sourceApi.fetchFile).mockRejectedValueOnce(
      new ApiError(404, 'NOT_FOUND', 'File missing.'),
    );
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'src/routes/users.ts' }));
    expect(await screen.findByText(/file missing/i)).toBeDefined();
  });
});

describe('unified workspace: cross-layer view', () => {
  it('lists routes, callers and unmatched requests', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.click(screen.getByRole('button', { name: 'API routes' }));
    expect(await screen.findByText('/api/users')).toBeDefined();
    expect(screen.getByText(/1 caller\(s\) found/)).toBeDefined();
    expect(screen.getByText('/api/invoices')).toBeDefined();
    expect(screen.getByText(/no route serves this path/i)).toBeDefined();
    expect(screen.getByText('User')).toBeDefined();
  });

  it('renders one entry per relationship without duplicate keys', async () => {
    // Live QA caught a real bug: the same file and model produce one edge per
    // route, and keying on file+model alone made React warn about duplicates.
    const view = buildView();
    const base = view.links.links.find((link) => link.kind === 'handler-model');
    if (base === undefined) throw new Error('fixture missing a handler-model link');
    view.links = {
      ...view.links,
      links: [
        ...view.links.links,
        { ...base, method: 'POST', path: '/api/users' },
        { ...base, method: 'DELETE', path: '/api/users/:id' },
      ],
    };
    vi.mocked(unifiedApi.fetchUnifiedApp).mockResolvedValue(view);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.click(screen.getByRole('button', { name: 'API routes' }));
    await screen.findAllByText('User');

    const duplicateKeys = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('same key'));
    expect(duplicateKeys).toHaveLength(0);
    errors.mockRestore();
  });

  it('opens the file behind a relationship', async () => {
    vi.mocked(sourceApi.fetchFile).mockResolvedValue({
      path: 'src/routes/users.ts',
      revision: 1,
      size: 10,
      contentHash: 'h',
      content: "app.get('/api/users');",
      truncated: false,
    });
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Unified demo' });
    fireEvent.click(screen.getByRole('button', { name: 'API routes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'src/routes/users.ts:4' }));
    expect(await screen.findByText(/app.get/)).toBeDefined();
  });
});

describe('unified workspace: change review', () => {
  it('splits a plan into layers and keeps the approval gate', async () => {
    const run: codingApi.CodingRunView = {
      runId: 'run-1',
      projectId: 'prj-1',
      workspaceId: 'ws-1',
      state: 'awaiting_approval',
      summary: null,
      changedFiles: [],
      iterations: 0,
      toolCalls: 0,
      startedAt: '2026-11-01T09:00:00.000Z',
      updatedAt: '2026-11-01T09:00:00.000Z',
      pendingApproval: { kind: 'plan_approval' },
      plan: {
        goal: 'Add invoices',
        steps: ['Read the routes file', 'Add the endpoint'],
        filesToInspect: ['src/routes/users.ts'],
        filesToModify: ['src/components/UserList.tsx'],
        validations: [],
        acceptanceCriteria: [],
      },
      failure: null,
    };
    const onApprove = vi.fn();
    render(
      <ChangeReview
        projectId="prj-1"
        run={run}
        decisionsPending={false}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Frontend/)).toBeDefined();
    expect(screen.getByText(/will be modified/)).toBeDefined();
    expect(screen.getByText(/will be inspected/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /approve plan/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(unifiedApi.groupPaths).toHaveBeenCalledWith('prj-1', [
      'src/components/UserList.tsx',
      'src/routes/users.ts',
    ]);
  });

  it('says nothing is written when no plan is waiting', async () => {
    render(
      <ChangeReview
        projectId="prj-1"
        run={null}
        decisionsPending={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(/no plan is waiting/i)).toBeDefined();
  });
});
