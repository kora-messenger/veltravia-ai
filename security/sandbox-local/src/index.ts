/**
 * Local process sandbox runtime - Step 45.
 *
 * What this is: a real child-process runner. Commands are spawned with an argv
 * array, never a shell; the environment is a fixed, explicit set; the working
 * directory must resolve inside a registered workspace root; the process group
 * is killed on timeout or cancellation; output is capped and the record says
 * how much was cut.
 *
 * What this is NOT: operating-system isolation. There is no namespace, no
 * cgroup, no seccomp profile, no non-root user and no filesystem jail. This
 * process shares the host kernel and filesystem with the API, and the runtime
 * reports `providesOsIsolation: false` plus a per-limit enforcement map saying
 * exactly which limits were enforced and which were not. Do not replace the
 * mock with this and describe the result as isolated.
 */

import { spawn } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type {
  ResourceEnforcement,
  RuntimeExecutionOutcome,
  RuntimeExecutionRequest,
  SandboxRuntime,
} from '@veltravia/sandbox-core';

export interface LocalRuntimeOptions {
  /**
   * Resolves a sandbox workspace reference to an absolute directory this
   * runtime is allowed to run in. Every path must sit inside `allowedRoot`.
   */
  readonly resolveWorkspace: (workspaceRef: string) => string | null;
  /** Root that no execution may leave. Defaults to the resolved workspaces' root. */
  readonly allowedRoot: string;
  /** Environment every child gets. Nothing else is inherited. */
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  /** Kill grace before SIGKILL, in milliseconds. */
  readonly killGraceMs?: number;
}

/** The node that hosts this process is the node a project's tools need. */
const NODE_BIN = dirname(process.execPath);

const DEFAULT_ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`,
  NODE_ENV: 'test',
  CI: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};

const FORBIDDEN_ENV =
  /^(.*_API_KEY|.*_SECRET|.*_TOKEN|.*PASSWORD.*|AWS_.*|GITHUB_TOKEN.*|OPENAI_.*|ANTHROPIC_.*|GROQ_.*|OPENROUTER_.*|VELTRAVIA_CREDENTIAL_KEY|DATABASE_URL)$/;

interface Running {
  readonly child: ReturnType<typeof spawn>;
  readonly executionId: string;
  killed: boolean;
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  return !isAbsolute(rel);
}

export function createLocalSandboxRuntime(options: LocalRuntimeOptions): SandboxRuntime {
  const running = new Map<string, Running>();
  const killGraceMs = options.killGraceMs ?? 2_000;
  const baseEnvironment = { ...DEFAULT_ENVIRONMENT, ...(options.baseEnvironment ?? {}) };

  const enforcement: ResourceEnforcement = {
    timeoutMs: 'enforced',
    maxOutputBytes: 'enforced',
    maxMemoryMb: 'unavailable',
    maxCpuTimeMs: 'unavailable',
    maxProcesses: 'unavailable',
    maxFileBytes: 'unavailable',
  };

  async function kill(run: Running): Promise<void> {
    if (run.killed) return;
    run.killed = true;
    const pid = run.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      run.child.kill('SIGTERM');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, killGraceMs));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      run.child.kill('SIGKILL');
    }
  }

  return {
    runtimeId: 'local-process',
    providesOsIsolation: false,

    async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionOutcome> {
      const workspace = options.resolveWorkspace(request.workspaceRef);
      if (workspace === null) {
        return failed('The sandbox workspace is not registered with this runtime.');
      }
      if (!insideRoot(options.allowedRoot, workspace)) {
        return failed('The sandbox workspace is outside the permitted root.');
      }
      const cwd =
        request.workingDirectory === '.' ? workspace : resolve(workspace, request.workingDirectory);
      if (!insideRoot(workspace, cwd)) {
        return failed('The requested working directory is outside the workspace.');
      }
      if (request.command.includes('/') || request.command.includes('\\')) {
        return failed('A command must be a bare executable name.');
      }

      const environment: Record<string, string> = { ...baseEnvironment };
      for (const [name, value] of Object.entries(request.environment ?? {})) {
        if (FORBIDDEN_ENV.test(name)) continue;
        environment[name] = value;
      }

      const startedAt = Date.now();
      return await new Promise<RuntimeExecutionOutcome>((resolvePromise) => {
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let truncated = false;
        let timedOut = false;
        let settled = false;

        const child = spawn(request.command, [...request.arguments], {
          cwd,
          env: environment,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const record: Running = { child, executionId: request.executionId, killed: false };
        running.set(request.executionId, record);

        const collect = (chunk: Buffer, target: 'out' | 'err'): void => {
          const remaining = request.limits.maxOutputBytes - outputBytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
          if (slice.byteLength < chunk.byteLength) truncated = true;
          outputBytes += slice.byteLength;
          if (target === 'out') stdout += slice.toString('utf8');
          else stderr += slice.toString('utf8');
        };

        child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
        child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

        const timer = setTimeout(() => {
          timedOut = true;
          void kill(record);
        }, request.limits.timeoutMs);

        const finish = (exitCode: number | null, spawnFailure?: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          running.delete(request.executionId);
          if (spawnFailure !== undefined) stderr = `${stderr}\n${spawnFailure}`;
          resolvePromise({
            exitCode,
            stdout,
            stderr,
            timedOut,
            terminated: record.killed && !timedOut,
            terminationReason: timedOut ? 'cpu' : record.killed ? 'cancelled' : null,
            truncated,
            resourceUsage: {
              cpuTimeMs: 0,
              memoryPeakMb: 0,
              outputBytes,
              durationMs: Date.now() - startedAt,
              processCount: 1,
              fileBytesWritten: 0,
            },
            enforcement,
          });
        };

        child.on('error', (error: Error) => finish(null, `spawn failed: ${error.message}`));
        child.on('close', (code: number | null) => finish(code));
      });
    },

    async terminate(executionId: string): Promise<void> {
      const run = running.get(executionId);
      if (run !== undefined) await kill(run);
    },

    async cleanup(sandboxId: string): Promise<void> {
      for (const run of [...running.values()]) {
        if (run.executionId.startsWith(sandboxId)) await kill(run);
      }
    },
  };
}

function failed(reason: string): RuntimeExecutionOutcome {
  return {
    exitCode: null,
    stdout: '',
    stderr: reason,
    timedOut: false,
    terminated: false,
    terminationReason: null,
    truncated: false,
    resourceUsage: {
      cpuTimeMs: 0,
      memoryPeakMb: 0,
      outputBytes: 0,
      durationMs: 0,
      processCount: 0,
      fileBytesWritten: 0,
    },
    enforcement: {
      timeoutMs: 'enforced',
      maxOutputBytes: 'enforced',
      maxMemoryMb: 'unavailable',
      maxCpuTimeMs: 'unavailable',
      maxProcesses: 'unavailable',
      maxFileBytes: 'unavailable',
    },
  };
}
