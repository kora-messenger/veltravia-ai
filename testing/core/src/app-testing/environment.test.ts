import { describe, expect, it } from 'vitest';
import { describeEnvironment } from './environment.js';

describe('describing the execution environment', () => {
  it('says a mock runtime executed no real code and has no isolation', () => {
    const env = describeEnvironment({ runtimeId: 'mock', providesOsIsolation: false }, 'disabled');
    expect(env).toEqual({
      runtimeId: 'mock',
      osIsolation: false,
      executedRealCode: false,
      networkPolicy: 'disabled',
    });
  });

  it('recognises simulator ids however they are spelled', () => {
    for (const runtimeId of ['MOCK', 'sandbox-mock', 'my-mock-runtime', 'simulated', '  mock ']) {
      const env = describeEnvironment({ runtimeId, providesOsIsolation: true });
      expect(env.executedRealCode, runtimeId).toBe(false);
    }
  });

  it('counts a real isolating runtime as having executed real code', () => {
    const env = describeEnvironment({ runtimeId: 'container', providesOsIsolation: true });
    expect(env.executedRealCode).toBe(true);
    expect(env.osIsolation).toBe(true);
  });

  it('does not trust a runtime that declares no isolation', () => {
    const env = describeEnvironment({ runtimeId: 'container', providesOsIsolation: false });
    expect(env.executedRealCode).toBe(false);
    expect(env.osIsolation).toBe(false);
  });

  it('treats an empty or blank runtime id as unknown and not real', () => {
    const env = describeEnvironment({ runtimeId: '   ', providesOsIsolation: true });
    expect(env.runtimeId).toBe('unknown');
    expect(env.executedRealCode).toBe(false);
  });

  it('defaults the network policy to unknown rather than guessing disabled', () => {
    expect(
      describeEnvironment({ runtimeId: 'container', providesOsIsolation: true }).networkPolicy,
    ).toBe('unknown');
  });

  it('never reports isolation the runtime did not declare', () => {
    const env = describeEnvironment({
      runtimeId: 'container',
      providesOsIsolation: undefined as unknown as boolean,
    });
    expect(env.osIsolation).toBe(false);
    expect(env.executedRealCode).toBe(false);
  });
});
