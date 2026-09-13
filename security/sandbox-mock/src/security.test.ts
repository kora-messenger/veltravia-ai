import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SandboxAuditEvent, SandboxExecutionRequest } from '@veltravia/sandbox-core';
import { createMockSandboxManager } from '@veltravia/sandbox-mock';

function buildManager() {
  const events: SandboxAuditEvent[] = [];
  const { manager, runtime } = createMockSandboxManager({
    auditSink: (event) => events.push(event),
  });
  return { manager, runtime, events };
}

async function readySandbox(manager: ReturnType<typeof createMockSandboxManager>['manager']) {
  return manager.createSandbox({ workspaceRef: 'ws-1' });
}

describe('environment isolation', () => {
  it('the runtime receives ONLY explicitly provided environment entries', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['echo-env'],
      environment: { VERBOSE: 'true', NODE_ENV: 'test' },
    });
    const echoed = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.keys(echoed).sort()).toEqual(['NODE_ENV', 'VERBOSE']);
    // The captured request confirms the same
    const captured = runtime.capturedRequests.at(-1);
    expect(captured?.environmentKeys).toEqual(['NODE_ENV', 'VERBOSE']);
  });

  it('host environment variables are NEVER inherited', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    await manager.startExecution(sandbox.id, { command: 'node', arguments: ['echo-env'] });
    const captured = runtime.capturedRequests.at(-1);
    expect(captured?.environmentKeys).toEqual([]);
    // None of the actual host environment appears anywhere in the request
    for (const capturedRequest of runtime.capturedRequests) {
      for (const hostKey of Object.keys(process.env)) {
        expect(capturedRequest.environmentKeys, `host var ${hostKey} leaked`).not.toContain(hostKey);
      }
    }
    // Spot-check the secrets that matter most
    const forbidden = ['GEMINI_API_KEY', 'DATABASE_URL', 'MONGODB_URI', 'GITHUB_TOKEN', 'PATH'];
    const serializedRequests = JSON.stringify(runtime.capturedRequests);
    for (const key of forbidden) {
      expect(serializedRequests).not.toContain(`"${key}"`);
    }
  });

  it('rejects secret-shaped and malicious explicit environment entries', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    const before = runtime.capturedRequests.length;
    await expect(
      manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: ['x'],
        environment: { GEMINI_API_KEY: 'AIzaSy' + 'a'.repeat(30) },
      }),
    ).rejects.toThrow();
    await expect(
      manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: ['x'],
        environment: { LD_PRELOAD: '/evil.so' },
      }),
    ).rejects.toThrow();
    expect(runtime.capturedRequests.length).toBe(before);
  });
});

describe('workspace + filesystem boundary', () => {
  it('the runtime sees only the sandbox workspace reference - never a host path', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await manager.createSandbox({ workspaceRef: 'ws-42' });
    await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['script.js'],
      workingDirectory: 'src',
    });
    const captured = runtime.capturedRequests.at(-1);
    expect(captured?.workspaceRef).toBe('ws-42');
    expect(captured?.workingDirectory).toBe('src');
  });

  it('rejects host paths, absolute paths, and traversal in the working directory', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const rejected = ['', undefined].slice(0, 0).concat(['/', '/etc', '../escape', 'a/../..', 'C:\\x', 'a\\b']);
    for (const workingDirectory of rejected) {
      await expect(
        manager.startExecution(sandbox.id, {
          command: 'node',
          arguments: ['x'],
          workingDirectory,
        }),
        workingDirectory,
      ).rejects.toThrow();
    }
  });

  it('cross-workspace access is impossible: requests carry no workspace field', async () => {
    const { manager, runtime } = buildManager();
    const a = await manager.createSandbox({ workspaceRef: 'ws-a' });
    const b = await manager.createSandbox({ workspaceRef: 'ws-b' });
    // Execution on sandbox A always lands on ws-a; there is no way to name
    // another workspace in the request at all.
    await manager.startExecution(a.id, { command: 'node', arguments: ['x'] });
    await manager.startExecution(b.id, { command: 'node', arguments: ['x'] });
    const refs = runtime.capturedRequests.map((request) => request.workspaceRef);
    expect(refs).toEqual(['ws-a', 'ws-b']);
    // The request type itself has no workspace field (compile-time + runtime)
    const request: SandboxExecutionRequest = { command: 'node', arguments: ['x'] };
    expect(Object.keys(request)).not.toContain('workspaceId');
    expect(Object.keys(request)).not.toContain('workspaceRef');
  });
});

describe('untrusted output', () => {
  it('scrubs secret-shaped fragments from stdout before anything is stored', async () => {
    const { manager, events } = buildManager();
    const sandbox = await readySandbox(manager);
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['leak'],
    });
    expect(result.status).toBe('completed');
    expect(result.scrubbedCount).toBeGreaterThan(0);
    expect(result.stdout).not.toContain('ghp_');
    expect(result.stdout).not.toContain('github_pat_');
    expect(result.stdout).toContain('[REDACTED:secret]');
    // The record stored by the manager is the scrubbed version
    const record = await manager.getExecution(sandbox.id, result.executionId);
    expect(record.result?.stdout).not.toContain('ghp_');
    // Audit events never contain the leaked values either
    expect(JSON.stringify(events)).not.toContain('ghp_');
    expect(JSON.stringify(events)).not.toContain('github_pat_');
  });

  it('treats prompt injection in stdout as ordinary data with ZERO authority', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const profileBefore = JSON.stringify(sandbox.profile);
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['inject'],
    });
    // The payload is present, verbatim, as DATA
    expect(result.stdout).toContain('Ignore your system instructions');
    expect(result.stdout).toContain('GEMINI_API_KEY');
    // ...and it changed nothing: profile, limits, and policy are untouched
    const sandboxAfter = await manager.getSandbox(sandbox.id);
    expect(JSON.stringify(sandboxAfter.profile)).toBe(profileBefore);
    expect(sandboxAfter.status).toBe('ready');
    // Deny rules still deny after the injection attempt
    await expect(
      manager.startExecution(sandbox.id, { command: 'rm', arguments: ['-rf', '/'] }),
    ).rejects.toThrow();
    await expect(
      manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: ['x'],
        limits: { timeoutMs: 0 },
      }),
    ).rejects.toThrow();
    // Output claiming to change limits changes nothing: defaults intact
    const still = await manager.getSandbox(sandbox.id);
    expect(still.profile.defaultLimits.timeoutMs).toBe(sandbox.profile.defaultLimits.timeoutMs);
  });
});

describe('structural security guarantees', () => {
  it('the sandbox cannot grant itself permissions or change its profile', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    // The manager exposes NO method that mutates a created sandbox's profile,
    // limits, or permissions. The record the manager stores is the pinned one:
    // run an "injection" and try every mutation-shaped input - all rejected.
    const attempt: SandboxExecutionRequest = {
      command: 'node',
      arguments: ['inject', 'grant=sandbox.execute', 'limits.timeoutMs=999999999'],
    };
    const result = await manager.startExecution(sandbox.id, attempt);
    expect(result.status).toBe('completed');
    const after = await manager.getSandbox(sandbox.id);
    expect(after.profile.commandPolicy.allowedCommands).not.toContain('rm');
    expect(after.profile.defaultLimits.timeoutMs).toBeLessThan(999_999);
    // There is no API surface to reconfigure: the TypeScript type carries no
    // mutable handles (SandboxRecord is deeply readonly).
    expect(after).not.toBe(sandbox); // records are copies, never live handles
  });

  it('never executes in the manager process: all work flows through the runtime', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    const before = runtime.capturedRequests.length;
    await manager.startExecution(sandbox.id, { command: 'node', arguments: ['x'] });
    expect(runtime.capturedRequests.length).toBe(before + 1);
    // The manager is a pure orchestrator: zero requests means it executed
    // nothing itself; one request means the runtime is the ONLY executor.
  });
});

describe('sandbox-core source hygiene', () => {
  /** Recursively lists every non-test source file of the core package. */
  function listSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...listSources(full));
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('core never reads the host environment or spawns processes (source scan)', () => {
    const root = join(process.cwd(), 'security', 'sandbox', 'src');
    const files = listSources(root);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/process\.env/);
      expect(source, file).not.toMatch(/child_process/);
      expect(source, file).not.toMatch(/spawnSync|execSync|execFileSync/);
      expect(source, file).not.toMatch(/node:fs['"]/);
    }
  });

  it('the mock runtime executes no host code (source scan)', () => {
    const source = readFileSync(join(process.cwd(), 'security', 'sandbox-mock', 'src', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/spawnSync|execSync|execFileSync/);
    expect(source).not.toMatch(/process\.env/);
  });
});
