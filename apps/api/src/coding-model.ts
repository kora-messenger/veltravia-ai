/**
 * Model-powered coding (Step 35) - server wiring.
 *
 * Three small pieces, each reusing what already exists:
 *
 *   1. `createExecutionModelClient` implements the coding agent's completion
 *      port on top of Step 29's execution service. That means the router still
 *      picks the model, the gateway still decrypts the credential for one
 *      request, usage is still recorded once, and the credential never reaches
 *      the browser or a project file.
 *   2. `createApiCodingDecisionSource` resolves the project's owner, builds one
 *      model decision source per run, and lets the cancel route abort the
 *      in-flight call.
 *   3. `describeCodingModel` answers honestly whether a real provider is
 *      connected for this caller, so the UI can say "no model connected"
 *      instead of showing a scripted plan as if a model produced it.
 */

import {
  type CodingDecisionContext,
  type CodingDecisionSource,
} from '@veltravia/coding-agent-core';
import {
  createModelCodingDecisionSource,
  ModelCodingError,
  type CodingModelClient,
  type CodingModelMessage,
  type ModelCodingSource,
  type ModelExchange,
} from '@veltravia/coding-agent-model';
import type { AIProviderGateway } from '@veltravia/ai-gateway';
import type { ProjectEngine } from '@veltravia/project-core';

import type { AiExecutionService, ExecutionEvent } from './ai-execution-service.js';

/** Providers whose answers are fixtures, not model output. */
const NON_LIVE_PROVIDERS = new Set(['mock', 'fixture', 'demo']);

export interface ExecutionModelClientOptions {
  readonly execution: AiExecutionService;
  readonly ownerRef: string;
  readonly projectId?: string;
  readonly providerName?: string;
  readonly onEvent?: (event: ExecutionEvent) => void;
  /**
   * Shortest gap between completions in one run, in milliseconds.
   *
   * A coding run makes one model call per decision, which the run reports as
   * separate steps. Free provider tiers meter per minute, so several quick
   * decisions trip a 429 that no retry can wait out. Pacing is off (0) by
   * default and set by the operator for a metered key.
   */
  readonly minIntervalMs?: number;
}

/**
 * One completion, through the existing execution path.
 *
 * The call is deliberately non-streaming at this layer: the coding agent needs
 * the finished JSON object, and a half-written JSON plan is not a decision. The
 * execution service still streams internally and still records usage.
 */
export function createExecutionModelClient(
  options: ExecutionModelClientOptions,
): CodingModelClient {
  const { execution } = options;
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
  let lastCallAt = 0;
  return {
    providerName: options.providerName ?? 'connected provider',
    async complete(request) {
      if (minIntervalMs > 0) {
        const wait = lastCallAt + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      lastCallAt = Date.now();
      const system = request.messages.find((message) => message.role === 'system')?.content;
      const history = request.messages
        .filter(
          (message): message is CodingModelMessage & { role: 'user' | 'assistant' } =>
            message.role === 'user' || message.role === 'assistant',
        )
        .map((message) => ({ role: message.role, content: message.content }));
      const task = history.filter((entry) => entry.role === 'user').at(-1)?.content ?? '';
      const prior = history.slice(0, Math.max(0, history.length - 1));

      let started: ReturnType<AiExecutionService['start']>;
      try {
        started = execution.start({
          ownerRef: options.ownerRef,
          task,
          category: 'coding',
          ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
          ...(system !== undefined ? { system } : {}),
          history: prior,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          stream: false,
          // Billing for a coding run is one charge for the whole run, keyed by
          // the run id the decision source already carries.
          ...(request.correlationId !== undefined
            ? {
                charge: {
                  kind: 'coding.run',
                  operationId: request.correlationId,
                },
              }
            : {}),
        });
      } catch (error) {
        throw new ModelCodingError(
          'CODING_MODEL_UNAVAILABLE',
          (error as Error).message ?? 'no model is configured for this project',
        );
      }

      let content = '';
      let providerId: string | null = null;
      let modelId: string | null = null;
      let failure: string | null = null;
      let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
      let cancelled = false;

      const onAbort = (): void => {
        cancelled = true;
        try {
          execution.cancel(options.ownerRef, started.run.id);
        } catch {
          // Already finished: nothing to cancel, and no state to reconcile.
        }
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const event of started.events) {
          options.onEvent?.(event);
          switch (event.type) {
            case 'route.selected':
              providerId = event.providerId;
              modelId = event.modelId;
              break;
            case 'delta':
              content += event.text;
              break;
            case 'usage':
              usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
              break;
            case 'run.completed':
              content = event.content;
              providerId = event.providerId;
              modelId = event.modelId;
              break;
            case 'run.failed':
              failure = event.message;
              break;
            case 'run.cancelled':
              cancelled = true;
              break;
            default:
              break;
          }
        }
      } finally {
        request.signal?.removeEventListener('abort', onAbort);
      }

      if (cancelled) {
        throw new ModelCodingError('CODING_MODEL_CANCELLED', 'the model call was cancelled');
      }
      if (failure !== null) throw new ModelCodingError('CODING_MODEL_PROVIDER_ERROR', failure);

      const provider = providerId ?? 'unknown';
      // An empty answer is a provider problem, not a silent success: the agent
      // would otherwise report it as a malformed decision and hide the cause.
      if (content.trim().length === 0) {
        throw new ModelCodingError(
          'CODING_MODEL_PROVIDER_ERROR',
          `${options.providerName ?? provider} returned an empty answer (${modelId ?? 'unknown model'})`,
        );
      }
      const live = !NON_LIVE_PROVIDERS.has(provider);
      return {
        text: content,
        providerId: provider,
        modelId: modelId ?? 'unknown',
        live,
        ...(usage !== null ? { usage } : {}),
      };
    },
  };
}

export type CodingDecisionMode = 'model' | 'scripted-demo' | 'unavailable';

export interface CodingModelDescription {
  readonly mode: CodingDecisionMode;
  readonly providerName: string | null;
  readonly reason: string | null;
}

export interface ApiCodingDecisionSourceOptions {
  readonly execution: AiExecutionService | null;
  readonly gateway: AIProviderGateway | null;
  readonly projectEngine: ProjectEngine;
  /** Explicit, server-side opt-in for the offline scripted source. */
  readonly demoMode: boolean;
  readonly blockedReason?: string;
  /** Shortest gap between model calls in a run; see ExecutionModelClientOptions. */
  readonly minIntervalMs?: number;
  readonly onEvent?: (runId: string, event: ExecutionEvent) => void;
  readonly onExchange?: (runId: string, exchange: ModelExchange) => void;
}

export interface ApiCodingDecisionSource extends CodingDecisionSource {
  /** Honest capability description for one caller. */
  describe(ownerRef: string): Promise<CodingModelDescription>;
  /** Which model actually answered for a run, keyed by run id. */
  exchangesFor(runId: string): readonly ModelExchange[];
  /** Aborts the in-flight model call for a run (cancellation). */
  abortRun(runId: string): void;
}

interface RunBinding {
  readonly controller: AbortController;
  readonly source: ModelCodingSource;
}

/**
 * The API's coding decision source.
 *
 * `demoMode` is only true when the server was started with an explicit
 * `VELTRAVIA_CODING_DEMO=1`: scripted plans are a development tool, never a
 * silent substitute for a model that is missing.
 */
export function createApiCodingDecisionSource(
  options: ApiCodingDecisionSourceOptions,
): ApiCodingDecisionSource {
  const bindings = new Map<string, RunBinding>();
  const exchanges = new Map<string, ModelExchange[]>();

  async function ownerOfProject(projectId: string): Promise<string> {
    const project = await options.projectEngine.projects.getProject(projectId);
    return project.ownerRef;
  }

  async function binding(context: CodingDecisionContext): Promise<ModelCodingSource> {
    const existing = bindings.get(context.runId);
    if (existing !== undefined) return existing.source;
    if (options.execution === null) {
      throw new ModelCodingError(
        'CODING_MODEL_UNAVAILABLE',
        options.blockedReason ?? 'No AI provider is connected yet.',
      );
    }
    const ownerRef = await ownerOfProject(context.projectId);
    const controller = new AbortController();
    const source = createModelCodingDecisionSource({
      client: createExecutionModelClient({
        execution: options.execution,
        ownerRef,
        projectId: context.projectId,
        ...(options.minIntervalMs !== undefined && options.minIntervalMs > 0
          ? { minIntervalMs: options.minIntervalMs }
          : {}),
        ...(options.onEvent !== undefined
          ? { onEvent: (event: ExecutionEvent) => options.onEvent?.(context.runId, event) }
          : {}),
      }),
      signalFor: () => controller.signal,
      ...(options.onExchange !== undefined
        ? {
            onExchange: (exchange: ModelExchange) => {
              options.onExchange?.(context.runId, exchange);
              const list = exchanges.get(context.runId) ?? [];
              list.push(exchange);
              exchanges.set(context.runId, list);
            },
          }
        : {}),
    });
    bindings.set(context.runId, { controller, source });
    return source;
  }

  return {
    async nextDecision(context) {
      const source = await binding(context);
      const decision = await source.nextDecision(context);
      if (options.onExchange === undefined) {
        const list = exchanges.get(context.runId) ?? [];
        list.push(...source.exchanges().slice(list.length));
        exchanges.set(context.runId, list);
      }
      return decision;
    },

    async describe(ownerRef) {
      if (options.demoMode) {
        return {
          mode: 'scripted-demo',
          providerName: null,
          reason: 'VELTRAVIA_CODING_DEMO is set: plans come from the offline script, not a model.',
        };
      }
      if (options.execution === null || options.gateway === null) {
        return {
          mode: 'unavailable',
          providerName: null,
          reason: options.blockedReason ?? 'No AI provider is connected yet.',
        };
      }
      const configured = await options.gateway.isConfigured({ ownerRef });
      if (!configured) {
        return {
          mode: 'unavailable',
          providerName: null,
          reason: 'Connect a provider in Settings before a model can plan this change.',
        };
      }
      return { mode: 'model', providerName: null, reason: null };
    },

    exchangesFor(runId) {
      return [...(exchanges.get(runId) ?? [])];
    },

    abortRun(runId) {
      bindings.get(runId)?.controller.abort();
    },
  };
}
