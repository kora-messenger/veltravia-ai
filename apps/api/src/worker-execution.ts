/**
 * Which executor runs a Superagent, and what its tools actually touch.
 *
 * The model executor is the real one: it goes through the same AI gateway as
 * everything else in Veltravia, so credentials stay in the encrypted vault and
 * the owner's own connection picks the provider. When no provider is connected
 * it refuses, with a reason the Primary Agent can act on; it never pretends to
 * have worked.
 *
 * Tools are implemented against the project engine that the coding agent, the
 * app builder and the source explorer already share. A worker writes a new file
 * or an existing one inside its own scope, and every write is listed as a
 * changed path so review can check it.
 */

import { WorkerError, type WorkerAssignment, type WorkerExecutor } from '@veltravia/worker-core';
import { SimulatedExecutor } from '@veltravia/worker-core';
import {
  ModelWorkerExecutor,
  type WorkerToolHandler,
  type WorkerToolOutcome,
} from '@veltravia/superagent-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { GatewayService } from './ai-gateway-service.js';

export type WorkerExecutionMode = 'model' | 'simulated';

export function resolveWorkerExecutionMode(
  env: NodeJS.ProcessEnv = process.env,
): WorkerExecutionMode {
  const raw = (env.VELTRAVIA_WORKER_EXECUTOR ?? '').trim().toLowerCase();
  return raw === 'simulated' ? 'simulated' : 'model';
}

async function firstWorkspaceId(engine: ProjectEngine, projectId: string): Promise<string | null> {
  const workspaces = await engine.workspaces.listWorkspaces(projectId);
  const active = workspaces.find((workspace) => workspace.status === 'active') ?? workspaces[0];
  return active?.id ?? null;
}

function refuse(code: string, message: string): WorkerToolOutcome {
  return { ok: false, code, message };
}

export function createProjectToolHandlers(
  engine: ProjectEngine,
  workspaceFor: (projectId: string | null) => Promise<string | null> = async (projectId) =>
    projectId === null ? null : firstWorkspaceId(engine, projectId),
): Record<string, WorkerToolHandler> {
  const workspace = async (projectId: string | null): Promise<string | null> =>
    projectId === null ? null : workspaceFor(projectId);

  const handlers: Record<string, WorkerToolHandler> = {
    'project.list': async (invocation, context) => {
      const workspaceId = await workspace(context.projectId);
      if (workspaceId === null)
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That project has no workspace yet.');
      const prefix =
        typeof invocation.arguments['path'] === 'string' ? invocation.arguments['path'] : '';
      const nodes = await engine.files.listAll(workspaceId);
      const listed = nodes
        .filter((node) =>
          prefix === '' ? true : node.path === prefix || node.path.startsWith(`${prefix}/`),
        )
        .slice(0, 200)
        .map((node) => `${node.type === 'directory' ? 'dir ' : 'file'} ${node.path}`);
      return { ok: true, output: listed.join('\n'), bytes: listed.join('\n').length };
    },

    'project.read': async (invocation, context) => {
      const workspaceId = await workspace(context.projectId);
      if (workspaceId === null)
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That project has no workspace yet.');
      const path = String(invocation.arguments['path']);
      try {
        const read = await engine.files.readFile(workspaceId, path);
        const content = read.content.slice(0, 20_000);
        return { ok: true, output: content, bytes: content.length };
      } catch {
        return refuse('WORKER_TOOL_NOT_FOUND', `There is no file at ${path}.`);
      }
    },

    'project.search': async (invocation, context) => {
      const workspaceId = await workspace(context.projectId);
      if (workspaceId === null)
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That project has no workspace yet.');
      const query = String(invocation.arguments['query'] ?? '');
      if (query.trim().length === 0)
        return refuse('WORKER_TOOL_ARGUMENTS_INVALID', 'query is required.');
      const nodes = (await engine.files.listAll(workspaceId))
        .filter((node) => node.type === 'file')
        .slice(0, 400);
      const hits: string[] = [];
      for (const node of nodes) {
        try {
          const read = await engine.files.readFile(workspaceId, node.path);
          const index = read.content.indexOf(query);
          if (index >= 0) {
            const line = read.content.slice(0, index).split('\n').length;
            hits.push(`${node.path}:${line}`);
          }
        } catch {
          continue;
        }
        if (hits.length >= 40) break;
      }
      return { ok: true, output: hits.join('\n'), bytes: hits.join('\n').length };
    },

    'project.structure': async (_invocation, context) => {
      const workspaceId = await workspace(context.projectId);
      if (workspaceId === null)
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That project has no workspace yet.');
      const nodes = await engine.files.listAll(workspaceId);
      const counts = new Map<string, number>();
      for (const node of nodes) {
        if (node.type !== 'file') continue;
        const extension = node.path.includes('.') ? (node.path.split('.').pop() ?? 'none') : 'none';
        counts.set(extension, (counts.get(extension) ?? 0) + 1);
      }
      const output = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([extension, count]) => `${extension}: ${count} file(s)`)
        .join('\n');
      return { ok: true, output, bytes: output.length };
    },

    'project.write': async (invocation, context) => {
      const workspaceId = await workspace(context.projectId);
      if (workspaceId === null)
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That project has no workspace yet.');
      const path = String(invocation.arguments['path']);
      const content = String(invocation.arguments['content'] ?? '');
      if (content.length > 60_000) {
        return refuse(
          'WORKER_OUTPUT_TOO_LARGE',
          'That file is larger than one worker may write in one call.',
        );
      }
      try {
        const current = await engine.files.readFile(workspaceId, path);
        await engine.files.updateFile(workspaceId, path, {
          content,
          expectedRevision: current.node.revision,
        });
      } catch {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
        if (parent !== null) {
          try {
            await engine.files.createDirectory(workspaceId, parent);
          } catch {
            // The directory may already exist; the create call below reports it.
          }
        }
        try {
          await engine.files.createFile(workspaceId, { path, content });
        } catch (error) {
          return refuse(
            'WORKER_TOOL_FAILED',
            error instanceof Error ? error.message : 'The project refused that file.',
          );
        }
      }
      return { ok: true, output: `wrote ${path}`, bytes: content.length, changedPaths: [path] };
    },

    // Documentation writes go through exactly the same guarded file write.
    'docs.write': (invocation, context) => handlers['project.write']!(invocation, context),

    'tests.run': async () =>
      refuse(
        'WORKER_TOOL_UNAVAILABLE',
        'Running tests from a worker is not wired to a sandbox runner in this build.',
      ),

    'schema.inspect': async (_invocation, context) => {
      const workspaceId = await workspace(context.projectId);
      if (workspaceId === null)
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That project has no workspace yet.');
      const nodes = (await engine.files.listAll(workspaceId)).filter(
        (node) => node.type === 'file',
      );
      const candidates = nodes
        .filter((node) => /schema\.prisma$|migrations?\/.*\.(sql|ts)$/.test(node.path))
        .slice(0, 10);
      if (candidates.length === 0) {
        return {
          ok: true,
          output: 'No schema or migration files were found in this project.',
          bytes: 48,
        };
      }
      const blocks: string[] = [];
      for (const node of candidates) {
        const read = await engine.files.readFile(workspaceId, node.path);
        blocks.push(`--- ${node.path} ---\n${read.content.slice(0, 4_000)}`);
      }
      const output = blocks.join('\n');
      return { ok: true, output, bytes: output.length };
    },
  };
  return handlers;
}

export interface WorkerExecutorOptions {
  readonly gateway: GatewayService;
  readonly engine: ProjectEngine;
  readonly mode?: WorkerExecutionMode;
  readonly env?: NodeJS.ProcessEnv;
}

export function createWorkerExecutor(options: WorkerExecutorOptions): WorkerExecutor {
  const mode = options.mode ?? resolveWorkerExecutionMode(options.env);
  if (mode === 'simulated') return new SimulatedExecutor();

  const gateway = options.gateway.gateway;
  const handlers = createProjectToolHandlers(options.engine);

  const pinnedModel = (options.env ?? process.env).VELTRAVIA_WORKER_MODEL?.trim();
  const readContext = async (input: {
    readonly projectId: string | null;
    readonly assignment: WorkerAssignment;
    readonly limit: number;
  }) => {
    const projectId = input.projectId;
    if (projectId === null) return [];
    const workspaceId = await firstWorkspaceId(options.engine, projectId);
    if (workspaceId === null) return [];
    const nodes = (await options.engine.files.listAll(workspaceId))
      .filter((node) => node.type === 'file')
      .filter((node) =>
        input.assignment.scope.some(
          (entry: string) => node.path === entry || node.path.startsWith(`${entry}/`),
        ),
      )
      .slice(0, input.limit);
    const files: { path: string; content: string }[] = [];
    for (const node of nodes) {
      try {
        const read = await options.engine.files.readFile(workspaceId, node.path);
        files.push({ path: node.path, content: read.content.slice(0, 2_000) });
      } catch {
        continue;
      }
    }
    return files;
  };

  return new ModelWorkerExecutor({
    handlers,
    contextFiles: readContext,
    ...(pinnedModel === undefined || pinnedModel === '' ? {} : { modelId: pinnedModel }),
    async generate(request) {
      if (gateway === null) {
        throw new WorkerError(
          'WORKER_PROVIDER_UNAVAILABLE',
          options.gateway.blockedReason ?? 'No AI provider is connected for this owner.',
        );
      }
      const outcome = await gateway.generate(
        {
          ownerRef: request.ownerRef,
          ...(request.projectId === null ? {} : { projectId: request.projectId }),
        } as never,
        {
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          category: request.category,
          ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
          signal: request.signal,
          runId: request.runId,
        } as never,
      );
      return {
        content: outcome.content,
        providerId: outcome.providerId,
        modelId: outcome.modelId,
        inputTokens: outcome.usage.inputTokens ?? 0,
        outputTokens: outcome.usage.outputTokens ?? 0,
        latencyMs: outcome.latencyMs,
        live: outcome.live,
      };
    },
  });
}

export type { WorkerAssignment };
