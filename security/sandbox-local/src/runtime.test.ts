import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeExecutionRequest } from '@veltravia/sandbox-core';
import { describe, expect, it } from 'vitest';

import { createLocalSandboxRuntime } from './index.js';

/**
 * These run REAL processes. They are deterministic: the commands are `node -e`
 * snippets this repository owns, there is no network and no fixture project.
 * The opt-in suite that runs an actual project test suite lives in
 * apps/api/src/verification-live.test.ts behind VELTRAVIA_LIVE_SANDBOX.
 */

const NODE = 'node';
// Created at module scope so the runtime below is built with a real root.
const root = mkdtempSync(join(tmpdir(), 'veltravia-local-'));
mkdirSync(join(root, 'workspace'), { recursive: true });
writeFileSync(join(root, 'workspace', 'hello.txt'), 'hello', 'utf8');

function request(over: Partial<RuntimeExecutionRequest> = {}): RuntimeExecutionRequest {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    sandboxId: 'sandbox-1',
    workspaceRef: 'workspace',
    command: NODE,
    arguments: ['-e', "console.log('hi')"],
    workingDirectory: '.',
    environment: {},
    limits: {
      timeoutMs: 5_000,
      maxMemoryMb: 128,
      maxCpuTimeMs: 5_000,
      maxOutputBytes: 8_000,
      maxProcesses: 2,
      maxFileBytes: 1_000,
    },
    networkPolicy: { mode: 'disabled', allowedDestinations: [] },
    ...over,
  };
}

const runtime = createLocalSandboxRuntime({
  allowedRoot: root,
  resolveWorkspace: (ref) => (ref === 'workspace' ? join(root, 'workspace') : null),
});

describe('local process runtime', () => {
  it('reports honestly that it provides no OS isolation', () => {
    expect(runtime.providesOsIsolation).toBe(false);
    expect(runtime.runtimeId).toBe('local-process');
  });

  it('runs a real command and captures its output', async () => {
    const outcome = await runtime.execute(
      request({ arguments: ['-e', "console.log('hello from a child process')"] }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('hello from a child process');
    expect(outcome.timedOut).toBe(false);
  });

  it('reports the real exit code of a failing command', async () => {
    const outcome = await runtime.execute(request({ arguments: ['-e', 'process.exit(3)'] }));
    expect(outcome.exitCode).toBe(3);
  });

  it('kills a command that outlives its timeout', async () => {
    const outcome = await runtime.execute(
      request({
        arguments: ['-e', 'setTimeout(() => {}, 10000)'],
        limits: { ...request().limits, timeoutMs: 300 },
      }),
    );
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  });

  it('truncates output past the byte cap and says so', async () => {
    const outcome = await runtime.execute(
      request({
        arguments: ['-e', "process.stdout.write('x'.repeat(20000))"],
        limits: { ...request().limits, maxOutputBytes: 500 },
      }),
    );
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThanOrEqual(500);
  });

  it('never inherits the host environment or a forbidden entry', async () => {
    process.env['VELTRAVIA_CREDENTIAL_KEY'] = 'host-secret-value';
    process.env['GROQ_API_KEY'] = 'host-groq-key';
    const outcome = await runtime.execute(
      request({
        arguments: ['-e', 'console.log(JSON.stringify(process.env))'],
        environment: { GROQ_API_KEY: 'asked-for', SAFE_FLAG: '1' },
      }),
    );
    const child: Record<string, string> = JSON.parse(outcome.stdout.trim());
    expect(child['VELTRAVIA_CREDENTIAL_KEY']).toBeUndefined();
    expect(child['GROQ_API_KEY']).toBeUndefined();
    expect(child['SAFE_FLAG']).toBe('1');
    expect(child['CI']).toBe('1');
    delete process.env['VELTRAVIA_CREDENTIAL_KEY'];
    delete process.env['GROQ_API_KEY'];
  });

  it('refuses an unknown workspace and a working directory outside it', async () => {
    const unknown = await runtime.execute(request({ workspaceRef: 'nope' }));
    expect(unknown.exitCode).toBeNull();
    expect(unknown.stderr).toContain('not registered');

    const escape = await runtime.execute(request({ workingDirectory: '../' }));
    expect(escape.exitCode).toBeNull();
    expect(escape.stderr).toContain('outside the workspace');
  });

  it('refuses an executable given as a path', async () => {
    const outcome = await runtime.execute(request({ command: '/bin/sh' }));
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderr).toContain('bare executable name');
  });

  it('terminates a running execution on request', async () => {
    const executionId = 'exec-cancel-me';
    const pending = runtime.execute(
      request({ executionId, arguments: ['-e', 'setTimeout(() => {}, 10000)'] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtime.terminate(executionId);
    const outcome = await pending;
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true);
    expect(outcome.terminated).toBe(true);
  });

  it('reports which limits it enforces and which it cannot', async () => {
    const outcome = await runtime.execute(request());
    expect(outcome.enforcement['timeoutMs']).toBe('enforced');
    expect(outcome.enforcement['maxOutputBytes']).toBe('enforced');
    expect(outcome.enforcement['maxMemoryMb']).toBe('unavailable');
    expect(outcome.enforcement['maxProcesses']).toBe('unavailable');
  });

  it('refuses to resolve a workspace outside the allowed root', async () => {
    const escaping = createLocalSandboxRuntime({
      allowedRoot: root,
      resolveWorkspace: () => '/etc',
    });
    const outcome = await escaping.execute(request());
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderr).toContain('outside the permitted root');
  });
});
