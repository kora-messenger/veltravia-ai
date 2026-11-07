import { describe, expect, it } from 'vitest';

import { assessCompletion, validateAssignment } from './assignment.js';
import { OrchestrationError } from './errors.js';
import type { TaskAssignment } from './types.js';

function assignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    worker: 'superagent',
    objective: 'Add a pricing page and its route',
    scope: { projectId: 'prj_1', workspaceId: 'ws_1', paths: ['src/pages'] },
    expectedOutputs: ['pricing page', 'route registration'],
    acceptance: [
      { id: 'renders', statement: 'The page renders at /pricing', required: true },
      { id: 'route', statement: 'The router registers /pricing', required: true },
    ],
    allowedTools: ['read_file', 'write_file'],
    permissions: {
      canReadProject: true,
      canWriteProject: true,
      canRunTools: true,
      canUseNetwork: false,
    },
    limits: { maxDurationMs: 600_000, maxToolCalls: 40 },
    dependsOn: [],
    checkpoint: null,
    reportingRequirements: ['what changed', 'how to check it'],
    ...overrides,
  };
}

describe('validating an assignment', () => {
  it('accepts a complete assignment', () => {
    const value = validateAssignment(assignment());
    expect(value.expectedOutputs).toHaveLength(2);
    expect(value.acceptance).toHaveLength(2);
  });

  it('refuses an assignment with no expected output', () => {
    expect(() => validateAssignment(assignment({ expectedOutputs: [] }))).toThrowError(
      /what the worker has to return/,
    );
  });

  it('refuses an assignment with no acceptance criterion', () => {
    expect(() => validateAssignment(assignment({ acceptance: [] }))).toThrowError(
      /acceptance criterion/,
    );
  });

  it('refuses a tool the platform does not have', () => {
    expect(() =>
      validateAssignment(assignment({ allowedTools: ['rm_rf_everything'] })),
    ).toThrowError(/Unknown tool/);
  });

  it('refuses writing a project it may not read', () => {
    expect(() =>
      validateAssignment(
        assignment({
          permissions: {
            canReadProject: false,
            canWriteProject: true,
            canRunTools: false,
            canUseNetwork: false,
          },
        }),
      ),
    ).toThrowError(/may not read/);
  });

  it('refuses tool use with no tools listed', () => {
    expect(() => validateAssignment(assignment({ allowedTools: [] }))).toThrowError(
      /no tools are listed/,
    );
  });

  it('refuses a vaguer objective than it can judge', () => {
    expect(() => validateAssignment(assignment({ objective: 'do it' }))).toThrowError(
      OrchestrationError,
    );
  });
});

describe('judging what a worker returned', () => {
  it('completes only when every required output and criterion is met', () => {
    const verdict = assessCompletion(assignment(), {
      outputs: ['pricing page', 'route registration'],
      acceptance: [
        { criterionId: 'renders', satisfied: true },
        { criterionId: 'route', satisfied: true },
      ],
    });
    expect(verdict.verdict).toBe('completed');
    expect(verdict.reasons[0]).toMatch(/Every required output/);
  });

  it('treats an unchecked criterion as unverified, not satisfied', () => {
    const verdict = assessCompletion(assignment(), {
      outputs: ['pricing page', 'route registration'],
      acceptance: [{ criterionId: 'renders', satisfied: true }],
    });
    expect(verdict.verdict).toBe('partially_completed');
    expect(verdict.unverifiedCriteria).toEqual(['route']);
  });

  it('calls missing output what it is', () => {
    const verdict = assessCompletion(assignment(), {
      outputs: ['pricing page'],
      acceptance: [
        { criterionId: 'renders', satisfied: true },
        { criterionId: 'route', satisfied: true },
      ],
    });
    expect(verdict.verdict).toBe('partially_completed');
    expect(verdict.missingOutputs).toEqual(['route registration']);
  });

  it('reports blocked and failed as themselves, not as progress', () => {
    const blocked = assessCompletion(assignment(), {
      outputs: [],
      acceptance: [],
      blockedReason: 'Needs the brand colours from the owner',
    });
    expect(blocked.verdict).toBe('blocked');

    const failed = assessCompletion(assignment(), {
      outputs: ['pricing page'],
      acceptance: [{ criterionId: 'renders', satisfied: true }],
      failure: { code: 'BUILD_FAILED', message: 'The build did not finish.' },
    });
    expect(failed.verdict).toBe('failed');
  });

  it('says incomplete when nothing usable came back', () => {
    const verdict = assessCompletion(assignment(), { outputs: [], acceptance: [] });
    expect(verdict.verdict).toBe('incomplete');
  });
});
