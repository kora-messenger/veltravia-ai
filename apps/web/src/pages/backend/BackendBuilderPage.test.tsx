// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { BackendBuilderPage } from './BackendBuilderPage';
import * as backendApi from '../../api/backend';
import * as codingApi from '../../api/coding';
import * as projectsApi from '../../api/projects';
import * as sourceApi from '../../api/source';
import * as workspacesApi from '../../api/workspaces';
import { ApiError } from '../../api/client';

vi.mock('../../api/backend', () => ({
  fetchBackendReport: vi.fn(),
  fetchBackendCapabilities: vi.fn(),
}));
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
  name: 'Billing service',
  description: 'A backend.',
  projectType: 'backend',
  status: 'active',
  version: 3,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

const workspace: workspacesApi.WorkspaceView = {
  id: 'ws-1',
  projectId: 'proj-1',
  name: 'main',
  status: 'active',
  revision: 6,
  createdAt: '2026-10-01T09:05:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

const report: backendApi.BackendReport = {
  structure: {
    layout: 'node',
    framework: 'fastify',
    language: 'TypeScript',
    runtime: 'Node.js 22',
    totals: { files: 9, bytes: 4096 },
    sections: [
      {
        section: 'routes',
        label: 'Routes',
        count: 2,
        files: [{ path: 'src/routes.ts', size: 512 }],
        omitted: 0,
      },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/api/invoices',
      file: 'src/routes/invoices.ts',
      line: 12,
      handler: 'listInvoices',
      auth: 'declared',
      source: 'express-fastify',
      evidence: "app.get('/api/invoices', { preHandler: requireAuth }, listInvoices);",
    },
    {
      method: 'POST',
      path: '/api/invoices',
      file: 'src/routes/invoices.ts',
      line: 20,
      handler: 'createInvoice',
      auth: 'unknown',
      source: 'express-fastify',
      evidence: "app.post('/api/invoices', createInvoice);",
    },
  ],
  models: [
    {
      name: 'Invoice',
      source: 'prisma',
      file: 'prisma/schema.prisma',
      line: 4,
      fields: [
        {
          name: 'id',
          type: 'String',
          required: true,
          primaryKey: true,
          unique: false,
          references: null,
        },
        {
          name: 'total',
          type: 'Int',
          required: true,
          primaryKey: false,
          unique: false,
          references: null,
        },
      ],
      indexes: ['customerId'],
      relationships: [
        {
          field: 'customer',
          target: 'Customer',
          cardinality: 'single',
          derivedFrom: 'prisma-relation',
        },
      ],
    },
  ],
  functions: [
    {
      name: 'send-receipt',
      file: 'netlify/functions/send-receipt.ts',
      kind: 'serverless-function',
      runtime: null,
      inputSchema: 'not-declared',
      outputSchema: 'not-declared',
      evidence: 'export const handler = async () => ({ statusCode: 200 });',
    },
  ],
  environment: [
    { name: 'DATABASE_URL', sources: ['.env.example'], kind: 'template' },
    { name: 'STRIPE_KEY', sources: ['src/config/env.ts'], kind: 'code' },
  ],
  auth: {
    status: 'declared',
    provider: 'JSON Web Tokens (jsonwebtoken)',
    evidence: ['jsonwebtoken declared in package.json'],
    loginMethods: ['password'],
    sessionStrategy: 'not-inspected',
    protectedRoutes: 1,
    userModel: 'Invoice',
    note: 'A library is declared; whether a route actually rejects an unauthenticated request was not tested.',
  },
  database: {
    status: 'declared',
    provider: 'Prisma',
    connection: 'not-configured',
    evidence: ['@prisma/client declared in package.json'],
    models: 1,
    note: 'The schema is read from the project files. No connection string is read and no query is run.',
  },
  logs: {
    available: false,
    reason: 'No log source is connected to this project in this release.',
    entries: [],
    redaction: 'applied-when-available',
  },
  manifests: [
    { file: 'package.json', dependencies: ['fastify', '@prisma/client', 'jsonwebtoken'] },
  ],
  recentChanges: [
    { path: 'src/routes/invoices.ts', changeKind: 'updated', at: '2026-10-30T10:00:00.000Z' },
  ],
  scanned: { files: 9, read: 7, skipped: 2, truncated: false },
  warnings: ['2 files were beyond the read budget and were not inspected.'],
};

const capabilities: backendApi.BackendCapabilities = {
  readOnly: true,
  sections: {
    overview: 'implemented',
    routes: 'implemented',
    database: 'inspection-only',
    models: 'implemented',
    functions: 'inspection-only',
    auth: 'inspection-only',
    environment: 'names-only',
    logs: 'unavailable',
  },
  extraction: {
    frameworks: ['express-http'],
    modelFormats: ['prisma'],
    environmentValues: 'never-read',
    logSources: 'none-connected',
  },
  unavailable: ['database connections', 'migrations', 'function execution', 'log streaming'],
  writes: 'coding-agent-run-with-human-approval',
};

const codingCapabilities: codingApi.CodingCapabilities = {
  decisionSource: 'scripted-demo',
  planApprovalRequired: true,
  toolConfirmationsRequired: true,
  states: [],
} as unknown as codingApi.CodingCapabilities;

function renderPage(projectId: string | null = 'proj-1') {
  return render(
    <ToastProvider>
      <BackendBuilderPage projectId={projectId} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(projectsApi.getProject).mockResolvedValue(project);
  vi.mocked(workspacesApi.listWorkspaces).mockResolvedValue([workspace]);
  vi.mocked(sourceApi.fetchHistory).mockResolvedValue([]);
  vi.mocked(sourceApi.fetchTree).mockResolvedValue({
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    rootRevision: 6,
    files: [],
    directories: [],
    totals: { files: 0, bytes: 0 },
  });
  vi.mocked(backendApi.fetchBackendReport).mockResolvedValue(report);
  vi.mocked(backendApi.fetchBackendCapabilities).mockResolvedValue(capabilities);
  vi.mocked(codingApi.fetchCodingCapabilities).mockResolvedValue(codingCapabilities);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BackendBuilderPage', () => {
  it('renders the overview with the stack it actually read', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Billing service', level: 1 })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Detected backend' })).toBeDefined();
    expect(screen.getByText('fastify')).toBeDefined();
    expect(screen.getByText('Node.js 22')).toBeDefined();
    expect(screen.getByText(/7 of 9/)).toBeDefined();
  });

  it('shows the reading caveats rather than hiding them', async () => {
    renderPage();
    expect(await screen.findByText(/2 files were beyond the read budget/)).toBeDefined();
    expect(screen.getByText(/2 beyond the read budget/)).toBeDefined();
  });

  it('lists routes with their guard state and opens the declaration on click', async () => {
    renderPage();
    const nav = await screen.findByRole('navigation', { name: 'Backend sections' });
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));

    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('/api/invoices');
    expect(screen.getAllByText('guarded')).toHaveLength(1);
    expect(screen.getAllByText('unknown')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'src/routes/invoices.ts:12' }));
    const detail = await screen.findByTestId('route-detail');
    expect(detail.textContent).toContain('listInvoices');
    expect(detail.textContent).toContain('express-fastify');
    expect(detail.textContent).toContain("app.get('/api/invoices'");
    expect(nav.textContent).not.toContain('undefined');
  });

  it('says plainly that a missing guard is not proof a route is open', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing service', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'src/routes/invoices.ts:20' }));
    const detail = await screen.findByTestId('route-detail');
    expect(detail.textContent).toContain('not proof the route is open');
  });

  it('filters routes and reports an honest empty filter result', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing service', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    const filter = await screen.findByLabelText('Filter routes');
    fireEvent.change(filter, { target: { value: 'nothing-matches' } });
    expect(await screen.findByText('No matching routes')).toBeDefined();
  });

  it('never claims a database connection exists', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing service', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Database/ }));
    expect(
      await screen.findByText(/not configured — this release opens no database connection/),
    ).toBeDefined();
    expect(screen.queryByText(/connected/i)).toBeNull();
  });

  it('shows model fields with provenance', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing service', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Models/ }));
    expect(await screen.findByRole('heading', { name: 'Invoice' })).toBeDefined();
    expect(screen.getByText('prisma/schema.prisma:4')).toBeDefined();
    expect(screen.getByText('primary key')).toBeDefined();
    expect(screen.getByText(/customer → Customer \(single\)/)).toBeDefined();
  });

  it('shows environment variable names only, with no value column', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing service', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Environment/ }));
    expect(await screen.findByText('DATABASE_URL')).toBeDefined();
    expect(screen.getByText(/Values are never read, stored or shown/)).toBeDefined();
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'Kind', 'Referenced in']);
  });

  it('states that logs are unavailable instead of drawing an empty log view', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing service', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Logs/ }));
    expect(await screen.findByText('No log source connected')).toBeDefined();
    expect(screen.getByText(/No log source is connected to this project/)).toBeDefined();
  });

  it('lists what this release cannot do on the overview', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'What this release does not do' }),
    ).toBeDefined();
    expect(screen.getByText('database connections')).toBeDefined();
  });

  it('flags a scripted demo agent in the AI panel', async () => {
    renderPage();
    expect(await screen.findByText('scripted demo agent')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'AI backend engineer' })).toBeDefined();
  });

  it('surfaces a read failure with a retry instead of an empty screen', async () => {
    vi.mocked(backendApi.fetchBackendReport).mockRejectedValue(
      new ApiError('The backend could not be read.', 500, 'BACKEND_SCAN_FAILED'),
    );
    renderPage();
    expect(await screen.findByText('Could not read the backend')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('retries the read when the retry button is used', async () => {
    vi.mocked(backendApi.fetchBackendReport).mockRejectedValueOnce(
      new ApiError('The backend could not be read.', 500, 'BACKEND_SCAN_FAILED'),
    );
    renderPage();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    await waitFor(() => expect(vi.mocked(backendApi.fetchBackendReport).mock.calls.length).toBe(2));
  });

  it('asks for a workspace instead of scanning nothing when there is none', async () => {
    vi.mocked(workspacesApi.listWorkspaces).mockResolvedValue([]);
    vi.mocked(backendApi.fetchBackendReport).mockResolvedValue({
      ...report,
      routes: [],
      models: [],
      functions: [],
      environment: [],
      scanned: { files: 0, read: 0, skipped: 0, truncated: false },
    });
    renderPage();
    expect(await screen.findByText('no workspace')).toBeDefined();
  });

  it('shows an error when no project was selected', async () => {
    renderPage(null);
    expect(await screen.findByText('Could not open this project')).toBeDefined();
  });
});
