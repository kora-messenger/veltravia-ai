import { describe, expect, it } from 'vitest';
import { digestToolInput, InMemoryConfirmationService } from './index.js';

const START = new Date('2026-09-13T15:00:00.000Z');
let tick = 0;
const now = () => new Date(START.getTime() + tick * 60_000); // +1 minute per tick

function buildService(ttlMs = 5 * 60_000): InMemoryConfirmationService {
  tick = 0;
  return new InMemoryConfirmationService({ now, ttlMs });
}

describe('InMemoryConfirmationService', () => {
  it('opens a request in the required state with a TTL', () => {
    const service = buildService();
    const request = service.request('mock.purge', 'inv-1', 'critical', 'digest-1');
    expect(request.state).toBe('required');
    expect(request.toolId).toBe('mock.purge');
    expect(request.invocationId).toBe('inv-1');
    expect(request.riskLevel).toBe('critical');
    expect(request.requestedAt).toBe('2026-09-13T15:00:00.000Z');
    expect(request.expiresAt).toBe('2026-09-13T15:05:00.000Z');
    expect(request.decidedAt).toBeUndefined();
  });

  it('records an explicit approval - and never invents one', () => {
    const service = buildService();
    const request = service.request('mock.purge', 'inv-1', 'critical', 'digest-1');
    expect(service.get(request.id).state).toBe('required'); // no auto-approval
    tick = 1;
    const decided = service.decide(request.id, 'approved');
    expect(decided.state).toBe('approved');
    expect(decided.decidedAt).toBe('2026-09-13T15:01:00.000Z');
    expect(service.get(request.id).state).toBe('approved');
  });

  it('records an explicit rejection', () => {
    const service = buildService();
    const request = service.request('mock.purge', 'inv-1', 'critical', 'digest-1');
    expect(service.decide(request.id, 'rejected').state).toBe('rejected');
  });

  it('expires undecided requests once the TTL passes', () => {
    const service = buildService();
    const request = service.request('mock.purge', 'inv-1', 'critical', 'digest-1');
    tick = 4; // still inside the 5-minute TTL
    expect(service.get(request.id).state).toBe('required');
    tick = 6; // past expiry
    expect(service.get(request.id).state).toBe('expired');
    // An expired confirmation can no longer be decided.
    expect(() => service.decide(request.id, 'approved')).toThrow(/expired/);
  });

  it('approvals are single-use: consume once, then refuse', () => {
    const service = buildService();
    const request = service.request('mock.purge', 'inv-1', 'critical', 'digest-1');
    expect(() => service.consume(request.id)).toThrow(/not approved/);
    service.decide(request.id, 'approved');
    expect(service.consume(request.id).consumedAt).toBe('2026-09-13T15:00:00.000Z');
    expect(() => service.consume(request.id)).toThrow(/already been used/);
  });

  it('digestToolInput is stable across key order and never leaks values', () => {
    const a = digestToolInput({ x: 'secret-value-1', y: 2 });
    const b = digestToolInput({ y: 2, x: 'secret-value-1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain('secret-value-1');
  });

  it('rejects decisions on unknown or already-decided confirmations', () => {
    const service = buildService();
    expect(() => service.get('nope')).toThrow(/Unknown confirmation/);
    const request = service.request('mock.purge', 'inv-1', 'critical', 'digest-1');
    service.decide(request.id, 'approved');
    expect(() => service.decide(request.id, 'rejected')).toThrow(/already approved/);
  });
});
