/**
 * The model-powered worker executor.
 *
 * One loop: send what the worker may know, take back exactly one JSON action,
 * authorise it on the server, run it, feed the result back. The loop is bounded
 * by the assignment's budget and by the runner's deadline, and a model that
 * wanders off protocol is corrected, then cut off.
 *
 * Providers come from the caller's `generate` port, which is the existing AI
 * gateway. Nothing here knows a vendor, a key or an endpoint.
 */

import {
  allowedVerificationOperations,
  WorkerError,
  type WorkerAssignment,
  type WorkerExecution,
  type WorkerExecutor,
} from '@veltravia/worker-core';
import { profileFor } from './routing.js';
import { WorkerBudget, resolveLimits } from './governance.js';
import { buildWorkerPrompt, scrubForModel, type BuiltPrompt } from './prompt.js';
import { isAuthorisedPath } from './scopes.js';
import { WorkerToolbox } from './tools.js';
import type { WorkerToolHandler, WorkerToolOutcome } from './types.js';

export interface ModelTurnRequest {
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly system: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
  readonly category: string;
  readonly runId: string;
  /** Optional pinned model; unset means the gateway's router chooses. */
  readonly modelId?: string;
}

export interface ModelTurnResult {
  readonly content: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly live: boolean;
}

export interface ModelWorkerExecutorOptions {
  /** The existing provider gateway, narrowed to one owner and project. */
  readonly generate: (request: ModelTurnRequest) => Promise<ModelTurnResult>;
  readonly handlers: Readonly<Record<string, WorkerToolHandler>>;
  /** Reads the few files the prompt may include. */
  readonly contextFiles?: (input: {
    readonly ownerRef: string;
    readonly projectId: string | null;
    readonly assignment: WorkerAssignment;
    readonly limit: number;
  }) => Promise<readonly { readonly path: string; readonly content: string }[]>;
  readonly taskContext?: (taskId: string) => Promise<{ title: string; objective: string }>;
  readonly recordProgress?: (
    workerId: string,
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
  /** Ops pin for deployments whose router choice returns no text. */
  readonly modelId?: string;
}

interface ParsedAction {
  readonly kind: 'action';
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

interface ParsedFinal {
  readonly kind: 'final';
  readonly status: 'completed' | 'partial' | 'blocked' | 'failed';
  readonly summary: string;
  readonly deliverables: readonly {
    readonly name: string;
    readonly kind: string;
    readonly path: string | null;
    readonly summary: string;
  }[];
  readonly evidence: readonly {
    readonly kind: string;
    readonly ref: string;
    readonly summary: string;
    readonly passed?: boolean | null;
  }[];
  readonly blockedReason?: string;
}

const DELIVERABLE_KINDS = new Set(['file', 'patch', 'report', 'artifact', 'notes']);
const EVIDENCE_KINDS = new Set(['test_run', 'command', 'file', 'note']);
const MAX_TURNS = 14;

/** Strict parse: one JSON object with either an action or a final report. */
export function parseModelTurn(
  raw: string,
): ParsedAction | ParsedFinal | { kind: 'invalid'; reason: string } {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return { kind: 'invalid', reason: 'no JSON object was returned' };
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { kind: 'invalid', reason: 'the JSON did not parse' };
  }
  if (typeof value !== 'object' || value === null) {
    return { kind: 'invalid', reason: 'the answer was not an object' };
  }
  const record = value as Record<string, unknown>;
  if (record['action'] !== undefined) {
    const action = record['action'] as Record<string, unknown> | undefined;
    const tool = action?.['tool'];
    if (typeof tool !== 'string')
      return { kind: 'invalid', reason: 'action.tool must be a string' };
    const args = action?.['arguments'];
    return {
      kind: 'action',
      tool,
      arguments: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
    };
  }
  if (record['final'] !== undefined) {
    const final = record['final'] as Record<string, unknown> | undefined;
    if (final === undefined) return { kind: 'invalid', reason: 'final must be an object' };
    const status = final['status'];
    if (
      status !== 'completed' &&
      status !== 'partial' &&
      status !== 'blocked' &&
      status !== 'failed'
    ) {
      return {
        kind: 'invalid',
        reason: 'final.status must be completed, partial, blocked or failed',
      };
    }
    const summary = typeof final['summary'] === 'string' ? final['summary'] : '';
    if (summary.trim().length === 0)
      return { kind: 'invalid', reason: 'final.summary is required' };
    const deliverables = Array.isArray(final['deliverables'])
      ? (final['deliverables'] as Record<string, unknown>[]).flatMap((entry) => {
          const name = entry['name'];
          const kind = entry['kind'];
          if (
            typeof name !== 'string' ||
            typeof kind !== 'string' ||
            !DELIVERABLE_KINDS.has(kind)
          ) {
            return [];
          }
          return [
            {
              name,
              kind,
              path: typeof entry['path'] === 'string' ? entry['path'] : null,
              summary: typeof entry['summary'] === 'string' ? entry['summary'] : '',
            },
          ];
        })
      : [];
    const evidence = Array.isArray(final['evidence'])
      ? (final['evidence'] as Record<string, unknown>[]).flatMap((entry) => {
          const kind = entry['kind'];
          const ref = entry['ref'];
          if (typeof kind !== 'string' || !EVIDENCE_KINDS.has(kind) || typeof ref !== 'string')
            return [];
          return [
            {
              kind,
              ref,
              summary: typeof entry['summary'] === 'string' ? entry['summary'] : '',
              passed: typeof entry['passed'] === 'boolean' ? entry['passed'] : null,
            },
          ];
        })
      : [];
    return {
      kind: 'final',
      status,
      summary,
      deliverables,
      evidence,
      ...(typeof final['blockedReason'] === 'string'
        ? { blockedReason: final['blockedReason'] }
        : {}),
    };
  }
  return { kind: 'invalid', reason: 'the object has neither action nor final' };
}

export class ModelWorkerExecutor implements WorkerExecutor {
  readonly simulated = false;
  private readonly options: ModelWorkerExecutorOptions;

  constructor(options: ModelWorkerExecutorOptions) {
    this.options = options;
  }

  async run(input: {
    readonly workerId: string;
    readonly ownerRef: string;
    readonly taskId: string;
    readonly projectId: string | null;
    readonly workerType: string;
    readonly assignment: WorkerAssignment;
    readonly signal: AbortSignal;
    readonly report: (progress: {
      readonly message: string;
      readonly percent?: number;
    }) => void | Promise<void>;
  }): Promise<WorkerExecution> {
    const assignment = input.assignment;
    const profile = profileFor(input.workerType as never);
    const { limits } = resolveLimits({
      maxToolCalls: assignment.limits.maxToolCalls,
      maxOutputBytes: assignment.limits.maxDeliverables * 40_000,
    });
    const budget = new WorkerBudget(limits);
    const record = (message: string, detail?: Record<string, unknown>): void => {
      void input.report({ message: scrubForModel(message) });
      this.options.recordProgress?.(input.workerId, message, detail);
    };

    const toolbox = new WorkerToolbox({
      ownerRef: input.ownerRef ?? '',
      workerId: input.workerId,
      workerType: input.workerType,
      taskId: input.taskId ?? '',
      projectId: input.projectId ?? null,
      assignment: {
        allowedTools: assignment.allowedTools,
        scope: assignment.scope,
        exclusions: assignment.exclusions,
        permissions: assignment.permissions,
        // Resolved server-side from the assignment: the model never widens it.
        verification: { operations: allowedVerificationOperations(assignment) },
      },
      handlers: this.options.handlers,
      signal: input.signal,
      deadline: Date.now() + assignment.limits.maxDurationMs,
      record,
    });

    const task = await this.options.taskContext?.(input.taskId ?? '');
    const context =
      this.options.contextFiles === undefined
        ? []
        : await this.options.contextFiles({
            ownerRef: input.ownerRef,
            projectId: input.projectId,
            assignment,
            limit: 8,
          });
    const prompt: BuiltPrompt = buildWorkerPrompt({
      assignment,
      workerType: input.workerType,
      taskTitle: task?.title ?? 'Assigned task',
      taskObjective: task?.objective ?? assignment.objective,
      context,
    });
    if (prompt.redactions > 0) {
      record(`Removed ${prompt.redactions} credential-shaped string(s) before sending.`);
    }

    const toolResults: string[] = [];
    const produced = new Map<
      string,
      { name: string; kind: string; path: string; summary: string }
    >();
    const evidence: { kind: string; ref: string; summary: string; passed?: boolean | null }[] = [];
    let corrections = 0;
    let lastProvider: string | null = null;
    let lastModel: string | null = null;
    let live = false;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let turn = 0; turn < Math.min(MAX_TURNS, limits.maxModelCalls); turn += 1) {
      budget.assertCanContinue();
      if (input.signal.aborted)
        throw new WorkerError('WORKER_CANCELLED', 'The worker was cancelled.');
      record(turn === 0 ? 'Model request initiated' : 'Model request initiated with tool results');

      const result = await this.options.generate({
        ownerRef: input.ownerRef ?? '',
        projectId: input.projectId ?? null,
        system: profile.preamble,
        messages: [
          { role: 'user', content: prompt.user },
          ...toolResults.map((entry) => ({ role: 'assistant' as const, content: entry })),
        ],
        temperature: profile.temperature,
        maxOutputTokens: profile.maxOutputTokens,
        signal: input.signal,
        category: profile.category,
        runId: input.workerId,
        ...(this.options.modelId === undefined ? {} : { modelId: this.options.modelId }),
      });
      budget.chargeModel(result.inputTokens, result.outputTokens);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      lastProvider = result.providerId;
      lastModel = result.modelId;
      live = result.live;
      record(`Model response received from ${result.modelId} (${result.latencyMs}ms)`);

      const parsed = parseModelTurn(result.content);
      if (parsed.kind === 'invalid') {
        record(`Model answer was not usable: ${parsed.reason}`);
        toolResults.push(
          `{"error": "your previous answer was rejected: ${parsed.reason}. Answer with exactly one JSON object: an action or a final report."}`,
        );
        continue;
      }

      if (parsed.kind === 'action') {
        record(`Tool requested: ${parsed.tool}`);
        const outcome = await toolbox.invoke({ tool: parsed.tool, arguments: parsed.arguments });
        budget.chargeTool(outcome.ok ? outcome.bytes : 0);
        evidence.push({
          kind: 'command',
          ref: parsed.tool,
          summary: outcome.ok ? 'ran' : `refused: ${outcome.code}`,
          passed: outcome.ok ? true : null,
        });
        if (outcome.ok && outcome.changedPaths !== undefined) {
          for (const path of outcome.changedPaths) {
            produced.set(path, {
              name: path.split('/').pop() ?? path,
              kind: 'file',
              path,
              summary: `Written by ${parsed.tool}`,
            });
          }
        }
        if (
          outcome.ok &&
          (parsed.tool === 'tests.run' || parsed.tool === 'tests.run.scope') &&
          outcome.passed !== undefined
        ) {
          evidence.push({
            kind: 'test_run',
            ref: outcome.evidenceRef ?? 'tests',
            summary: outcome.output.slice(0, 200),
            passed: outcome.passed,
          });
        }
        toolResults.push(JSON.stringify({ tool: parsed.tool, result: summarizeOutcome(outcome) }));
        continue;
      }

      // A claim of success with nothing produced is corrected once, not trusted.
      if (
        parsed.status === 'completed' &&
        parsed.deliverables.length === 0 &&
        produced.size === 0 &&
        corrections < 1
      ) {
        corrections += 1;
        record('Model claimed completion without producing anything; asked for the work.');
        toolResults.push(
          '{"error": "you reported completion but produced no deliverable and called no tool. Do the work with your tools, or report status partial and explain what stopped you."}',
        );
        continue;
      }

      // A final report: validate its claims against what actually happened.
      const deliverables: {
        name: string;
        kind: string;
        path: string | null;
        summary: string;
      }[] = parsed.deliverables.flatMap((entry) => {
        if (entry.path === null) {
          return [
            {
              name: entry.name,
              kind: entry.kind,
              path: null as string | null,
              summary: entry.summary,
            },
          ];
        }
        if (
          !isAuthorisedPath(
            { scope: assignment.scope, exclusions: assignment.exclusions },
            entry.path,
          )
        ) {
          record(`Dropped a deliverable outside the assignment: ${entry.path}`);
          return [];
        }
        return [{ name: entry.name, kind: entry.kind, path: entry.path, summary: entry.summary }];
      });
      const recorded = Array.from(produced.values()).map((entry) => ({
        name: entry.name,
        kind: 'file',
        path: entry.path,
        summary: entry.summary,
      }));
      const merged = [...deliverables, ...recorded].slice(0, assignment.limits.maxDeliverables);
      if (toolbox.refusals.length > 0) {
        evidence.push({
          kind: 'note',
          ref: 'refusals',
          summary: `${toolbox.refusals.length} tool call(s) refused by the server`,
          passed: null,
        });
      }
      const usage = {
        providerId: lastProvider,
        modelId: lastModel,
        modelCalls: budget.state.modelCalls,
        toolCalls: budget.state.toolCalls,
        inputTokens,
        outputTokens,
        live,
      };
      return {
        outcome: parsed.status,
        summary: parsed.summary.slice(0, 800),
        deliverables: merged as WorkerExecution['deliverables'],
        evidence: evidence.slice(0, 40) as WorkerExecution['evidence'],
        notes: scrubForModel(prompt.truncated ? 'Prompt context was truncated.' : ''),
        ...(parsed.blockedReason === undefined ? {} : { blockedReason: parsed.blockedReason }),
        ...(parsed.status === 'failed'
          ? { failure: { code: 'WORKER_REPORTED_FAILURE', message: parsed.summary.slice(0, 300) } }
          : {}),
        usage,
      };
    }

    // Out of turns without a final answer: honest partial, with what we have.
    const evidenceTail = evidence.slice(0, 40) as WorkerExecution['evidence'];
    const deliverables = Array.from(produced.values()).map((entry) => ({
      name: entry.name,
      kind: 'file' as const,
      path: entry.path,
      summary: entry.summary,
    }));
    return {
      outcome: deliverables.length > 0 ? 'partial' : 'failed',
      summary:
        deliverables.length > 0
          ? 'The worker used its turns and left partial work for review.'
          : 'The worker used its turns without producing a deliverable.',
      deliverables: deliverables.slice(0, assignment.limits.maxDeliverables),
      evidence: evidenceTail,
      notes: 'No final report was produced before the turn budget ran out.',
      failure:
        deliverables.length > 0
          ? null
          : { code: 'WORKER_NO_FINAL_REPORT', message: 'The model never returned a final report.' },
      usage: {
        providerId: lastProvider,
        modelId: lastModel,
        modelCalls: budget.state.modelCalls,
        toolCalls: budget.state.toolCalls,
        inputTokens,
        outputTokens,
        live,
      },
    };
  }
}

function summarizeOutcome(outcome: WorkerToolOutcome): Record<string, unknown> {
  if (!outcome.ok) return { error: outcome.code, message: outcome.message };
  return {
    output: outcome.output.slice(0, 4_000),
    truncated: outcome.output.length > 4_000,
    ...(outcome.passed === undefined ? {} : { passed: outcome.passed }),
  };
}
