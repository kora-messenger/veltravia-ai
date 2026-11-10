import { randomUUID } from 'node:crypto';

import type { AIMessage } from '@veltravia/ai-core';
import {
  GatewayError,
  isGatewayError,
  prepareContext,
  type AIProviderGateway,
  type GenerationOutcome,
} from '@veltravia/ai-gateway';
import type { ModelRouterService } from './model-router-service.js';
import type { TaskCategory } from '@veltravia/ai-router';

/**
 * Real-model execution (Step 29).
 *
 * One path for every feature that needs an answer from a model:
 *
 *   task -> router decides -> context is fitted to that model's window ->
 *   the gateway executes against exactly that connection and model ->
 *   events stream out -> usage is recorded once.
 *
 * Two rules are structural, not conventions:
 *   - the router's answer is used verbatim; a refusal ends the run with its own
 *     plain-language reason and nothing is sent anywhere else;
 *   - a run that was cancelled, failed or finished is never re-reported as
 *     something it was not.
 */

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type ExecutionEvent =
  | {
      readonly type: 'run.started';
      readonly runId: string;
      readonly at: string;
      readonly category: string;
    }
  | {
      readonly type: 'progress';
      readonly runId: string;
      readonly stage: 'routing' | 'context' | 'generating' | 'recording';
      readonly message: string;
    }
  | {
      readonly type: 'route.selected';
      readonly runId: string;
      readonly providerId: string;
      readonly providerName: string;
      readonly modelId: string;
      readonly decisionId: string | null;
      readonly summary: string;
      readonly contextWindowTokens: number | null;
      readonly streaming: boolean;
    }
  | {
      readonly type: 'context.prepared';
      readonly runId: string;
      readonly estimatedInputTokens: number;
      readonly truncated: boolean;
      readonly droppedMessages: number;
      readonly notes: readonly string[];
    }
  | { readonly type: 'delta'; readonly runId: string; readonly text: string }
  | {
      readonly type: 'usage';
      readonly runId: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      /** Subset of inputTokens a provider served from cache; omitted when unanswered. */
      readonly cachedInputTokens?: number | null;
      readonly totalTokens: number | null;
      readonly usageSource: 'provider-confirmed' | 'unavailable';
      readonly estimatedCostUsd: number | null;
      readonly costSource: 'declared-pricing' | 'unavailable';
      readonly latencyMs: number;
      readonly streamed: boolean;
    }
  | {
      readonly type: 'run.completed';
      readonly runId: string;
      readonly content: string;
      readonly finishReason: string;
      readonly latencyMs: number;
      readonly providerId: string;
      readonly modelId: string;
      readonly live: true;
      readonly streamed: boolean;
    }
  | {
      readonly type: 'run.failed';
      readonly runId: string;
      readonly code: string;
      readonly message: string;
    }
  | { readonly type: 'run.cancelled'; readonly runId: string; readonly message: string };

export interface ExecutionStartInput {
  readonly ownerRef: string;
  readonly task: string;
  readonly category: TaskCategory;
  readonly projectId?: string;
  /** Manual route. Still validated against the owner's own connections. */
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly system?: string;
  readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Ask for genuine streaming. Providers that cannot stream answer in one piece. */
  readonly stream?: boolean;
  /** Duplicate protection: the same key twice returns the first run. */
  readonly idempotencyKey?: string;
}

export interface ExecutionRun {
  readonly id: string;
  readonly ownerRef: string;
  readonly category: string;
  readonly projectId: string | null;
  readonly status: ExecutionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly providerName: string | null;
  readonly decisionId: string | null;
  readonly routeSummary: string | null;
  readonly content: string;
  readonly streamed: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly usage: Extract<ExecutionEvent, { type: 'usage' }> | null;
}

export interface AiExecutionServiceOptions {
  readonly gateway: AIProviderGateway | null;
  readonly router: ModelRouterService | null;
  readonly blockedReason?: string;
  readonly now?: () => Date;
  readonly maxOutputTokensCeiling?: number;
  readonly maxRunsPerOwner?: number;
  readonly maxBufferedEvents?: number;
  /**
   * Step 52: metering. Called once with the tokens a run actually reported, so
   * usage is written down where the numbers are already known instead of being
   * guessed later from a run record. A failure here must never fail a run.
   */
  readonly onUsage?:
    | ((input: {
        readonly ownerRef: string;
        readonly runId: string;
        readonly providerId: string;
        readonly modelId: string;
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly cachedInputTokens: number | null;
      }) => void)
    | undefined;
}

interface RunState {
  run: ExecutionRun;
  content: string;
  events: ExecutionEvent[];
  listeners: Set<(event: ExecutionEvent) => void>;
  finished: boolean;
  controller: AbortController;
  idempotencyKey?: string;
  queue: EventQueue;
}

/** Bridges push-based execution to an async iterator the route can pipe. */
class EventQueue {
  private readonly buffered: ExecutionEvent[] = [];
  private resolveNext: ((value: IteratorResult<ExecutionEvent>) => void) | null = null;
  private closed = false;

  push(event: ExecutionEvent): void {
    if (this.closed) return;
    if (this.resolveNext !== null) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveNext !== null) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<ExecutionEvent>> {
    if (this.buffered.length > 0) {
      return { value: this.buffered.shift() as ExecutionEvent, done: false };
    }
    if (this.closed) return { value: undefined, done: true };
    return new Promise<IteratorResult<ExecutionEvent>>((resolve) => {
      this.resolveNext = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
    return { next: () => this.next() };
  }
}

export class AiExecutionService {
  private readonly options: AiExecutionServiceOptions;
  private readonly now: () => Date;
  private readonly runs = new Map<string, RunState>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly ceiling: number;
  private readonly maxRunsPerOwner: number;
  private readonly maxEvents: number;

  constructor(options: AiExecutionServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.ceiling = options.maxOutputTokensCeiling ?? 8_192;
    this.maxRunsPerOwner = options.maxRunsPerOwner ?? 200;
    this.maxEvents = options.maxBufferedEvents ?? 600;
  }

  /** Owner-scoped usage records, straight from the gateway that made the calls. */
  async usageHistory(ownerRef: string, limit = 20): Promise<readonly Record<string, unknown>[]> {
    if (this.options.gateway === null) return [];
    const records = await this.options.gateway.listUsage({ ownerRef }, limit);
    return records.map((record) => ({ ...record }));
  }

  get ready(): boolean {
    return this.options.gateway !== null && this.options.router !== null;
  }

  get blockedReason(): string | null {
    if (this.ready) return null;
    return this.options.blockedReason ?? 'No AI provider is connected yet.';
  }

  /**
   * Starts a run and returns its id plus the live event iterator.
   *
   * Execution continues in the background; a caller that stops iterating does
   * not stop the run (they can still read it with `snapshot`), but closing the
   * connection calls `cancel` from the route.
   */
  start(input: ExecutionStartInput): {
    readonly run: ExecutionRun;
    readonly events: AsyncIterable<ExecutionEvent>;
  } {
    if (!this.ready) {
      throw new GatewayError(
        'GATEWAY_NO_PROVIDER_CONFIGURED',
        this.blockedReason ?? 'No AI provider is connected yet.',
      );
    }
    const existingId =
      input.idempotencyKey === undefined
        ? undefined
        : this.byIdempotency.get(`${input.ownerRef}:${input.idempotencyKey}`);
    if (existingId !== undefined) {
      const existing = this.runs.get(existingId);
      if (existing !== undefined) {
        return { run: { ...existing.run }, events: emptyEvents() };
      }
    }

    const id = `exe_${randomUUID()}`;
    const at = this.now().toISOString();
    const state: RunState = {
      run: {
        id,
        ownerRef: input.ownerRef,
        category: input.category,
        projectId: input.projectId ?? null,
        status: 'running',
        createdAt: at,
        updatedAt: at,
        providerId: null,
        modelId: null,
        providerName: null,
        decisionId: null,
        routeSummary: null,
        content: '',
        streamed: false,
        errorCode: null,
        errorMessage: null,
        usage: null,
      },
      content: '',
      events: [],
      listeners: new Set(),
      finished: false,
      controller: new AbortController(),
      queue: new EventQueue(),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    this.runs.set(id, state);
    if (input.idempotencyKey !== undefined) {
      this.byIdempotency.set(`${input.ownerRef}:${input.idempotencyKey}`, id);
    }
    this.prune(input.ownerRef);

    void this.execute(state, input).catch(() => undefined);
    return { run: { ...state.run }, events: state.queue };
  }

  /** Buffered events for reconnecting clients. */
  eventsFor(ownerRef: string, runId: string, since = 0): readonly ExecutionEvent[] {
    const state = this.requireRun(ownerRef, runId);
    return state.events.filter((_, index) => index >= since);
  }

  snapshot(ownerRef: string, runId: string): ExecutionRun {
    return { ...this.requireRun(ownerRef, runId).run };
  }

  list(ownerRef: string, limit = 20): readonly ExecutionRun[] {
    return [...this.runs.values()]
      .filter((state) => state.run.ownerRef === ownerRef)
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map((state) => ({ ...state.run }));
  }

  /**
   * Cancels a live run. A finished run is NOT cancellable - its answer already
   * exists and overwriting that with "cancelled" would be a lie.
   */
  cancel(ownerRef: string, runId: string): ExecutionRun {
    const state = this.requireRun(ownerRef, runId);
    if (state.finished) {
      throw new GatewayError(
        'GATEWAY_RUN_NOT_CANCELLABLE',
        'This run has already finished, so it cannot be cancelled.',
        { details: { status: state.run.status } },
      );
    }
    state.controller.abort();
    return { ...state.run };
  }

  /** Pipes a run's events; resolves when the run ends or the consumer leaves. */
  async *follow(ownerRef: string, runId: string): AsyncIterable<ExecutionEvent> {
    const state = this.requireRun(ownerRef, runId);
    let index = 0;
    while (true) {
      const events = state.events;
      if (index < events.length) {
        yield events[index] as ExecutionEvent;
        index += 1;
        continue;
      }
      if (state.finished) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private requireRun(ownerRef: string, runId: string): RunState {
    const state = this.runs.get(runId);
    // Cross-owner access is a 404, never a 403: the existence of another
    // owner's run is not something this surface reveals.
    if (state === undefined || state.run.ownerRef !== ownerRef) {
      throw new GatewayError('GATEWAY_RUN_NOT_FOUND', 'That run does not exist.');
    }
    return state;
  }

  private prune(ownerRef: string): void {
    const owned = [...this.runs.values()].filter((s) => s.run.ownerRef === ownerRef);
    if (owned.length <= this.maxRunsPerOwner) return;
    for (const state of owned.slice(0, owned.length - this.maxRunsPerOwner)) {
      this.runs.delete(state.run.id);
      if (state.idempotencyKey !== undefined) {
        this.byIdempotency.delete(`${ownerRef}:${state.idempotencyKey}`);
      }
    }
  }

  private emit(state: RunState, event: ExecutionEvent): void {
    if (state.events.length >= this.maxEvents) state.events.shift();
    state.events.push(event);
    for (const listener of state.listeners) listener(event);
    state.queue.push(event);
  }

  private finish(state: RunState, event: ExecutionEvent, status: ExecutionStatus): void {
    state.finished = true;
    state.run = {
      ...state.run,
      status,
      updatedAt: this.now().toISOString(),
      content: state.content,
    };
    this.emit(state, event);
    state.queue.close();
  }

  private async execute(state: RunState, input: ExecutionStartInput): Promise<void> {
    const { gateway, router } = this.options;
    if (gateway === null || router === null) return;
    const runId = state.run.id;
    const maxOutputTokens = Math.min(Math.max(input.maxOutputTokens ?? 1_024, 1), this.ceiling);
    try {
      this.emit(state, {
        type: 'run.started',
        runId,
        at: this.now().toISOString(),
        category: input.category,
      } as ExecutionEvent);

      const messages: AIMessage[] = [
        ...(input.history ?? []).map((message) => ({
          role: message.role,
          content: message.content.slice(0, 20_000),
        })),
        { role: 'user' as const, content: input.task.slice(0, 20_000) },
      ];

      this.emit(state, {
        type: 'progress',
        runId,
        stage: 'routing',
        message: 'Choosing a model for this task.',
      });

      // ---------------------------------------------------------------------
      // 1. The router decides. Exactly once, before anything is billed.
      // ---------------------------------------------------------------------
      const decision = await router.routeFor(input.ownerRef, {
        category: input.category,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.stream !== false ? { needsStreaming: true } : {}),
        purpose: 'task execution',
      });

      if (decision.outcome !== 'routed' || decision.selected === null) {
        state.run = {
          ...state.run,
          routeSummary: decision.summary,
          errorCode: 'GATEWAY_ROUTE_UNAVAILABLE',
          errorMessage: decision.summary,
        };
        this.finish(
          state,
          {
            type: 'run.failed',
            runId,
            code: 'GATEWAY_ROUTE_UNAVAILABLE',
            message: decision.summary,
          },
          'failed',
        );
        return;
      }

      const selected = decision.selected;
      state.run = {
        ...state.run,
        providerId: selected.providerId,
        providerName: selected.providerName,
        modelId: selected.modelId,
        decisionId: decision.id,
        routeSummary: decision.summary,
      };
      this.emit(state, {
        type: 'route.selected',
        runId,
        providerId: selected.providerId,
        providerName: selected.providerName,
        modelId: selected.modelId,
        decisionId: decision.id,
        summary: decision.summary,
        contextWindowTokens: selected.contextWindowTokens,
        streaming: selected.streaming,
      });

      // ---------------------------------------------------------------------
      // 2. Context is fitted to that model, secrets scrubbed.
      // ---------------------------------------------------------------------
      this.emit(state, {
        type: 'progress',
        runId,
        stage: 'context',
        message: 'Preparing the context for this model.',
      });
      const prepared = prepareContext({
        ...(input.system !== undefined ? { system: input.system } : {}),
        messages,
        budget: {
          contextWindowTokens: selected.contextWindowTokens,
          maxOutputTokens,
        },
      });
      this.emit(state, {
        type: 'context.prepared',
        runId,
        estimatedInputTokens: prepared.estimatedInputTokens,
        truncated: prepared.truncated,
        droppedMessages: prepared.droppedMessages,
        notes: prepared.notes,
      });

      this.emit(state, {
        type: 'progress',
        runId,
        stage: 'generating',
        message: 'Waiting for the model.',
      });

      const request = {
        messages: prepared.messages,
        ...(prepared.system !== undefined ? { system: prepared.system } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        maxOutputTokens,
        connectionId: selected.connectionId,
        modelId: selected.modelId,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        category: input.category,
        runId,
        signal: state.controller.signal,
        estimatedInputTokens: prepared.estimatedInputTokens,
      } as const;

      const wantStream = input.stream !== false;
      if (wantStream && selected.streaming) {
        await this.runStreamed(
          state,
          gateway,
          request,
          maxOutputTokens,
          input.connectionId === undefined && input.modelId === undefined,
        );
        return;
      }

      // ---------------------------------------------------------------------
      // 3. One-piece answer (no streaming requested, or the model cannot).
      // ---------------------------------------------------------------------
      const outcome: GenerationOutcome = await this.generateWithFailover(
        state,
        gateway,
        request,
        // An explicitly named connection or model is the caller's decision and is
        // never moved elsewhere.
        input.connectionId === undefined && input.modelId === undefined,
      );
      state.content = outcome.content;
      state.run = { ...state.run, streamed: false };
      this.emitUsage(state, {
        providerId: outcome.providerId,
        modelId: outcome.modelId,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cachedInputTokens: outcome.usage.cachedInputTokens ?? null,
        latencyMs: outcome.latencyMs,
        streamed: false,
      });
      this.emit(state, { type: 'delta', runId, text: outcome.content });
      this.finish(
        state,
        {
          type: 'run.completed',
          runId,
          content: outcome.content,
          finishReason: outcome.finishReason,
          latencyMs: outcome.latencyMs,
          providerId: outcome.providerId,
          modelId: outcome.modelId,
          live: true,
          streamed: false,
        },
        'completed',
      );
    } catch (error) {
      const cancelled =
        state.controller.signal.aborted ||
        (isGatewayError(error) && error.code === 'GATEWAY_ABORTED');
      if (cancelled) {
        state.run = {
          ...state.run,
          content: state.content,
          errorCode: 'GATEWAY_ABORTED',
          errorMessage: 'The run was cancelled.',
        };
        this.finish(
          state,
          {
            type: 'run.cancelled',
            runId,
            message: 'The run was cancelled. Nothing further was generated.',
          },
          'cancelled',
        );
        return;
      }
      const code = isGatewayError(error) ? error.code : 'GATEWAY_PROVIDER_ERROR';
      const message = isGatewayError(error)
        ? error.message
        : 'The provider could not complete this request.';
      state.run = {
        ...state.run,
        content: state.content,
        errorCode: code,
        errorMessage: message,
      };
      this.finish(state, { type: 'run.failed', runId, code, message }, 'failed');
    }
  }

  /**
   * Provider-level failures worth trying somewhere else.
   *
   * A request the provider considers malformed, or a content refusal, is NOT in
   * this set: another provider would reject it too, and retrying it elsewhere
   * would only make the answer slower and less honest.
   */
  private static readonly FAILOVER_CODES = new Set([
    'GATEWAY_LIMIT_EXCEEDED',
    'GATEWAY_RATE_LIMITED',
    'GATEWAY_AUTH_FAILED',
    'GATEWAY_CREDENTIAL_INVALID',
    'GATEWAY_PROVIDER_UNAVAILABLE',
    'GATEWAY_TIMEOUT',
    'GATEWAY_KEY_UNAVAILABLE',
    'GATEWAY_ROUTE_UNAVAILABLE',
  ]);

  /**
   * The other connections that could serve this request, best first.
   *
   * Speed is the point: a connection whose keys are all resting, or whose
   * account is exhausted, is skipped WITHOUT a call, so a dead default costs one
   * failed request in total, not one per question.
   */
  private async failoverCandidates(
    ownerRef: string,
    excludeConnectionId: string,
    modelId: string | null,
  ): Promise<{ connectionId: string; modelId: string }[]> {
    const gateway = this.options.gateway;
    if (gateway === null) return [];
    const connections = await gateway.listConnections({ ownerRef }).catch(() => []);
    const now = Date.now();
    const out: { connectionId: string; modelId: string }[] = [];
    for (const entry of connections) {
      const connection = entry.connection;
      if (connection.id === excludeConnectionId) continue;
      const keys = connection.keys ?? [];
      const exhausted = keys.some((key) => key.lastErrorCategory === 'exhausted');
      if (exhausted) continue;
      const resting = keys.every(
        (key) =>
          key.status === 'cooling' &&
          key.cooldownUntil !== null &&
          Date.parse(key.cooldownUntil) > now,
      );
      if (keys.length > 0 && resting) continue;
      const model =
        connection.modelIds.includes(modelId ?? '') && modelId !== null
          ? modelId
          : (connection.defaultModelId ?? connection.modelIds[0] ?? null);
      if (model === null) continue;
      out.push({ connectionId: connection.id, modelId: model });
      if (out.length >= 2) break;
    }
    return out;
  }

  /** One complete answer, moving to another provider if this one cannot serve. */
  private async generateWithFailover(
    state: RunState,
    gateway: AIProviderGateway,
    request: Parameters<AIProviderGateway['generate']>[1],
    allowFailover: boolean,
  ): Promise<GenerationOutcome> {
    const scope = {
      ownerRef: state.run.ownerRef,
      ...(state.run.projectId ? { projectId: state.run.projectId } : {}),
    };
    try {
      return await gateway.generate(scope, request);
    } catch (error) {
      if (!allowFailover || !isGatewayError(error)) throw error;
      if (!AiExecutionService.FAILOVER_CODES.has(error.code)) throw error;
      const candidates = await this.failoverCandidates(
        state.run.ownerRef,
        request.connectionId ?? '',
        request.modelId ?? null,
      );
      let lastError: unknown = error;
      for (const candidate of candidates) {
        this.emit(state, {
          type: 'progress',
          runId: state.run.id,
          stage: 'generating',
          message: 'That provider cannot serve this request, so another one is being tried.',
        });
        try {
          const outcome = await gateway.generate(scope, {
            ...request,
            connectionId: candidate.connectionId,
            modelId: candidate.modelId,
          });
          // The run reports the provider that actually answered.
          state.run = {
            ...state.run,
            providerId: outcome.providerId,
            modelId: outcome.modelId,
          };
          return outcome;
        } catch (next) {
          lastError = next;
          if (!isGatewayError(next) || !AiExecutionService.FAILOVER_CODES.has(next.code)) {
            throw next;
          }
        }
      }
      throw lastError;
    }
  }

  /**
   * Streams one answer, trying another provider when the chosen one cannot serve.
   *
   * Nothing is retried after a token has been delivered: a half answer from one
   * provider cannot be completed by another, so the run fails honestly instead.
   */
  private async runStreamed(
    state: RunState,
    gateway: AIProviderGateway,
    request: Parameters<AIProviderGateway['generate']>[1],
    _maxOutputTokens: number,
    allowFailover = false,
  ): Promise<void> {
    const runId = state.run.id;
    const ownerRef = state.run.ownerRef;
    const scope = { ownerRef, ...(state.run.projectId ? { projectId: state.run.projectId } : {}) };
    const startedAt = Date.now();
    let usage:
      | {
          inputTokens: number | null;
          outputTokens: number | null;
          cachedInputTokens?: number | null;
        }
      | undefined;
    let finishReason = 'unknown';

    const attempts: Parameters<AIProviderGateway['generate']>[1][] = [request];
    if (allowFailover) {
      const candidates = await this.failoverCandidates(
        ownerRef,
        request.connectionId ?? '',
        request.modelId ?? null,
      );
      for (const candidate of candidates) {
        attempts.push({
          ...request,
          connectionId: candidate.connectionId,
          modelId: candidate.modelId,
        });
      }
    }

    let delivered = false;
    let answered = false;
    let lastError: unknown = null;

    try {
      for (const [index, attempt] of attempts.entries()) {
        if (index > 0) {
          this.emit(state, {
            type: 'progress',
            runId,
            stage: 'generating',
            message: 'That provider cannot serve this request, so another one is being tried.',
          });
          state.run = {
            ...state.run,
            providerId: null,
            modelId: attempt.modelId ?? state.run.modelId,
          };
        }
        try {
          for await (const chunk of gateway.stream(scope, attempt)) {
            if (chunk.usage !== undefined) usage = chunk.usage;
            if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
            if (chunk.delta.length > 0) {
              delivered = true;
              state.content += chunk.delta;
              this.emit(state, { type: 'delta', runId, text: chunk.delta });
            }
          }
          answered = true;
          break;
        } catch (error) {
          lastError = error;
          const retryable =
            allowFailover &&
            !delivered &&
            isGatewayError(error) &&
            AiExecutionService.FAILOVER_CODES.has(error.code);
          if (!retryable) throw error;
        }
      }
      if (!answered) throw lastError ?? new Error('no provider answered');
    } catch (error) {
      // A provider that simply cannot stream must not fail the run: fall back to
      // one complete answer, and say so in the completion event.
      if (isGatewayError(error) && error.code === 'GATEWAY_CAPABILITY_UNSUPPORTED') {
        const outcome = await this.generateWithFailover(state, gateway, request, allowFailover);
        state.content = outcome.content;
        state.run = { ...state.run, streamed: false };
        this.emitUsage(state, {
          providerId: outcome.providerId,
          modelId: outcome.modelId,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cachedInputTokens: outcome.usage.cachedInputTokens ?? null,
          latencyMs: outcome.latencyMs,
          streamed: false,
        });
        this.emit(state, { type: 'delta', runId, text: outcome.content });
        this.finish(
          state,
          {
            type: 'run.completed',
            runId,
            content: outcome.content,
            finishReason: outcome.finishReason,
            latencyMs: outcome.latencyMs,
            providerId: outcome.providerId,
            modelId: outcome.modelId,
            live: true,
            streamed: false,
          },
          'completed',
        );
        return;
      }
      throw error;
    }

    const latencyMs = Date.now() - startedAt;
    state.run = { ...state.run, streamed: true };
    this.emitUsage(state, {
      providerId: state.run.providerId ?? 'unknown',
      modelId: state.run.modelId ?? 'unknown',
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
      latencyMs,
      streamed: true,
    });
    this.finish(
      state,
      {
        type: 'run.completed',
        runId,
        content: state.content,
        finishReason,
        latencyMs,
        providerId: state.run.providerId ?? 'unknown',
        modelId: state.run.modelId ?? 'unknown',
        live: true,
        streamed: true,
      },
      'completed',
    );
  }

  private emitUsage(
    state: RunState,
    input: {
      readonly providerId: string;
      readonly modelId: string;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cachedInputTokens?: number | null;
      readonly latencyMs: number;
      readonly streamed: boolean;
    },
  ): void {
    const confirmed = input.inputTokens !== null && input.outputTokens !== null;
    const usage: Extract<ExecutionEvent, { type: 'usage' }> = {
      type: 'usage',
      runId: state.run.id,
      providerId: input.providerId,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      ...(input.cachedInputTokens === null || input.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: input.cachedInputTokens }),
      totalTokens: confirmed
        ? (input.inputTokens as number) + (input.outputTokens as number)
        : null,
      usageSource: confirmed ? 'provider-confirmed' : 'unavailable',
      estimatedCostUsd: null,
      costSource: 'unavailable',
      latencyMs: input.latencyMs,
      streamed: input.streamed,
    };
    state.run = { ...state.run, usage };
    this.emit(state, usage);
    // Written after the event reaches the caller: metering reports, it does not
    // gate a call that has already been paid for.
    this.options.onUsage?.({
      ownerRef: state.run.ownerRef,
      runId: state.run.id,
      providerId: input.providerId,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens ?? null,
    });
  }
}

/**
 * A refused run has no events to stream. Returning an empty async iterable keeps
 * the caller's loop shape identical instead of null-checking a stream.
 */
function emptyEvents(): AsyncIterable<ExecutionEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
}

export function createAiExecutionService(options: AiExecutionServiceOptions): AiExecutionService {
  return new AiExecutionService(options);
}
