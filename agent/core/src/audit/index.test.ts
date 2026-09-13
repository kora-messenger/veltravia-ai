import { describe, expect, it } from 'vitest';
import { createAgentAuditEvent, isAgentAuditEventType } from './index.js';

describe('agent audit events', () => {
  it('covers every documented event type', () => {
    for (const type of [
      'agent_run_created',
      'agent_decision_created',
      'agent_tool_requested',
      'agent_waiting_confirmation',
      'agent_tool_result_received',
      'agent_completed',
      'agent_failed',
      'agent_cancelled',
      'agent_limit_reached',
    ]) {
      expect(isAgentAuditEventType(type)).toBe(true);
    }
    expect(isAgentAuditEventType('agent_smuggled')).toBe(false);
  });

  it('creates a valid, scrubbed, timestamped event', () => {
    const token = 'ghp_AbCdEf1234567890AbCdEf1234567890AbCd';
    const event = createAgentAuditEvent({
      type: 'agent_decision_created',
      agentId: 'agent.mock',
      runId: 'run-1',
      summary: `decision near ${token}`,
      metadata: { decisionType: 'request_tool', toolId: 'mock.summarize', leaked: token },
      timestamp: '2026-09-13T16:00:00.000Z',
      id: 'fixed-id',
    });
    expect(event.id).toBe('fixed-id');
    expect(event.timestamp).toBe('2026-09-13T16:00:00.000Z');
    expect(event.summary).not.toContain(token);
    expect(event.summary).toContain('[REDACTED]');
    expect(JSON.stringify(event.metadata)).not.toContain(token);
  });

  it('rejects invalid events', () => {
    expect(() =>
      createAgentAuditEvent({ type: 'mischief' as never, agentId: 'a', runId: 'r', summary: 's' }),
    ).toThrow(/type/);
    expect(() =>
      createAgentAuditEvent({ type: 'agent_run_created', agentId: '', runId: 'r', summary: 's' }),
    ).toThrow(/agentId/);
    expect(() =>
      createAgentAuditEvent({ type: 'agent_run_created', agentId: 'a', runId: 'r', summary: '  ' }),
    ).toThrow(/summary/);
  });

  it('generates unique ids by default', () => {
    const a = createAgentAuditEvent({
      type: 'agent_failed',
      agentId: 'a',
      runId: 'r',
      summary: 's',
    });
    const b = createAgentAuditEvent({
      type: 'agent_failed',
      agentId: 'a',
      runId: 'r',
      summary: 's',
    });
    expect(a.id).not.toBe(b.id);
  });
});
