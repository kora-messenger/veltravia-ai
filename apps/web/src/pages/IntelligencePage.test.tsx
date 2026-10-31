// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { IntelligencePage } from './IntelligencePage';
import * as api from '../api/intelligence';

vi.mock('../api/intelligence', () => ({
  getCapabilities: vi.fn(),
  listSources: vi.fn(),
  analyze: vi.fn(),
  compare: vi.fn(),
  searchSources: vi.fn(),
  startJob: vi.fn(),
  getJob: vi.fn(),
  getJobResult: vi.fn(),
  cancelJob: vi.fn(),
}));

const source = {
  sourceId: 'workspace:ws-1/spec.md',
  provider: 'workspace',
  providerName: 'Project workspace',
  sourceType: 'project_file',
  name: 'spec.md',
  mimeType: 'text/markdown',
  byteSize: 120,
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  contentVersion: '9',
  retrievedAt: '2026-10-31T08:00:00.000Z',
  modifiedAt: '2026-10-30T08:00:00.000Z',
  sourceUrl: null,
  permissions: ['project.read'],
  freshness: {
    retrievedAt: '2026-10-31T08:00:00.000Z',
    ageSeconds: 3600,
    staleAfterSeconds: 86400,
    stale: false,
  },
  trustTag: 'untrusted_data',
};

const disclosure = {
  provider: 'mock-reasoning',
  mode: 'mock_reasoning',
  simulated: true,
  detail: 'A deterministic mock composes this answer from retrieved evidence.',
};

const answer: api.SynthesisAnswer = {
  question: 'What changed about authentication?',
  intent: 'changes',
  status: 'answered',
  summary: 'Based on 1 source with 1 cited passage.',
  claims: [
    {
      claimId: 'c1',
      statement: 'spec.md says email sign-in is implemented.',
      kind: 'extracted_content',
      evidenceIds: ['ev:workspace:ws-1/spec.md:s1'],
      confidence: 0.8,
    },
  ],
  contradictions: [],
  relationships: [],
  gaps: [],
  sources: [source],
  evidence: [
    {
      evidenceId: 'ev:workspace:ws-1/spec.md:s1',
      sourceId: source.sourceId,
      resourceName: 'spec.md',
      locator: { label: 'line 3', section: 'Authentication', line: 3 },
      excerpt: 'Email sign-in is implemented.',
      revision: '9',
      retrievedAt: '2026-10-31T08:00:00.000Z',
      trustTag: 'untrusted_data',
      verified: true,
    },
  ],
  reasoning: disclosure,
  searchedProviders: ['workspace'],
  unavailableProviders: [],
  generatedAt: '2026-10-31T08:00:00.000Z',
  truncated: false,
};

beforeEach(() => {
  vi.mocked(api.getCapabilities).mockResolvedValue({
    reasoning: disclosure,
    limits: { maxSourcesScanned: 25 },
  });
  vi.mocked(api.listSources).mockResolvedValue({
    sources: [source],
    providers: [
      { provider: 'workspace', available: true, detail: 'Project workspace files are searchable.' },
      { provider: 'notion', available: false, detail: 'Notion is not connected.' },
    ],
  });
  vi.mocked(api.analyze).mockResolvedValue(answer);
  vi.mocked(api.compare).mockResolvedValue({
    participants: [
      { source, evidence: answer.evidence, outline: ['Authentication'], wordCount: 40 },
      {
        source: { ...source, sourceId: 'workspace:ws-1/notes.md', name: 'notes.md' },
        evidence: [],
        outline: ['Deadline'],
        wordCount: 30,
      },
    ],
    agreements: [],
    contradictions: [],
    onlyIn: [],
    reasoning: disclosure,
    truncated: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IntelligencePage', () => {
  it('shows the reasoning mode and unavailable providers honestly', async () => {
    render(<IntelligencePage />);
    const detail = await screen.findByText(/A deterministic mock composes this answer/i);
    expect(detail.textContent).toContain('deterministic mock');
    expect(screen.getByText(/Reasoning: mock reasoning/i)).toBeDefined();
    const unavailable = await screen.findByText(/Not searched/i);
    expect(unavailable.parentElement?.textContent).toContain('Notion is not connected.');
  });

  it('lists authorized sources with provider and revision', async () => {
    render(<IntelligencePage />);
    await screen.findByText('spec.md');
    expect(screen.getByText('Project workspace')).toBeDefined();
    expect(screen.getAllByText(/revision 9/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('untrusted data').length).toBeGreaterThan(0);
  });

  it('asks before analyzing when the question is empty', async () => {
    render(<IntelligencePage />);
    await screen.findByText('spec.md');
    fireEvent.click(screen.getByRole('button', { name: /analyze sources/i }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('renders an answer with a disclosure and a revealable cited passage', async () => {
    render(<IntelligencePage />);
    await screen.findByText('spec.md');
    const input = screen.getByPlaceholderText(/What changed about the authentication plan/i);
    fireEvent.change(input, { target: { value: 'What changed about authentication?' } });
    fireEvent.click(screen.getByRole('button', { name: /analyze sources/i }));

    await screen.findByText('spec.md says email sign-in is implemented.');
    const disclosures = screen.getAllByText(/Reasoning: mock reasoning/i);
    expect(disclosures.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/confidence 80%/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Show passage/i }));
    await screen.findByText('Email sign-in is implemented.');
    expect(screen.getAllByText(/revision 9/).length).toBeGreaterThan(0);
  });

  it('shows an honest notice when nothing matched instead of a fabricated answer', async () => {
    vi.mocked(api.analyze).mockResolvedValueOnce({
      ...answer,
      status: 'no_evidence',
      summary: 'No authorized source matched this question.',
      claims: [],
      evidence: [],
      sources: [],
      gaps: [
        {
          gapId: 'gap:no-source',
          kind: 'no_source',
          description: 'No authorized source matched the question.',
          sourceIds: [],
        },
      ],
    });
    render(<IntelligencePage />);
    await screen.findByText('spec.md');
    fireEvent.change(screen.getByPlaceholderText(/What changed about the authentication plan/i), {
      target: { value: 'xylophone' },
    });
    fireEvent.click(screen.getByRole('button', { name: /analyze sources/i }));
    await screen.findByText(/Nothing matched this question/);
    expect(screen.getByText(/no evidence/)).toBeDefined();
  });

  it('requires two selected sources before comparing', async () => {
    render(<IntelligencePage />);
    await screen.findByText('spec.md');
    const compareButton = screen.getByRole('button', { name: /compare selected \(0\)/i });
    expect(compareButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText(/Select spec.md for comparison/i));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /compare selected \(1\)/i })).toBeDefined();
    });
    expect(api.compare).not.toHaveBeenCalled();
  });
});
