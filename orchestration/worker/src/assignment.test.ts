import { describe, expect, it } from 'vitest';

import { claimsFor, validateAssignment } from './assignment.js';
import { WorkerError } from './errors.js';
import { TEST_TOOLS, validAssignment } from './testing.js';

const context = { allowedTools: TEST_TOOLS as unknown as string[] };

function refusal(assignment: Record<string, unknown>): string {
  try {
    validateAssignment(assignment, context);
    return 'accepted';
  } catch (error) {
    return error instanceof WorkerError ? error.code : 'other';
  }
}

describe('assignment validation', () => {
  it('accepts a complete assignment and normalises its paths', () => {
    const assignment = validateAssignment(validAssignment({ scope: ['./src/settings/'] }), context);
    expect(assignment.scope).toEqual(['src/settings']);
    expect(assignment.permissions.writeProject).toBe(true);
    expect(assignment.deliverables[0]?.path).toBe('src/settings/panel.tsx');
  });

  it('refuses an assignment that never says what not to touch', () => {
    expect(refusal(validAssignment({ exclusions: [] }))).toBe('WORKER_ASSIGNMENT_INVALID');
  });

  it('refuses an assignment with no deliverables', () => {
    expect(refusal(validAssignment({ deliverables: [] }))).toBe('WORKER_ASSIGNMENT_INVALID');
  });

  it('refuses an assignment that does not say how it will be judged', () => {
    expect(refusal(validAssignment({ acceptanceCriteria: [] }))).toBe('WORKER_ASSIGNMENT_INVALID');
  });

  it('refuses an assignment with no cancellation conditions', () => {
    expect(refusal(validAssignment({ cancellationConditions: [] }))).toBe(
      'WORKER_ASSIGNMENT_INVALID',
    );
  });

  it('refuses tools this deployment does not offer', () => {
    expect(refusal(validAssignment({ allowedTools: ['project.read', 'shell.unbounded'] }))).toBe(
      'WORKER_ASSIGNMENT_INVALID',
    );
  });

  it('refuses network access that does not come through the named tool', () => {
    expect(
      refusal(
        validAssignment({
          allowedTools: ['project.read'],
          permissions: { readProject: true, writeProject: false, runTools: true, network: true },
          exclusions: [],
          checkpoints: [],
        }),
      ),
    ).toBe('WORKER_ASSIGNMENT_INVALID');
  });

  it('refuses a time budget above the platform ceiling', () => {
    expect(
      refusal(
        validAssignment({
          limits: { maxDurationMs: 10_000_000, maxToolCalls: 10, maxDeliverables: 2 },
        }),
      ),
    ).toBe('WORKER_ASSIGNMENT_INVALID');
  });

  it('refuses a path that climbs out of the project', () => {
    expect(refusal(validAssignment({ scope: ['../other-project'] }))).toBe(
      'WORKER_ASSIGNMENT_INVALID',
    );
    expect(refusal(validAssignment({ scope: ['/etc'] }))).toBe('WORKER_ASSIGNMENT_INVALID');
  });

  it('refuses text that looks like a credential', () => {
    const assignment = validAssignment();
    expect(validateAssignment).toBeTruthy();
    const looksLikeSecret = (text: string): boolean => text.includes('sk-live');
    expect(() =>
      validateAssignment(
        { ...assignment, objective: 'deploy with sk-live-abcdef1234567890abcd' },
        {
          ...context,
          looksLikeSecret,
        },
      ),
    ).toThrow(WorkerError);
  });

  it('derives one claim per scope path and one per deliverable path', () => {
    const assignment = validateAssignment(validAssignment(), context);
    const claims = claimsFor(assignment);
    expect(claims.map((claim) => claim.path)).toContain('src/settings');
    expect(claims.map((claim) => claim.path)).toContain('src/settings/panel.tsx');
    expect(claims.find((claim) => claim.path === 'src/settings')?.kind).toBe('directory');
    expect(claims.find((claim) => claim.path === 'src/settings/panel.tsx')?.kind).toBe('file');
  });
});
