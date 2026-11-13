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

import type { OperationBilling } from './operation-billing.js';
import { SimulatedExecutor } from '@veltravia/worker-core';
import {
  ModelWorkerExecutor,
  type WorkerToolHandler,
  type WorkerToolOutcome,
} from '@veltravia/superagent-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { GatewayService } from './ai-gateway-service.js';
import type { VerificationService } from './verification.js';
import type { WorkerStagingRegistry } from './worker-staging.js';

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
  options: {
    readonly verification?: VerificationService | undefined;
    /** When present, worker writes go to an isolated staging tree. */
    readonly staging?: WorkerStagingRegistry | undefined;
  } = {},
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
      // Step 46: a worker never writes the shared project. Its writes land in
      // its own staging tree and become a change set the Primary Agent reviews.
      if (options.staging !== undefined) {
        try {
          const area = options.staging.get(context.workerId);
          if (area === null) {
            return refuse(
              'WORKER_TOOL_UNAVAILABLE',
              'No staging tree was opened for this worker, so nothing was written.',
            );
          }
          await options.staging.write(area, path, content);
          return {
            ok: true,
            output: `staged ${path}`,
            bytes: content.length,
            changedPaths: [path],
          };
        } catch (error) {
          return refuse(
            'WORKER_TOOL_FAILED',
            error instanceof Error ? error.message : 'The staging tree refused that file.',
          );
        }
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

    /**
     * Real verification (Step 45). The worker names OPERATIONS; the server
     * resolves them to commands the project itself declares, runs them in a
     * sandbox and records an evidence-bearing run the Primary Agent can check.
     * A worker cannot name a command, widen its own scope, or claim a pass
     * that no command produced.
     */
    'tests.run': async (invocation, context) => {
      const verification = options.verification;
      if (verification === undefined) {
        return refuse(
          'WORKER_TOOL_UNAVAILABLE',
          'No verification runtime is configured on this server, so nothing was executed.',
        );
      }
      if (context.projectId === null) {
        return refuse('WORKER_TOOL_UNAVAILABLE', 'That worker is not attached to a project.');
      }
      const raw = invocation.arguments['operations'];
      const requested = Array.isArray(raw) ? raw.map((entry) => String(entry)) : [];
      if (requested.length === 0) {
        return refuse(
          'WORKER_TOOL_ARGUMENTS_INVALID',
          'Name at least one verification operation, for example ["unit"] or ["typecheck","build"].',
        );
      }
      const authorised = context.verificationOperations;
      if (authorised.length === 0) {
        return refuse(
          'WORKER_TOOL_NOT_ASSIGNED',
          'This assignment does not authorise running verification operations.',
        );
      }
      const outside = requested.filter((operation) => !authorised.includes(operation));
      if (outside.length > 0) {
        return refuse(
          'WORKER_TOOL_OUT_OF_SCOPE',
          `The assignment does not authorise these operations: ${outside.join(', ')}. Allowed: ${authorised.join(', ')}.`,
        );
      }
      if (requested.length > MAX_WORKER_VERIFICATION_OPERATIONS) {
        return refuse(
          'WORKER_TOOL_ARGUMENTS_INVALID',
          `Ask for at most ${MAX_WORKER_VERIFICATION_OPERATIONS} operations at once.`,
        );
      }
      const path =
        typeof invocation.arguments['path'] === 'string' ? invocation.arguments['path'] : null;

      const run = await verification.runner.run({
        ownerRef: context.ownerRef,
        projectId: context.projectId,
        taskId: context.taskId,
        workerId: context.workerId,
        operations: requested,
        authorized: authorised as never,
        path,
        limits: {
          maxOperations: MAX_WORKER_VERIFICATION_OPERATIONS,
          maxRepairAttempts: 1,
        },
      });

      const lines = [
        `Verification run ${run.id}: ${run.status}.`,
        `Revision: ${run.revision ?? 'unknown'}. Executed: ${run.evidence?.executedCount ?? 0} operation(s).`,
      ];
      for (const result of run.results) {
        const counts =
          result.counts.discovered === null
            ? ''
            : ` (${result.counts.passed ?? 0} passed, ${result.counts.failed ?? 0} failed of ${result.counts.discovered})`;
        lines.push(`- ${result.operation}: ${result.status}${counts} via ${result.argv.join(' ')}`);
        if (result.errorSummary !== null) lines.push(`  ${result.errorSummary}`);
      }
      for (const blocked of run.blocked) {
        lines.push(`- ${blocked.operation}: did not run (${blocked.reason}) ${blocked.detail}`);
      }
      const output = lines.join('\n');
      return {
        ok: true,
        output,
        bytes: output.length,
        passed: run.status === 'passed',
        // The review gate checks this id against the stored run.
        evidenceRef: run.id,
      };
    },
  };
  return handlers;
}

/** Kept small on purpose: a worker's verification is always a bounded check. */
const MAX_WORKER_VERIFICATION_OPERATIONS = 3;

export interface WorkerExecutorOptions {
  readonly gateway: GatewayService;
  readonly engine: ProjectEngine;
  /** Real verification, so `tests.run` reports what actually ran. */
  readonly verification?: VerificationService | undefined;
  readonly mode?: WorkerExecutionMode;
  readonly env?: NodeJS.ProcessEnv;
  /** Isolated staging, so worker writes never touch the project (Step 46). */
  readonly staging?: WorkerStagingRegistry | undefined;
  /**
   * Step 55: where a worker's provider calls are tallied. Resolved lazily
   * because the billing layer is assembled after the executor (it needs the
   * wallet, which needs the worker store for its concurrency gauge).
   */
  readonly billing?: (() => OperationBilling | undefined) | undefined;
  /**
   * Step 59: the account-wide credit limits, checked before each model call.
   *
   * The operation was authorised when it started, and its estimate is held in
   * the window it counts against. This check is the second half: a run that has
   * already reached its allowance does not get another turn, so credits are not
   * spent to discover that they could not be spent. Lazy for the same reason
   * billing is.
   */
  readonly spending?:
    | (() =>
        | {
            authorize(input: {
              readonly ownerRef: string;
              readonly workspaceId: string | null;
              readonly projectId: string | null;
              readonly category: 'agents';
              readonly requested: number;
              readonly actor: string;
            }): Promise<{
              readonly allowed: boolean;
              readonly violation: { readonly message: string } | null;
            }>;
          }
        | undefined)
    | undefined;
}

export function createWorkerExecutor(options: WorkerExecutorOptions): WorkerExecutor {
  const mode = options.mode ?? resolveWorkerExecutionMode(options.env);
  if (mode === 'simulated') return new SimulatedExecutor();

  const gateway = options.gateway.gateway;
  const handlers = createProjectToolHandlers(options.engine, undefined, {
    verification: options.verification,
    staging: options.staging,
  });

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

  const model = new ModelWorkerExecutor({
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
      /*
       * Step 59: no allowance, no turn. A zero-credit request still evaluates the
       * configured limits, so a window already at its ceiling refuses here rather
       * than after another provider call has been paid for.
       */
      const guard = options.spending?.();
      if (guard !== undefined) {
        const decision = await guard.authorize({
          ownerRef: request.ownerRef,
          workspaceId: null,
          projectId: request.projectId ?? null,
          category: 'agents',
          requested: 0,
          actor: 'worker',
        });
        if (!decision.allowed && decision.violation !== null) {
          throw new WorkerError('WORKER_SPENDING_LIMIT', decision.violation.message);
        }
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
      /*
       * Step 55: the worker's calls belong to the worker, not to one charge per
       * turn. Every turn of this attempt is added to the same tally, and the
       * worker's review or cancellation settles it once. Missing numbers stay
       * missing so the charge can say what it did not measure.
       */
      options.billing?.()?.record(
        {
          ownerRef: request.ownerRef,
          kind: 'agent.execution',
          operationId: request.runId,
          ...(request.projectId === null ? {} : { projectId: request.projectId }),
        },
        {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cachedInputTokens: outcome.usage.cachedInputTokens ?? null,
          durationMs: outcome.latencyMs,
          modelId: outcome.modelId,
          providerId: outcome.providerId,
        },
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

  const staging = options.staging;
  if (staging === undefined) return model;

  /**
   * Opens the worker's staging tree before its first turn, using the
   * assignment's own scope, so authorization at review time is the same
   * envelope the worker ran under.
   */
  return {
    simulated: model.simulated,
    async run(input) {
      if (input.projectId !== null) {
        const workspaceId = await firstWorkspaceId(options.engine, input.projectId);
        if (workspaceId !== null) {
          await staging.open({
            workerId: input.workerId,
            projectId: input.projectId,
            mainWorkspaceId: workspaceId,
            taskId: input.taskId,
            allowedPaths: input.assignment.scope,
            excludedPaths: input.assignment.exclusions,
            allowedTools: input.assignment.allowedTools,
          });
        }
      }
      return model.run(input);
    },
  };
}

export type { WorkerAssignment };
