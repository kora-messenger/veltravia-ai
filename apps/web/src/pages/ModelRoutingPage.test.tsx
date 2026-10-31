// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../api/client';
import { ModelRoutingPage } from './ModelRoutingPage';
import * as api from '../api/model-router';

vi.mock('../api/model-router', async () => {
  const actual = await vi.importActual<typeof import('../api/model-router')>('../api/model-router');
  return {
    ...actual,
    getOverview: vi.fn(),
    listDecisions: vi.fn(),
    routeTask: vi.fn(),
    savePreferences: vi.fn(),
  };
});

const model: api.RouterModel = {
  providerId: 'openai',
  providerName: 'OpenAI',
  connectionId: 'conn-1',
  connectionName: 'Work key',
  modelId: 'gpt-test-mini',
  displayName: 'gpt-test-mini',
  capabilities: ['text-generation', 'streaming'],
  capabilitySource: 'catalog',
  contextWindowTokens: 128000,
  streaming: true,
  available: true,
  unavailableReason: null,
  discoverySource: 'connection',
  lastValidatedAt: null,
};

const preferences: api.RouterPreferences = {
  ownerRef: 'web-owner',
  autoSelect: true,
  preference: 'balanced',
  defaultModel: null,
  allowFallback: false,
  taskPreferences: {},
  projectPreferences: {},
  updatedAt: '2026-10-31T09:00:00.000Z',
};

function overview(overrides: Partial<api.RouterOverview> = {}): api.RouterOverview {
  return {
    categories: [
      {
        category: 'general-conversation',
        displayName: 'Conversation',
        description: 'Chat and everyday questions.',
        required: ['text-generation'],
        supported: true,
        modelCount: 1,
        reason: null,
      },
      {
        category: 'video-understanding',
        displayName: 'Video understanding',
        description: 'Watch and describe a video.',
        required: ['audio-input', 'vision'],
        supported: false,
        modelCount: 0,
        reason: 'No connected adapter can read video yet.',
      },
    ],
    catalog: [model],
    catalogNotes: [],
    capabilityCounts: { 'text-generation': 1 },
    providerCount: 1,
    preferences,
    persistence: 'Routing preferences are held in memory for this server process.',
    ...overrides,
  };
}

const decision: api.RoutingDecision = {
  id: 'rte_1',
  category: 'general-conversation',
  mode: 'automatic',
  outcome: 'routed',
  requestedAt: '2026-10-31T09:00:00.000Z',
  selected: {
    connectionId: 'conn-1',
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-test-mini',
    displayName: 'gpt-test-mini',
    contextWindowTokens: 128000,
    streaming: true,
    capabilitySource: 'catalog',
  },
  summary:
    'Using gpt-test-mini through OpenAI because it is the only connected model that declares what Conversation needs.',
  capabilitiesRequired: ['text-generation'],
  preference: 'balanced',
  decidedBy: 'automatic',
  rejected: [],
  warnings: [],
  fallback: { policy: 'none', used: false, replaced: null },
  costComparison: 'not-requested',
  contextWindowTokens: 128000,
  audit: {
    candidateCount: 1,
    consideredCount: 1,
    rejectedCount: 0,
    missingEvidence: [],
    durationMs: 1,
  },
};

beforeEach(() => {
  vi.mocked(api.getOverview).mockResolvedValue(overview());
  vi.mocked(api.listDecisions).mockResolvedValue({
    decisions: [],
    persistence: preferences.ownerRef,
  });
  vi.mocked(api.routeTask).mockResolvedValue({ decision });
  vi.mocked(api.savePreferences).mockResolvedValue({
    preferences,
    persistence: preferences.ownerRef,
    appliedToExecution: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('model routing page', () => {
  it('lists the connected models with their capability source', async () => {
    render(<ModelRoutingPage />);
    expect(await screen.findByRole('heading', { name: 'Model routing' })).toBeDefined();
    expect(await screen.findByText('gpt-test-mini')).toBeDefined();
    expect(screen.getByText(/capabilities from the provider catalog/)).toBeDefined();
    expect(screen.getByText(/128,000 token window/)).toBeDefined();
  });

  it('shows what a model cannot do instead of hiding the task', async () => {
    render(<ModelRoutingPage />);
    // The task name appears on its card and in the task picker; the point of the
    // test is the honest "cannot do this" sentence, not the count of headings.
    expect((await screen.findAllByText('Video understanding')).length).toBeGreaterThan(0);
    expect(screen.getByText('No connected adapter can read video yet.')).toBeDefined();
  });

  it('explains a decision in plain language', async () => {
    render(<ModelRoutingPage />);
    await screen.findByText('gpt-test-mini');
    fireEvent.click(screen.getByRole('button', { name: 'Explain the choice' }));
    expect(await screen.findByText(decision.summary)).toBeDefined();
    expect(screen.getByText(/Decided by: it was the best fit/)).toBeDefined();
    expect(api.routeTask).toHaveBeenCalledWith({ category: 'general-conversation' });
  });

  it('sends the project id when one is typed', async () => {
    render(<ModelRoutingPage />);
    await screen.findByText('gpt-test-mini');
    fireEvent.change(screen.getByPlaceholderText('prj_…'), {
      target: { value: 'prj_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Explain the choice' }));
    await waitFor(() => expect(api.routeTask).toHaveBeenCalled());
    expect(vi.mocked(api.routeTask).mock.calls[0]?.[0]).toMatchObject({ projectId: 'prj_123' });
  });

  it('reports a saving failure instead of pretending it worked', async () => {
    vi.mocked(api.savePreferences).mockRejectedValue(
      new ApiError(409, 'ROUTER_NO_PROVIDER_AVAILABLE', 'Model routing is unavailable.'),
    );
    render(<ModelRoutingPage />);
    await screen.findByText('gpt-test-mini');
    fireEvent.click(screen.getByRole('switch', { name: /Choose a model automatically/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Model routing is unavailable.');
  });

  it('says honestly when a preference could not reach execution', async () => {
    vi.mocked(api.savePreferences).mockResolvedValue({
      preferences,
      persistence: 'in memory',
      appliedToExecution: false,
      mirrorNote: 'could not be applied to the provider gateway yet.',
    });
    render(<ModelRoutingPage />);
    await screen.findByText('gpt-test-mini');
    fireEvent.click(screen.getByRole('switch', { name: /Choose a model automatically/i }));
    expect(
      await screen.findByText(/could not be applied to the provider gateway yet/),
    ).toBeDefined();
  });

  it('explains an empty catalog instead of showing a blank page', async () => {
    vi.mocked(api.getOverview).mockResolvedValue(
      overview({
        catalog: [],
        categories: [],
        providerCount: 0,
        catalogNotes: ['No provider is connected yet, so there is nothing to route to.'],
      }),
    );
    render(<ModelRoutingPage />);
    expect(await screen.findByText('No model to choose from yet')).toBeDefined();
    expect(screen.getByText(/Connect a provider in AI providers/)).toBeDefined();
  });

  it('reports a load failure with the reason', async () => {
    vi.mocked(api.getOverview).mockRejectedValue(
      new ApiError(503, 'ROUTER_INTERNAL', 'The routing service is not ready.'),
    );
    render(<ModelRoutingPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The routing service is not ready.');
  });
});

describe('model router wording helpers', () => {
  it('translates capabilities and decision sources', () => {
    expect(api.capabilityWords('text-generation')).toBe('writes text');
    expect(api.capabilityWords('unknown-thing')).toBe('unknown-thing');
    expect(api.decidedByWords('project-preference')).toBe('this project has its own model');
    expect(api.decidedByWords('user-default')).toBe('it is your default model');
    expect(api.preferenceWords('lower-cost')).toBe('Lower cost');
  });
});
