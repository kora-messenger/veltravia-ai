import { describe, expect, it } from 'vitest';

import {
  CENTRAL_PRIMARY_AGENT_CONTRACT,
  PRIMARY_AGENT_RESPONSIBILITIES,
  PrimaryAgentRegistry,
  assessDelegation,
} from './contract.js';
import { OrchestrationError } from './errors.js';

describe('the central primary agent contract', () => {
  it('owns every responsibility the step names', () => {
    const ids = PRIMARY_AGENT_RESPONSIBILITIES.map((entry) => entry.id);
    expect(ids).toEqual([
      'user_interaction',
      'request_understanding',
      'task_planning',
      'task_decomposition',
      'delegation_decision',
      'assignment_creation',
      'dependency_coordination',
      'progress_monitoring',
      'result_review',
      'work_integration',
      'final_verification_response',
    ]);
  });

  it('never hands the conversation, the review or the answer to a worker', () => {
    const reserved = PRIMARY_AGENT_RESPONSIBILITIES.filter((entry) => entry.neverDelegated).map(
      (entry) => entry.id,
    );
    expect(reserved).toContain('user_interaction');
    expect(reserved).toContain('result_review');
    expect(reserved).toContain('final_verification_response');
    expect(reserved).not.toContain('task_decomposition');
  });

  it('states what is not implemented rather than implying execution', () => {
    const omissions = CENTRAL_PRIMARY_AGENT_CONTRACT.notYetImplemented.join(' ');
    expect(omissions).toMatch(/No worker executes an assignment yet/);
    expect(omissions).toMatch(/Step 43/);
  });

  it('keeps one primary per owner and refuses a second', () => {
    const registry = new PrimaryAgentRegistry();
    registry.register({ ownerRef: 'owner-a', agentId: 'agent-1', role: 'primary', label: 'Mine' });
    registry.register({ ownerRef: 'owner-a', agentId: 'worker-1', role: 'worker', label: 'W' });
    expect(registry.primaryFor('owner-a')?.agentId).toBe('agent-1');
    expect(registry.workersFor('owner-a')).toHaveLength(1);

    expect(() =>
      registry.register({
        ownerRef: 'owner-a',
        agentId: 'agent-2',
        role: 'primary',
        label: 'Another',
      }),
    ).toThrowError(OrchestrationError);
  });

  it('allows a different owner their own primary', () => {
    const registry = new PrimaryAgentRegistry();
    registry.register({ ownerRef: 'owner-a', agentId: 'a', role: 'primary', label: 'A' });
    registry.register({ ownerRef: 'owner-b', agentId: 'b', role: 'primary', label: 'B' });
    expect(registry.primaryFor('owner-b')?.agentId).toBe('b');
  });
});

describe('the delegation decision', () => {
  it('keeps small work inline', () => {
    const verdict = assessDelegation({
      estimatedSteps: 3,
      independentParts: 1,
      parallelizable: false,
      requiresLongRunningWork: false,
      requiresUserInput: false,
      requiresConversationContext: false,
    });
    expect(verdict.delegate).toBe(false);
    expect(verdict.recommendedWorkers).toBe(0);
  });

  it('delegates large work that splits into independent parts', () => {
    const verdict = assessDelegation({
      estimatedSteps: 14,
      independentParts: 3,
      parallelizable: true,
      requiresLongRunningWork: true,
      requiresUserInput: false,
      requiresConversationContext: false,
    });
    expect(verdict.delegate).toBe(true);
    expect(verdict.recommendedWorkers).toBe(3);
    expect(verdict.reasons.join(' ')).toMatch(/independent parts/);
  });

  it('never delegates work that needs the user or the conversation', () => {
    const needsUser = assessDelegation({
      estimatedSteps: 40,
      independentParts: 6,
      parallelizable: true,
      requiresLongRunningWork: true,
      requiresUserInput: true,
      requiresConversationContext: false,
    });
    expect(needsUser.delegate).toBe(false);

    const needsContext = assessDelegation({
      estimatedSteps: 40,
      independentParts: 6,
      parallelizable: true,
      requiresLongRunningWork: true,
      requiresUserInput: false,
      requiresConversationContext: true,
    });
    expect(needsContext.delegate).toBe(false);
  });
});
