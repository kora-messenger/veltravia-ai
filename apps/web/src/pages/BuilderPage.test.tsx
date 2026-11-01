// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ui';
import { BuilderPage } from './BuilderPage';
import * as api from '../api/app-builder';
import { ApiError } from '../api/client';

vi.mock('../api/app-builder', () => ({
  fetchRegistry: vi.fn(),
  validateSpecification: vi.fn(),
  detectStack: vi.fn(),
  createPlan: vi.fn(),
  materializePlan: vi.fn(),
}));

const registry: readonly api.TechnologyView[] = [
  {
    kind: 'framework',
    id: 'react',
    name: 'React',
    layer: 'frontend',
    versions: ['19'],
    supportLevel: 'scaffold',
    build: { argv: ['npm', 'run', 'build'], description: 'Bundle', maxSeconds: 300 },
    test: { argv: ['npm', 'test'], description: 'Test', maxSeconds: 300 },
    preview: { mode: 'static', ports: [4173], note: 'Static preview' },
    deployment: { targets: ['static-hosting'], note: 'Static bundle' },
    unsupported: ['server rendering'],
    languageId: 'javascript',
    projectKinds: ['web', 'fullstack'],
  },
  {
    kind: 'language',
    id: 'kotlin',
    name: 'Kotlin',
    layer: 'mobile',
    versions: ['2.0'],
    supportLevel: 'planned',
    build: { argv: ['gradle', 'assemble'], description: 'Assemble', maxSeconds: 900 },
    test: { argv: ['gradle', 'test'], description: 'Test', maxSeconds: 900 },
    preview: { mode: 'device-emulator', ports: [], note: 'Emulator required' },
    deployment: { targets: ['app-store'], note: 'Store artefacts' },
    unsupported: ['web preview'],
  },
];

const plan: api.ScaffoldPlanView = {
  id: 'plan-1',
  status: 'planned',
  createdAt: '2026-11-01T00:00:00.000Z',
  specification: { name: 'Ledger service', projectKind: 'web' },
  review: {
    valid: true,
    issues: [],
    resolved: [{ id: 'react', name: 'React', role: 'frontend', supportLevel: 'scaffold' }],
    supportLevel: 'scaffold',
    unsupported: [],
    notes: [],
  },
  files: [
    {
      path: 'src/App.tsx',
      description: 'Root component',
      content: 'export const App = () => null;',
    },
  ],
  buildCommand: { argv: ['npm', 'run', 'build'], description: 'Bundle', maxSeconds: 300 },
  testCommand: { argv: ['npm', 'test'], description: 'Test', maxSeconds: 300 },
  preview: { mode: 'static', ports: [4173], note: 'Static preview' },
};

function renderPage() {
  return render(
    <ToastProvider>
      <BuilderPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.fetchRegistry).mockResolvedValue(registry);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('app builder page', () => {
  it('lists the registry with its own support levels', async () => {
    renderPage();
    expect(await screen.findByText('Technology registry')).toBeDefined();
    expect(await screen.findByText('React')).toBeDefined();
    expect(screen.getAllByText('Starter files').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Declared only').length).toBeGreaterThan(0);
  });

  it('says so when the registry cannot be loaded', async () => {
    vi.mocked(api.fetchRegistry).mockRejectedValueOnce(new Error('offline'));
    renderPage();
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeDefined();
  });

  it('renders validation issues instead of silently accepting a bad spec', async () => {
    vi.mocked(api.validateSpecification).mockResolvedValue({
      valid: false,
      issues: [
        { path: 'stack', code: 'missing-stack', message: 'Add a frontend.', severity: 'error' },
      ],
      resolved: [],
      supportLevel: 'planned',
      unsupported: [],
      notes: [],
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Ledger service'), {
      target: { value: 'Ledger service' },
    });
    fireEvent.click(screen.getByRole('button', { name: /validate specification/i }));

    expect(await screen.findByText('Needs fixing')).toBeDefined();
    expect(await screen.findByText(/Add a frontend\./)).toBeDefined();
  });

  it('refuses to detect from an empty manifest', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /detect stack/i }));
    expect(await screen.findByText(/at least one file path/i)).toBeDefined();
    expect(vi.mocked(api.detectStack)).not.toHaveBeenCalled();
  });

  it('shows the detected stack and unknown languages', async () => {
    vi.mocked(api.detectStack).mockResolvedValue({
      projects: [],
      languages: [{ id: 'javascript', name: 'JavaScript', confidence: 0.6 }],
      frameworks: [{ id: 'react', name: 'React', confidence: 0.5 }],
      unknownLanguages: ['Lua'],
      unrecognisedFiles: 3,
      notes: ['Detected React, which the platform can name but cannot yet build.'],
    });
    renderPage();
    fireEvent.change(screen.getByLabelText(/file paths to inspect/i), {
      target: { value: 'package.json\nsrc/App.tsx' },
    });
    fireEvent.click(screen.getByRole('button', { name: /detect stack/i }));

    expect(await screen.findByText(/Frameworks: React/)).toBeDefined();
    expect(await screen.findByText(/Not in the registry yet: Lua/)).toBeDefined();
  });

  it('surfaces a refusal rather than pretending a plan exists', async () => {
    vi.mocked(api.createPlan).mockRejectedValue(
      new ApiError(
        409,
        'APP_BUILDER_UNSUPPORTED_TECHNOLOGY',
        'Kotlin has no starter template yet.',
      ),
    );
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Ledger service'), {
      target: { value: 'Ledger service' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create starter plan/i }));
    expect(await screen.findByText(/no starter template yet/i)).toBeDefined();
  });

  it('states that declared commands were not run', async () => {
    vi.mocked(api.createPlan).mockResolvedValue(plan);
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Ledger service'), {
      target: { value: 'Ledger service' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create starter plan/i }));

    expect(await screen.findByText(/Build: npm run build/)).toBeDefined();
    expect(await screen.findByText(/does not run them/i)).toBeDefined();
  });

  it('reports the created project after materializing', async () => {
    vi.mocked(api.createPlan).mockResolvedValue(plan);
    vi.mocked(api.materializePlan).mockResolvedValue({
      projectId: 'prj-1',
      workspaceId: 'ws-1',
      createdFiles: ['src/App.tsx'],
      createdDirectories: ['src'],
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Ledger service'), {
      target: { value: 'Ledger service' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create starter plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create project from plan/i }));

    await waitFor(() => expect(vi.mocked(api.materializePlan)).toHaveBeenCalledWith('plan-1'));
    expect((await screen.findAllByText(/Created project/)).length).toBeGreaterThan(0);
  });
});
