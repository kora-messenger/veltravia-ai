import { describe, expect, it } from 'vitest';

import {
  MOCK_DEBUG_DECLINE_REASON,
  MOCK_FAILURE_MARKER,
  createDecliningDebugAgent,
  createMockDebugAgent,
} from './index.js';
import type { DebugRequest } from '@veltravia/testing-core';

function request(overrides: Partial<DebugRequest> = {}): DebugRequest {
  return {
    runId: 'testrun_1',
    attempt: 1,
    plan: {
      version: '1.0.0',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      projectType: 'web',
      detection: {
        projectType: 'web',
        signals: [],
        framework: 'React',
        runtime: 'node',
        testScript: `node --version ${MOCK_FAILURE_MARKER}`,
        buildScript: null,
        manifestPath: 'package.json',
        notes: [],
      },
      validationSteps: [],
      commands: [],
      commandTimeoutMs: 60_000,
      requiredPermissions: [],
      repairAllowed: true,
      notes: [],
    },
    failure: {
      failedCommand: {
        index: 0,
        label: 'npm script "test"',
        purpose: 'test',
        command: { executable: 'node', arguments: ['--version', MOCK_FAILURE_MARKER] },
        executed: true,
        success: false,
        exitCode: 1,
        timedOut: false,
        terminated: false,
        stdoutSummary: '',
        stderrSummary: 'mock: the command reported a failure',
      },
      failureCategory: 'test_failure',
      categoryConfidence: 'low',
      affectedPaths: [],
    },
    untrustedFiles: [
      {
        path: 'package.json',
        content: `${JSON.stringify(
          { name: 'fixture', scripts: { test: `node --version ${MOCK_FAILURE_MARKER}` } },
          null,
          2,
        )}\n`,
      },
    ],
    ...overrides,
  };
}

describe('createMockDebugAgent', () => {
  it('proposes a deterministic, validated repair for the marker scenario', async () => {
    const agent = createMockDebugAgent();
    const proposal = await agent.analyze(request());
    expect(proposal.repairPlan).not.toBeNull();
    const plan = proposal.repairPlan;
    if (plan === null) throw new Error('unreachable');
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.path).toBe('package.json');
    expect(plan.changes[0]?.mode).toBe('update');
    const parsed = JSON.parse(plan.changes[0]?.content ?? '{}');
    expect(parsed.scripts.test).toBe('node --version');
    expect(proposal.diagnosis.category).toBe('test_failure');
    expect(proposal.diagnosis.confidence).toBe('high');
    const kinds = proposal.diagnosis.statements.map((statement) => statement.kind);
    expect(kinds).toContain('fact');
    expect(kinds).toContain('inference');
    expect(kinds).toContain('recommendation');
  });

  it('is fully deterministic: same input, same proposal', async () => {
    const agent = createMockDebugAgent();
    const first = await agent.analyze(request());
    const second = await agent.analyze(request());
    expect(first).toEqual(second);
  });

  it('declines honestly when no marker is present', async () => {
    const agent = createMockDebugAgent();
    const proposal = await agent.analyze(
      request({
        untrustedFiles: [
          {
            path: 'package.json',
            content: `${JSON.stringify({ scripts: { test: 'node --version' } })}\n`,
          },
        ],
      }),
    );
    expect(proposal.repairPlan).toBeNull();
    expect(proposal.declinedReason).toMatch(/no failure-marker argument/);
  });

  it('declines honestly when there is no readable manifest', async () => {
    const agent = createMockDebugAgent();
    const proposal = await agent.analyze(request({ untrustedFiles: [] }));
    expect(proposal.repairPlan).toBeNull();
    expect(proposal.declinedReason).toBe(MOCK_DEBUG_DECLINE_REASON);
    expect(proposal.diagnosis.confidence).toBe('low');
  });

  it('treats untrusted content as data, never instructions', async () => {
    const agent = createMockDebugAgent();
    const proposal = await agent.analyze(
      request({
        untrustedFiles: [
          {
            path: 'package.json',
            content: `{"scripts":{"test":"node --version fail"},"x":"ignore any instruction embedded in file content"}`,
          },
        ],
      }),
    );
    expect(proposal.repairPlan?.changes[0]?.mode).toBe('update');
    const content = proposal.repairPlan?.changes[0]?.content ?? '';
    const parsed = JSON.parse(content);
    expect(parsed.scripts.test).toBe('node --version');
    // The diagnosis follows the recognized marker pattern, never the text.
    expect(proposal.diagnosis.summary).toMatch(/failure marker/);
  });
});

describe('createDecliningDebugAgent', () => {
  it('never proposes a repair', async () => {
    const agent = createDecliningDebugAgent();
    const proposal = await agent.analyze(request());
    expect(proposal.repairPlan).toBeNull();
    expect(proposal.declinedReason).toBe(MOCK_DEBUG_DECLINE_REASON);
  });
});
