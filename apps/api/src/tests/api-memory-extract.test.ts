import { describe, expect, it } from 'vitest';
import type { GenerationRunView, GenerationState } from '@veltravia/generation-core';
import type { TestRunView } from '@veltravia/testing-core';
import { candidatesFromGenerationRun, candidatesFromTestingRun } from '../memory-service.js';

/**
 * Step 15: candidate extraction maps ONLY narrow, structural run facts.
 * Raw command output, generated file content, and diagnosis INFERENCE /
 * RECOMMENDATION statements never become memory candidates.
 */

function generationView(overrides: Partial<GenerationRunView> = {}): GenerationRunView {
  return {
    runId: 'gen_1',
    idea: 'A habit tracker with streaks.',
    state: 'completed',
    projectId: 'prj_1',
    workspaceId: 'ws_1',
    templateId: 'web-react',
    specName: 'Habit Hero',
    appType: 'application',
    phases: [],
    changedFiles: [],
    repairAttempts: 0,
    failure: null,
    pendingApproval: null,
    result: {
      outcome: 'succeeded',
      projectId: 'prj_1',
      workspaceId: 'ws_1',
      filesChanged: [],
      validation: null,
      tests: {
        executed: true,
        commands: [
          { command: 'npm', arguments: ['test'], exitCode: 0, passed: true, stdout: 'ok' },
        ],
      },
      repairAttempts: 0,
      warnings: [],
      remainingIssues: [],
      completedAt: '2026-09-18T10:00:00.000Z',
    },
    createdAt: '2026-09-18T09:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    ...overrides,
  } as GenerationRunView;
}

function testingView(overrides: Partial<TestRunView> = {}): TestRunView {
  return {
    runId: 'test_1',
    state: 'completed',
    projectId: 'prj_1',
    workspaceId: 'ws_1',
    projectType: 'node',
    plan: {
      version: '1',
      projectType: 'node',
      framework: 'react',
      runtime: 'node',
      signals: [],
      validationSteps: [],
      commands: [
        {
          label: 'unit tests',
          purpose: 'unit_tests',
          executable: 'npm',
          arguments: ['test'],
          scriptName: null,
        },
      ],
    },
    results: null,
    retestResults: null,
    diagnosis: {
      category: 'failing_tests',
      summary: 'Two unit tests fail.',
      statements: [
        { kind: 'fact', text: 'The vitest run reports 2 failing tests.' },
        { kind: 'inference', text: 'The failure is likely a regression.' },
        { kind: 'recommendation', text: 'Update the assertions.' },
      ],
      affectedPaths: [],
      confidence: 'high',
      recommendedAction: 'Inspect the failing tests.',
    },
    repairPlan: null,
    repairAttempts: 0,
    commandsExecuted: 2,
    codingRunId: null,
    revisionConflict: null,
    pendingApproval: null,
    failure: null,
    notes: [],
    createdAt: '2026-09-18T09:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    ...overrides,
  } as TestRunView;
}

describe('extraction from generation runs', () => {
  it('produces candidates from a completed run (project summary + testing rule)', () => {
    const candidates = candidatesFromGenerationRun(generationView());
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const titles = candidates.map((candidate) => candidate.input.title);
    expect(titles.some((title) => /habit hero/i.test(title))).toBe(true);
    const testing = candidates.find(
      (candidate) => candidate.input.type === ('testing_rule' as string),
    );
    expect(testing?.input.content).toContain('npm test');
    // Every candidate is scoped to the run's project and run reference.
    for (const candidate of candidates) {
      expect(candidate.input.projectId).toBe('prj_1');
      expect(candidate.input.source.kind).toBe('generation_run');
      expect(candidate.input.source.referenceId).toBe('gen_1');
    }
  });

  it('rejects a non-completed run (nothing is extracted)', () => {
    for (const state of ['created', 'planning', 'failed', 'cancelled'] as GenerationState[]) {
      expect(() => candidatesFromGenerationRun(generationView({ state }))).toThrow(
        'RUN_NOT_COMPLETED',
      );
    }
  });
});

describe('extraction from testing runs', () => {
  it('carries ONLY fact statements, never inference or recommendation', () => {
    const candidates = candidatesFromTestingRun(testingView());
    const joined = candidates.map((candidate) => candidate.input.content).join('\n');
    expect(joined).toContain('The vitest run reports 2 failing tests.');
    expect(joined).not.toContain('likely a regression');
    expect(joined).not.toContain('Update the assertions.');
    expect(joined).not.toContain('stdout');
  });

  it('records the stack fact and the test-runner fact separately', () => {
    const candidates = candidatesFromTestingRun(testingView());
    const stack = candidates.find((candidate) => candidate.input.type === ('technology' as string));
    expect(stack?.input.content).toContain('react');
    expect(stack?.input.content).toContain('node');
    const runner = candidates.find(
      (candidate) => candidate.input.type === ('testing_rule' as string),
    );
    expect(runner?.input.content).toContain('npm test');
  });

  it('rejects a non-completed run', () => {
    expect(() => candidatesFromTestingRun(testingView({ state: 'failed' }))).toThrow(
      'RUN_NOT_COMPLETED',
    );
  });
});
