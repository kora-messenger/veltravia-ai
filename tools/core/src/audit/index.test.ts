import { describe, expect, it } from 'vitest';
import { createToolAuditEvent, isToolAuditEventType } from './index.js';

describe('tool audit events', () => {
  it('covers every documented event type', () => {
    expect(isToolAuditEventType('tool_registered')).toBe(true);
    expect(isToolAuditEventType('tool_invocation_requested')).toBe(true);
    expect(isToolAuditEventType('tool_invocation_denied')).toBe(true);
    expect(isToolAuditEventType('tool_confirmation_requested')).toBe(true);
    expect(isToolAuditEventType('tool_confirmation_approved')).toBe(true);
    expect(isToolAuditEventType('tool_confirmation_rejected')).toBe(true);
    expect(isToolAuditEventType('tool_execution_started')).toBe(true);
    expect(isToolAuditEventType('tool_execution_completed')).toBe(true);
    expect(isToolAuditEventType('tool_execution_failed')).toBe(true);
    expect(isToolAuditEventType('tool_smuggled')).toBe(false);
  });

  it('creates a valid, timestamped, scrubbed event', () => {
    const token = 'ghp_AbCdEf1234567890AbCdEf1234567890AbCd';
    const event = createToolAuditEvent({
      type: 'tool_execution_failed',
      toolId: 'mock.summarize',
      summary: `execution failed near ${token}`,
      metadata: { invocationId: 'inv-1', detail: `input contained ${token}` },
      timestamp: '2026-09-13T15:30:00.000Z',
      id: 'fixed-id',
    });
    expect(event.id).toBe('fixed-id');
    expect(event.timestamp).toBe('2026-09-13T15:30:00.000Z');
    expect(event.summary).not.toContain(token);
    expect(JSON.stringify(event.metadata)).not.toContain(token);
    expect(event.summary).toContain('[REDACTED]');
  });

  it('rejects invalid events', () => {
    expect(() =>
      createToolAuditEvent({ type: 'mischief' as never, toolId: 't', summary: 's' }),
    ).toThrow(/type/);
    expect(() =>
      createToolAuditEvent({ type: 'tool_registered', toolId: '', summary: 's' }),
    ).toThrow(/toolId/);
    expect(() =>
      createToolAuditEvent({ type: 'tool_registered', toolId: 't', summary: '  ' }),
    ).toThrow(/summary/);
  });

  it('generates unique ids by default', () => {
    const a = createToolAuditEvent({ type: 'tool_registered', toolId: 't', summary: 's' });
    const b = createToolAuditEvent({ type: 'tool_registered', toolId: 't', summary: 's' });
    expect(a.id).not.toBe(b.id);
  });
});
