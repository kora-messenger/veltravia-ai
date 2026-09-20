import { describe, expect, it } from 'vitest';
import {
  commandsEqual,
  DEFAULT_RUNTIME_LIMITS,
  isSecretShapedKey,
  isSecretShapedValue,
  isSafeWorkspacePath,
  RUNTIME_LIMIT_CEILINGS,
  RuntimeEnvironmentRejectedError,
  RuntimePlanRejectedError,
  validateRuntimeCommand,
  validateRuntimeEnvironment,
  validateRuntimeLimits,
  validateRuntimePlan,
  type RuntimePlan,
} from '@veltravia/runtime-core';

function validPlan(overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return validateRuntimePlan({
    runtimeType: 'web',
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    expectedRevision: 3,
    requiredFiles: ['package.json'],
    buildCommand: { executable: 'npm', arguments: ['run', 'build'] },
    startCommand: { executable: 'npm', arguments: ['run', 'preview'] },
    port: 4173,
    environment: {},
    healthCheck: { path: '/', intervalMs: 500, timeoutMs: 5000, maxChecks: 20 },
    limits: { ...DEFAULT_RUNTIME_LIMITS },
    evidence: ['manifest: package.json present'],
    ...overrides,
  });
}

describe('runtime command validation', () => {
  it('accepts structured allowlisted commands', () => {
    expect(() =>
      validateRuntimeCommand({ executable: 'npm', arguments: ['run', 'build'] }, 'buildCommand'),
    ).not.toThrow();
  });

  it('rejects shell metacharacters in executable and arguments', () => {
    expect(() =>
      validateRuntimeCommand(
        { executable: 'npm', arguments: ['run && echo pwned'] },
        'startCommand',
      ),
    ).toThrow(RuntimePlanRejectedError);
    expect(() =>
      validateRuntimeCommand({ executable: 'sh', arguments: [] }, 'startCommand'),
    ).toThrow(RuntimePlanRejectedError);
  });

  it('rejects path-like executables and disallowed binaries', () => {
    expect(() =>
      validateRuntimeCommand({ executable: '/usr/bin/node', arguments: [] }, 'startCommand'),
    ).toThrow(RuntimePlanRejectedError);
    expect(() =>
      validateRuntimeCommand({ executable: 'curl', arguments: [] }, 'startCommand'),
    ).toThrow(RuntimePlanRejectedError);
  });

  it('rejects unsafe working directories', () => {
    expect(() =>
      validateRuntimeCommand(
        { executable: 'npm', arguments: [], workingDirectory: '../outside' },
        'startCommand',
      ),
    ).toThrow(RuntimePlanRejectedError);
  });
});

describe('runtime environment validation (secrets)', () => {
  it('rejects credential-shaped keys', () => {
    expect(() => validateRuntimeEnvironment({ GITHUB_TOKEN: 'abc' })).toThrow(
      RuntimeEnvironmentRejectedError,
    );
    expect(() => validateRuntimeEnvironment({ apiKey: 'value' })).toThrow(
      RuntimeEnvironmentRejectedError,
    );
  });

  it('rejects credential-shaped values under innocent keys', () => {
    expect(() => validateRuntimeEnvironment({ CONFIG: 'sk-abcdefgh1234567890' })).toThrow(
      RuntimeEnvironmentRejectedError,
    );
    expect(() => validateRuntimeEnvironment({ BLOB: 'ghp_' + 'a'.repeat(30) })).toThrow(
      RuntimeEnvironmentRejectedError,
    );
  });

  it('accepts plain non-secret entries', () => {
    expect(() => validateRuntimeEnvironment({ NODE_ENV: 'production' })).not.toThrow();
  });

  it('detects secret shapes standalone', () => {
    expect(isSecretShapedKey('PAYSTACK_SECRET_KEY')).toBe(true);
    expect(isSecretShapedKey('PORT')).toBe(false);
    expect(isSecretShapedValue('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(isSecretShapedValue('hello world')).toBe(false);
  });
});

describe('runtime limits validation', () => {
  it('rejects values above hard ceilings', () => {
    expect(() =>
      validateRuntimeLimits({
        ...DEFAULT_RUNTIME_LIMITS,
        maxMemoryMb: RUNTIME_LIMIT_CEILINGS.maxMemoryMb + 1,
      }),
    ).toThrow(RuntimePlanRejectedError);
    expect(() =>
      validateRuntimeLimits({
        ...DEFAULT_RUNTIME_LIMITS,
        maxLifetimeMs: RUNTIME_LIMIT_CEILINGS.maxLifetimeMs * 2,
      }),
    ).toThrow(RuntimePlanRejectedError);
  });

  it('rejects unlimited and invalid values', () => {
    expect(() => validateRuntimeLimits({ ...DEFAULT_RUNTIME_LIMITS, buildTimeoutMs: 0 })).toThrow(
      RuntimePlanRejectedError,
    );
    expect(() => validateRuntimeLimits({ ...DEFAULT_RUNTIME_LIMITS, buildTimeoutMs: -1 })).toThrow(
      RuntimePlanRejectedError,
    );
  });

  it('rejects idle timeout above lifetime', () => {
    expect(() =>
      validateRuntimeLimits({
        ...DEFAULT_RUNTIME_LIMITS,
        idleTimeoutMs: DEFAULT_RUNTIME_LIMITS.maxLifetimeMs + 1,
      }),
    ).toThrow(RuntimePlanRejectedError);
  });
});

describe('runtime plan validation', () => {
  it('accepts a valid plan unchanged', () => {
    const plan = validPlan();
    expect(plan.runtimeType).toBe('web');
    expect(plan.port).toBe(4173);
  });

  it('rejects inactive runtime types', () => {
    expect(() => validPlan({ runtimeType: 'mobile-preview' as never })).toThrow(
      RuntimePlanRejectedError,
    );
    expect(() => validPlan({ runtimeType: 'backend' as never })).toThrow(RuntimePlanRejectedError);
  });

  it('rejects out-of-range ports', () => {
    expect(() => validPlan({ port: 80 })).toThrow(RuntimePlanRejectedError);
    expect(() => validPlan({ port: 70000 })).toThrow(RuntimePlanRejectedError);
  });

  it('rejects unsafe required files', () => {
    expect(() => validPlan({ requiredFiles: ['../etc/passwd'] })).toThrow(RuntimePlanRejectedError);
    expect(() => validPlan({ requiredFiles: ['/absolute/path'] })).toThrow(
      RuntimePlanRejectedError,
    );
  });

  it('validates safe workspace paths', () => {
    expect(isSafeWorkspacePath('src/main.tsx')).toBe(true);
    expect(isSafeWorkspacePath('server/index.ts')).toBe(true);
    expect(isSafeWorkspacePath('../escape')).toBe(false);
    expect(isSafeWorkspacePath('/abs')).toBe(false);
    expect(isSafeWorkspacePath('')).toBe(false);
  });

  it('bounds health checks', () => {
    expect(() =>
      validPlan({ healthCheck: { path: '/', intervalMs: 500, timeoutMs: 5000, maxChecks: 999 } }),
    ).toThrow(RuntimePlanRejectedError);
  });
});

describe('command equality', () => {
  it('matches only identical executable + arguments', () => {
    const a = { executable: 'npm', arguments: ['run', 'preview'] };
    expect(commandsEqual(a, { executable: 'npm', arguments: ['run', 'preview'] })).toBe(true);
    expect(commandsEqual(a, { executable: 'npm', arguments: ['run', 'dev'] })).toBe(false);
    expect(commandsEqual(a, null)).toBe(false);
    expect(commandsEqual(null, null)).toBe(true);
  });
});
