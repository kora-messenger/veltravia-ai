import { describe, expect, it } from 'vitest';
import {
  assertRuntimeTransition,
  canTransition,
  isLiveRuntimeStatus,
  isTerminalRuntimeStatus,
  RuntimeInvalidTransitionError,
} from '@veltravia/runtime-core';

describe('runtime state machine', () => {
  it('allows the full happy-path lifecycle', () => {
    expect(() => {
      assertRuntimeTransition('created', 'preparing');
      assertRuntimeTransition('preparing', 'building');
      assertRuntimeTransition('building', 'starting');
      assertRuntimeTransition('starting', 'running');
      assertRuntimeTransition('running', 'stopping');
      assertRuntimeTransition('stopping', 'stopped');
    }).not.toThrow();
  });

  it('allows starting directly from preparing (no build step)', () => {
    expect(() => assertRuntimeTransition('preparing', 'starting')).not.toThrow();
  });

  it('allows failure from every live phase', () => {
    for (const from of ['preparing', 'building', 'starting', 'running'] as const) {
      expect(canTransition(from, 'failed')).toBe(true);
    }
  });

  it('rejects illegal transitions', () => {
    expect(() => assertRuntimeTransition('stopped', 'running')).toThrow(
      RuntimeInvalidTransitionError,
    );
    expect(() => assertRuntimeTransition('created', 'running')).toThrow(
      RuntimeInvalidTransitionError,
    );
    expect(() => assertRuntimeTransition('expired', 'preparing')).toThrow(
      RuntimeInvalidTransitionError,
    );
  });

  it('treats stopped/failed/expired/cancelled as terminal', () => {
    for (const status of ['stopped', 'failed', 'expired', 'cancelled'] as const) {
      expect(isTerminalRuntimeStatus(status)).toBe(true);
    }
    expect(isTerminalRuntimeStatus('running')).toBe(false);
  });

  it('identifies live states', () => {
    expect(isLiveRuntimeStatus('preparing')).toBe(true);
    expect(isLiveRuntimeStatus('building')).toBe(true);
    expect(isLiveRuntimeStatus('running')).toBe(true);
    expect(isLiveRuntimeStatus('stopped')).toBe(false);
    expect(isLiveRuntimeStatus('failed')).toBe(false);
  });
});
