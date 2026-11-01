// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { CodingCapabilities, CodingRunView, CodingValidationView } from '../../api/coding';
import { BuilderChatPanel } from './BuilderChatPanel';

/**
 * Step 35 presentation: the panel must never imply a model planned a change
 * when it did not, and must show the model that actually did - plus the real
 * checks the run passed or failed.
 */

afterEach(cleanup);

function run(overrides: Partial<CodingRunView> = {}): CodingRunView {
  return {
    runId: 'run-1',
    projectId: 'prj-1',
    workspaceId: 'ws-1',
    state: 'awaiting_approval',
    summary: null,
    changedFiles: [],
    iterations: 1,
    toolCalls: 2,
    startedAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:05.000Z',
    pendingApproval: { kind: 'plan_approval' },
    plan: {
      goal: 'Add the invoice route',
      steps: ['Create src/invoices.ts'],
      filesToInspect: ['src/users.ts'],
      filesToModify: [],
      filesToCreate: ['src/invoices.ts'],
      filesToDelete: [],
      validations: ['npm test'],
      acceptanceCriteria: ['POST /api/invoices works'],
      requestSummary: 'Add a POST /api/invoices endpoint',
      projectUnderstanding: 'Routes live in src/routes',
      approach: 'Mirror the existing users route',
      risks: ['The form may need a shared fetch helper'],
      validationStrategy: ['npm test'],
      approvalRequirements: ['Approve the plan before any file is written'],
      origin: 'model',
    },
    failure: null,
    phase: 'awaiting_approval',
    validationResults: [],
    model: {
      used: true,
      providerId: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-4.1-mini',
      live: true,
      decisions: 1,
    },
    ...overrides,
  };
}

function capabilities(overrides: Partial<CodingCapabilities> = {}): CodingCapabilities {
  return {
    decisionSource: 'model',
    unavailableReason: null,
    planApprovalRequired: true,
    toolConfirmationsRequired: true,
    phases: [],
    ...overrides,
  };
}

function renderPanel(options: {
  run?: CodingRunView | null;
  capabilities?: CodingCapabilities | null;
}) {
  render(
    <BuilderChatPanel
      run={options.run === undefined ? run() : options.run}
      busy={false}
      error=""
      decisionsPending={false}
      capabilities={options.capabilities === undefined ? capabilities() : options.capabilities}
      messages={[]}
      history={[]}
      onSend={vi.fn()}
      onDecide={vi.fn()}
      onCancel={vi.fn()}
      onReviewChanges={vi.fn()}
    />,
  );
}

describe('builder chat panel: model provenance', () => {
  it('names the model that wrote the plan', () => {
    renderPanel({});
    expect(screen.getByTestId('plan-provenance').textContent).toBe(
      'Planned by OpenAI · gpt-4.1-mini',
    );
    expect(screen.getByText(/connected model/i)).toBeDefined();
  });

  it('says plainly when the offline script wrote the plan', () => {
    renderPanel({
      run: run({
        plan: { ...run().plan!, origin: 'script' },
        model: null,
      }),
      capabilities: capabilities({ decisionSource: 'scripted-demo' }),
    });
    expect(screen.getByTestId('plan-provenance').textContent).toMatch(/offline script/i);
    expect(screen.getByText(/scripted demo agent/i)).toBeDefined();
  });

  it('explains the missing provider instead of implying a model is behind it', () => {
    renderPanel({
      run: null,
      capabilities: capabilities({
        decisionSource: 'unavailable',
        unavailableReason: 'Connect a provider in Settings before a model can plan this change.',
      }),
    });
    const note = screen.getByTestId('model-unavailable');
    expect(note.textContent).toMatch(/connect a provider in settings/i);
    expect(screen.getByText(/no model connected/i)).toBeDefined();
    expect(screen.queryByText(/connected model/i)).toBeNull();
  });
});

describe('builder chat panel: plan detail', () => {
  it('shows the understanding, approach, files to create and named risks', () => {
    renderPanel({});
    const review = screen.getByTestId('plan-review');
    expect(review.textContent).toContain('Add a POST /api/invoices endpoint');
    expect(review.textContent).toContain('Routes live in src/routes');
    expect(review.textContent).toContain('Mirror the existing users route');
    expect(review.textContent).toContain('src/invoices.ts');
    expect(screen.getByTestId('plan-risks').textContent).toMatch(/shared fetch helper/);
    expect(review.textContent).toMatch(/npm test/);
  });

  it('shows the concrete phase when it differs from the coarse state', () => {
    renderPanel({
      run: run({ state: 'validating', phase: 'diagnosing', pendingApproval: null }),
    });
    expect(screen.getByTestId('run-phase').textContent).toMatch(/reading the failure/i);
  });

  it('does not repeat the phase when it matches the state word', () => {
    renderPanel({ run: run({ state: 'awaiting_approval', phase: 'awaiting_approval' }) });
    expect(screen.queryByTestId('run-phase')).toBeNull();
  });
});

describe('builder chat panel: validation results', () => {
  const results: CodingValidationView[] = [
    { command: 'npm test', passed: false, status: 'failed', exitCode: 1, timedOut: false },
    { command: 'npm run build', passed: true, status: 'succeeded', exitCode: 0, timedOut: false },
  ];

  it('lists every check with its real outcome', () => {
    renderPanel({
      run: run({
        state: 'completed',
        phase: 'completed',
        pendingApproval: null,
        summary: 'Corrected the failing test and finished.',
        changedFiles: ['src/invoices.ts'],
        validationResults: results,
      }),
    });
    const list = screen.getByTestId('run-validations');
    expect(list.textContent).toContain('npm test');
    expect(list.textContent).toContain('failed (exit 1)');
    expect(list.textContent).toMatch(/npm run build/);
    expect(list.textContent).toContain('passed');
    expect(screen.getByTestId('run-status').textContent).toMatch(/1\/2 checks passed/);
  });

  it('reports a timeout as a timeout, not a pass', () => {
    renderPanel({
      run: run({
        state: 'failed',
        phase: 'failed',
        pendingApproval: null,
        failure: { code: 'CODING_DURATION_LIMIT', message: 'The run took too long.' },
        validationResults: [
          {
            command: 'npm test',
            passed: false,
            status: 'timed-out',
            exitCode: null,
            timedOut: true,
          },
        ],
      }),
    });
    expect(screen.getByTestId('run-validations').textContent).toContain('timed out');
    expect(screen.getByRole('alert').textContent).toMatch(/took too long/i);
  });
});
