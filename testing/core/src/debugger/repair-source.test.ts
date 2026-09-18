import { describe, expect, it } from 'vitest';

import type { CodingDecisionContext } from '@veltravia/coding-agent-core';

import { createRepairDecisionSource } from './repair-source.js';
import type { RepairPlan } from '../types/index.js';

const PLAN: RepairPlan = {
  diagnosis: {
    category: 'test_failure',
    summary: 'The test script contains a failure marker',
    statements: [
      { kind: 'fact', text: 'The command exited non-zero' },
      { kind: 'inference', text: 'Removing the marker helps', confidence: 'high' },
      { kind: 'recommendation', text: 'Remove it' },
    ],
    affectedPaths: ['package.json'],
    confidence: 'high',
    recommendedAction: 'Approve',
  },
  changes: [
    {
      path: 'package.json',
      mode: 'update',
      content: '{ "scripts": { "test": "node --version" } }\n',
      reason: 'Remove the marker',
      expectedEffect: 'The test passes',
    },
    {
      path: 'src/fix.ts',
      mode: 'create',
      content: 'export const fixed = true;\n',
      reason: 'Add the missing module',
      expectedEffect: 'The import resolves',
    },
  ],
  risk: 'low',
  scope: 'multi-file',
  verificationPlan: 'Rerun the test script',
  testsToRerun: ['npm script "test"'],
};

function context(): CodingDecisionContext {
  return {
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    iteration: 0,
    workspaceRevision: 1,
    files: [],
    untrustedFiles: [],
    untrustedToolResults: [],
  } as unknown as CodingDecisionContext;
}

describe('RepairDecisionSource', () => {
  it('emits plan, reads update-targets, applies changes, then completes', async () => {
    const source = createRepairDecisionSource({ repairPlan: PLAN, runLabel: 'unit repair' });

    const plan = await source.nextDecision(context());
    expect(plan.type).toBe('plan');
    if (plan.type !== 'plan') throw new Error('unreachable');
    expect(plan.plan.goal).toMatch(/approved repair/);
    expect(plan.plan.steps).toHaveLength(2);
    expect(plan.plan.filesToModify).toEqual(['package.json', 'src/fix.ts']);

    // read before update (revision discipline), update, create, complete
    const read = await source.nextDecision(context());
    expect(read).toMatchObject({
      type: 'action',
      action: { type: 'read_file', path: 'package.json' },
    });

    const update = await source.nextDecision(context());
    expect(update).toMatchObject({
      type: 'action',
      action: { type: 'update_file', path: 'package.json' },
    });

    const create = await source.nextDecision(context());
    expect(create).toMatchObject({
      type: 'action',
      action: { type: 'create_file', path: 'src/fix.ts' },
    });

    const complete = await source.nextDecision(context());
    expect(complete.type).toBe('complete');
    if (complete.type !== 'complete') throw new Error('unreachable');
    expect(complete.summary).toMatch(/2 repair change/);
  });

  it('only ever reads update-mode files (create-mode needs no read)', async () => {
    const source = createRepairDecisionSource({ repairPlan: PLAN, runLabel: 'unit repair' });
    await source.nextDecision(context());
    const decisions = [];
    for (let index = 0; index < 3; index += 1) {
      decisions.push(await source.nextDecision(context()));
    }
    const reads = decisions.filter(
      (decision) => decision.type === 'action' && decision.action.type === 'read_file',
    );
    expect(reads).toHaveLength(1);
  });

  it('emits nothing beyond complete (deterministic, bounded)', async () => {
    const source = createRepairDecisionSource({ repairPlan: PLAN, runLabel: 'unit repair' });
    for (let index = 0; index < 6; index += 1) {
      await source.nextDecision(context());
    }
    const after = await source.nextDecision(context());
    expect(after.type).toBe('complete');
  });
});
