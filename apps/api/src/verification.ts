/**
 * Verification service (Step 45).
 *
 * The seam between the verification engine and the Step 8 sandbox. The engine
 * decides WHAT may run; this file decides WHERE it runs and records how honest
 * that environment is.
 *
 * Two runtimes exist:
 *  - `local`  a real child-process runtime (process containment only: no OS
 *             isolation, no network enforcement, no filesystem jail);
 *  - none     the default. Without a real runtime a verification run is
 *             recorded as `blocked` - never as a pass - because no command
 *             actually executed.
 *
 * The mock sandbox is deliberately NOT used here: a simulated result must never
 * be stored as evidence that a project's tests passed.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxRuntime } from '@veltravia/sandbox-core';
import { SandboxManager } from '@veltravia/sandbox-core';
import { createLocalSandboxRuntime } from '@veltravia/sandbox-local';
import {
  InMemoryVerificationStore,
  VerificationRunner,
  detectVerificationProfile,
  type ProjectFile,
  type ProjectFileSource,
  type RawExecution,
  type VerificationExecutor,
  type VerificationLimits,
  type VerificationSession,
  type VerificationStore,
} from '@veltravia/verification-core';

import type { Persistence } from './persistence.js';

/** Files larger than this are not copied into a sandbox. */
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 600;

export interface VerificationExecution {
  /** Runtime that executes commands, or null when none is configured. */
  readonly runtimeId: string | null;
  readonly providesOsIsolation: boolean;
  /** Limits the runtime cannot enforce, named. Always includes the network. */
  readonly unenforced: readonly string[];
  /** Plain reason a run cannot verify anything, when that is the case. */
  readonly blockedReason: string | null;
}

export interface VerificationService {
  readonly runner: VerificationRunner;
  readonly store: VerificationStore;
  readonly durable: boolean;
  readonly execution: VerificationExecution;
  /** Detected profile of a project's current revision, without executing. */
  profile(input: { projectId: string }): Promise<{
    readonly profile: ReturnType<typeof detectVerificationProfile>;
    readonly revision: string | null;
  }>;
}

/** Reads every file of a project's first active workspace. */
export function createProjectFileSource(projects: ProjectEngine): ProjectFileSource {
  return {
    async read(input) {
      const workspaces = await projects.workspaces.listWorkspaces(input.projectId);
      const workspace = workspaces[0];
      if (workspace === undefined) {
        return { files: [], revision: null };
      }
      const nodes = (await projects.files.listAll(workspace.id)).filter(
        (node) => node.type === 'file',
      );
      const files: ProjectFile[] = [];
      for (const node of nodes.slice(0, MAX_FILES)) {
        const read = await projects.files.readFile(workspace.id, node.path);
        files.push({ path: node.path, content: read.content.slice(0, MAX_FILE_BYTES) });
      }
      return { files, revision: `${workspace.id}@${workspace.revision}` };
    },
  };
}

function safeRelative(path: string): string | null {
  if (path.startsWith('/') || path.includes('\\')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.'))
    return null;
  return path;
}

/**
 * Materialises a revision into a fresh directory, so what runs is a snapshot:
 * a worker writing a file mid-run cannot change what the command sees.
 */
async function materialize(root: string, files: readonly ProjectFile[]): Promise<string> {
  const dir = await mkdtemp(join(root, 'verify-'));
  for (const file of files) {
    const relative = safeRelative(file.path);
    if (relative === null) continue;
    const target = join(dir, relative);
    if (!resolve(target).startsWith(resolve(dir))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  return dir;
}

export interface SandboxExecutorOptions {
  readonly runtime: SandboxRuntime;
  /** Directory that sandbox workspaces may live under. */
  readonly rootDir?: string;
}

/** Verification executor backed by the Step 8 sandbox manager. */
export function createSandboxVerificationExecutor(
  options: SandboxExecutorOptions,
): VerificationExecutor {
  const root =
    options.rootDir ??
    process.env['VELTRAVIA_VERIFICATION_DIR'] ??
    join(tmpdir(), 'veltravia-verify');
  const manager = new SandboxManager({ runtime: options.runtime });

  return {
    async prepare(input) {
      await mkdir(root, { recursive: true });
      const directory = await materialize(root, input.files);
      // The reference is the directory name the runtime resolves under its
      // root, so the sandbox and the real path cannot drift apart.
      const ref = basename(directory);

      const sandbox = await manager.createSandbox({
        workspaceRef: ref,
        commandPolicy: {
          allowedCommands: [...input.commandPolicy.allowedCommands],
          allowShellExecution: false,
        },
        networkPolicy: { mode: 'disabled', allowedDestinations: [] },
        defaultLimits: {
          timeoutMs: input.limits.timeoutMsPerOperation,
          maxMemoryMb: 512,
          maxCpuTimeMs: input.limits.timeoutMsPerOperation,
          maxOutputBytes: input.limits.maxOutputBytes,
          maxProcesses: 16,
          maxFileBytes: 8 * 1024 * 1024,
        },
        defaultEnvironment: {},
        ttlMs: Math.max(60_000, input.limits.timeoutMsPerOperation * 2 + 30_000),
      });

      const session: VerificationSession & {
        sandboxId: string;
        ref: string;
        lastExecutionId: string | null;
      } = {
        handle: { sandboxId: sandbox.id, ref },
        runtimeId: options.runtime.runtimeId,
        providesOsIsolation: options.runtime.providesOsIsolation,
        unenforced: ['network', 'memory', 'cpu-time', 'process-count', 'host-filesystem'],
        sandboxId: sandbox.id,
        ref,
        lastExecutionId: null,
        dispose: async () => {
          await manager.destroySandbox(sandbox.id).catch(() => undefined);
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        },
      };
      return session;
    },

    async execute(session, command, limits): Promise<RawExecution> {
      const target = session as VerificationSession & {
        sandboxId: string;
        lastExecutionId: string | null;
      };
      const started = Date.now();
      const result = await manager.startExecution(target.sandboxId, {
        command: command.command,
        arguments: [...command.args],
        workingDirectory: '.',
        environment: {},
        limits: { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes },
      });
      target.lastExecutionId = result.executionId;
      const unenforced = Object.entries(result.enforcement)
        .filter(([, state]) => state !== 'enforced')
        .map(([limit]) => limit);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.resourceUsage.durationMs || Date.now() - started,
        enforceableTimeout: result.enforcement.timeoutMs === 'enforced',
        runtimeId: options.runtime.runtimeId,
        providesOsIsolation: options.runtime.providesOsIsolation,
        unenforced: [...new Set([...unenforced, 'network', 'host-filesystem'])],
      };
    },

    async terminate(session) {
      const target = session as VerificationSession & {
        sandboxId: string;
        lastExecutionId: string | null;
      };
      if (target.lastExecutionId === null) return;
      await manager
        .cancelExecution(target.sandboxId, target.lastExecutionId)
        .catch(() => undefined);
    },
  };
}

/** An executor that refuses to run anything, so no result is invented. */
function unavailableExecutor(reason: string): VerificationExecutor {
  return {
    async prepare(): Promise<VerificationSession> {
      throw new Error(reason);
    },
    async execute(): Promise<RawExecution> {
      throw new Error(reason);
    },
  };
}

export function readSandboxRuntimeMode(env: NodeJS.ProcessEnv = process.env): 'local' | 'none' {
  const value = (env['VELTRAVIA_SANDBOX_RUNTIME'] ?? '').trim().toLowerCase();
  if (value === 'local' || value === 'process' || value === 'local-process') return 'local';
  return 'none';
}

export function createVerificationService(input: {
  readonly projects: ProjectEngine;
  readonly persistence?: Persistence | undefined;
  /** Tests inject a scripted executor; production uses the sandbox. */
  readonly executor?: VerificationExecutor;
  readonly runtime?: SandboxRuntime;
  readonly runtimeMode?: 'local' | 'none';
  readonly limits?: Partial<VerificationLimits>;
  readonly rootDir?: string;
}): VerificationService {
  const durableStore = input.persistence?.stores?.verification ?? null;
  const store: VerificationStore = durableStore ?? new InMemoryVerificationStore();
  const files = createProjectFileSource(input.projects);
  const mode = input.runtimeMode ?? readSandboxRuntimeMode();

  let executor: VerificationExecutor;
  let execution: VerificationExecution;

  if (input.executor !== undefined) {
    executor = input.executor;
    execution = {
      runtimeId: 'injected',
      providesOsIsolation: false,
      unenforced: ['network'],
      blockedReason: null,
    };
  } else if (input.runtime !== undefined || mode === 'local') {
    const root =
      input.rootDir ??
      process.env['VELTRAVIA_VERIFICATION_DIR'] ??
      join(tmpdir(), 'veltravia-verify');
    const runtime =
      input.runtime ??
      createLocalSandboxRuntime({
        allowedRoot: resolve(root),
        resolveWorkspace: (ref) => (ref.startsWith('verify_') ? join(resolve(root), ref) : null),
      });
    // The runtime resolves a ref to a directory created per run; the executor
    // registers each one as it is materialised.
    executor = createSandboxVerificationExecutor({ runtime, rootDir: root });
    execution = {
      runtimeId: runtime.runtimeId,
      providesOsIsolation: runtime.providesOsIsolation,
      unenforced: runtime.providesOsIsolation
        ? []
        : ['network', 'memory', 'cpu-time', 'process-count', 'host-filesystem'],
      blockedReason: null,
    };
  } else {
    const reason =
      'No execution runtime is configured, so no command was executed. Set VELTRAVIA_SANDBOX_RUNTIME=local to run verification in a local process, and read the limitations it reports.';
    executor = unavailableExecutor(reason);
    execution = {
      runtimeId: null,
      providesOsIsolation: false,
      unenforced: ['network', 'memory', 'cpu-time', 'process-count', 'host-filesystem'],
      blockedReason: reason,
    };
  }

  const runner = new VerificationRunner({
    executor,
    files,
    store,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });

  return {
    runner,
    store,
    durable: durableStore !== null,
    execution,
    async profile({ projectId }) {
      const reading = await files.read({ projectId, revision: null });
      return { profile: detectVerificationProfile(reading.files), revision: reading.revision };
    },
  };
}
