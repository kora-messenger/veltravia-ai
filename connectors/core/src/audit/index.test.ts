import { describe, expect, it } from 'vitest';
import {
  createAuditEvent,
  isConnectorAuditEventType,
  CONNECTOR_AUDIT_EVENT_TYPES,
} from './index.js';

describe('audit events', () => {
  it('covers every documented event type', () => {
    expect(CONNECTOR_AUDIT_EVENT_TYPES).toEqual([
      'connector_registered',
      'connector_configured',
      'connector_connected',
      'connector_disconnected',
      'permission_granted',
      'permission_denied',
      'permission_revoked',
      'operation_requested',
      'operation_approved',
      'operation_rejected',
      'operation_completed',
      'operation_failed',
    ]);
    expect(isConnectorAuditEventType('permission_granted')).toBe(true);
    expect(isConnectorAuditEventType('permission_smuggled')).toBe(false);
  });

  it('creates a valid, timestamped event', () => {
    const event = createAuditEvent({
      type: 'operation_requested',
      connectorId: 'payments',
      summary: 'Operation "charge.run" requested',
      metadata: { operationId: 'charge.run' },
      timestamp: '2026-09-13T12:00:00.000Z',
      id: 'fixed-id',
    });
    expect(event).toEqual({
      id: 'fixed-id',
      type: 'operation_requested',
      connectorId: 'payments',
      timestamp: '2026-09-13T12:00:00.000Z',
      summary: 'Operation "charge.run" requested',
      metadata: { operationId: 'charge.run' },
    });
  });

  it('scrubs secret-like values out of summaries and metadata', () => {
    const token = 'ghp_AbCdEf1234567890AbCdEf1234567890AbCd';
    const event = createAuditEvent({
      type: 'operation_failed',
      connectorId: 'c',
      summary: `operation failed using ${token}`,
      metadata: { detail: `key was ${token}` },
    });
    expect(event.summary).not.toContain(token);
    expect(JSON.stringify(event.metadata)).not.toContain(token);
    expect(event.summary).toContain('[REDACTED]');
  });

  it('rejects invalid events', () => {
    expect(() =>
      createAuditEvent({ type: 'mischief' as never, connectorId: 'c', summary: 's' }),
    ).toThrow(/type/);
    expect(() =>
      createAuditEvent({ type: 'connector_registered', connectorId: '', summary: 's' }),
    ).toThrow(/connectorId/);
    expect(() =>
      createAuditEvent({ type: 'connector_registered', connectorId: 'c', summary: '  ' }),
    ).toThrow(/summary/);
  });

  it('generates unique ids by default', () => {
    const a = createAuditEvent({ type: 'connector_registered', connectorId: 'c', summary: 's' });
    const b = createAuditEvent({ type: 'connector_registered', connectorId: 'c', summary: 's' });
    expect(a.id).not.toBe(b.id);
  });
});
