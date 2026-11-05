/**
 * The API's reasoning service: builds one engine per owner (so a run can never
 * borrow another owner's credential), decides between the owner's real
 * provider and the disclosed offline mock, and keeps a bounded event buffer so
 * the web client can stream a run without duplicating its output.
 */

import type { AIProviderGateway } from '@veltravia/ai-gateway';
import { classifyPrompt, type PromptCategory } from './prompt-category.js';
import { GatewayError, isGatewayError } from '@veltravia/ai-gateway';
import {
  DEFAULT_REASONING_LIMITS,
  InMemoryReasoningUsageStore,
  REASONING_LIMIT_CEILINGS,
  ReasoningEngine,
  ReasoningError,
  GatewayReasoningProvider,
  getReasoningProfile,
  buildActivitySnapshot,
  listReasoningProfiles,
  reasoningUsageRecord,
  type ProviderFallback,
  type ReasoningEvent,
  type ReasoningLimits,
  type ReasoningProfileId,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningRun,
} from '@veltravia/reasoning-core';
import { SimulatedReasoningProvider } from '@veltravia/reasoning-mock';
import type { AgentActivitySnapshot } from '@veltravia/shared';
import type { ToolManager } from '@veltravia/tool-core';
import { mockDatabaseConnector, mockStorageConnector } from '@veltravia/integration-mocks';
import type { ApiIntegrationSystem } from './integrations.js';
import type { AppBuilderManager } from '@veltravia/app-builder-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { AudioIntelligenceManager } from '@veltravia/audio-intelligence-core';
import type { ImageIntelligenceManager } from '@veltravia/image-intelligence-core';
import type { VideoIntelligenceManager } from '@veltravia/video-intelligence-core';
import type { DocumentIntelligenceManager } from '@veltravia/document-intelligence-core';

import { createToolManager } from './tools.js';
import type { CodebaseIntelligenceManager } from '@veltravia/codebase-core';
import type { FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import type { IntelligenceService } from './intelligence-service.js';

export type ReasoningMode = 'gateway' | 'simulated';

export interface ReasoningStartInput {
  readonly profile: ReasoningProfileId;
  readonly task: string;
  readonly ownerRef: string;
  readonly projectId?: string;
  readonly mode?: ReasoningMode;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly conversation?: readonly {
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly context?: ReasoningRequest['context'];
  readonly limits?: Partial<ReasoningLimits>;
  readonly idempotencyKey?: string;
  /** Set by the service itself on Automatic runs; callers do not supply it. */
  readonly category?: PromptCategory;
}

export interface ReasoningEventRecord {
  readonly id: number;
  readonly runId: string;
  readonly event: ReasoningEvent;
}

export interface ReasoningToolSummary {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly riskLevel: string;
  readonly available: boolean;
}

/**
 * The backup chain for Automatic runs, tried in this order after the primary.
 * OpenAI is the default primary; Groq is a different company, so an OpenAI
 * outage does not take it down; OpenRouter is the last resort. Providers whose
 * keys are rejected (or that are not listed here) are never swapped in.
 */
export const FALLBACK_ORDER: readonly string[] = ['openai', 'groq', 'openrouter'];

/** A model a person has pinned for their own conversations. */
export interface ChatModelChoice {
  readonly connectionId: string;
  readonly modelId: string;
  /** What the chip shows: the model as the provider names it. */
  readonly label: string;
  readonly providerId: string;
  readonly providerName: string;
}

export interface AvailableModel extends ChatModelChoice {
  /** True for the connection the gateway would use by default. */
  readonly isDefaultConnection: boolean;
}

export interface ReasoningServiceOptions {
  readonly gateway: AIProviderGateway | null;
  /**
   * Step 28: the platform's single model-selection seam. When a gateway run
   * arrives without an explicit model, this decides which one runs and why; a
   * refusal is reported as an honest error rather than a silent substitution.
   */
  readonly routeFor?: (input: {
    readonly ownerRef: string;
    readonly projectId?: string;
    /** What the prompt is asking for, so Automatic can match a model to it. */
    readonly category?: PromptCategory;
  }) => Promise<
    | { readonly outcome: 'routed'; readonly connectionId: string; readonly modelId: string }
    | { readonly outcome: 'unsupported' | 'needs-attention'; readonly summary: string }
  >;
  readonly blockedReason?: string;
  readonly now?: () => Date;
  readonly codebase?: CodebaseIntelligenceManager;
  readonly files?: FileIntelligenceManager;
  readonly intelligence?: IntelligenceService;
  /**
   * The media and document managers behind the Document, Image, Video and Audio
   * pages. Passing them is what lets the AI read what the person uploaded; the
   * tools stay owner-scoped and read-only (see createToolManager).
   */
  readonly documents?: DocumentIntelligenceManager;
  readonly images?: ImageIntelligenceManager;
  readonly videos?: VideoIntelligenceManager;
  readonly audio?: AudioIntelligenceManager;
  /**
   * Connected apps and integrations. When given, the connector-backed tools are
   * registered through the same Tool System pipeline the agents use: the
   * connection authorises, the integration runtime executes, and a tool stays
   * UNAVAILABLE until a connection exists.
   */
  readonly integrations?: ApiIntegrationSystem;
  /** App Builder and the project engine it reads, for the read-only builder tools. */
  readonly appBuilder?: { readonly manager: AppBuilderManager; readonly projects: ProjectEngine };
  readonly simulatedFactory?: () => ReasoningProvider;
  /** Ceiling on buffered stream events per run. */
  readonly maxBufferedEvents?: number;
}

interface OwnerEngine {
  readonly engine: ReasoningEngine;
  readonly mode: ReasoningMode;
  readonly tools: ToolManager;
}

const MAX_RUNS_PER_ENGINE = 50;

export class ReasoningService {
  readonly usage = new InMemoryReasoningUsageStore();
  private readonly options: ReasoningServiceOptions;
  private readonly now: () => Date;
  private readonly engines = new Map<string, OwnerEngine>();
  private readonly events = new Map<string, ReasoningEventRecord[]>();
  private readonly listeners = new Map<string, Set<(record: ReasoningEventRecord) => void>>();
  private readonly maxBufferedEvents: number;
  /**
   * One pinned model per person, or nothing for Automatic.
   *
   * In memory, like the rest of this build: a restart puts everyone back on
   * Automatic rather than pretending a choice survived.
   */
  private readonly modelChoices = new Map<string, ChatModelChoice | null>();

  constructor(options: ReasoningServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.maxBufferedEvents = Math.max(50, options.maxBufferedEvents ?? 400);
  }

  /** What the UI needs before starting a run: profiles, limits, provider state. */
  capabilities(): {
    readonly profiles: readonly {
      readonly id: string;
      readonly displayName: string;
      readonly description: string;
      readonly contextKinds: readonly string[];
      readonly toolPrefixes: readonly string[];
    }[];
    readonly limits: ReasoningLimits;
    readonly ceilings: ReasoningLimits;
    readonly provider: {
      readonly connected: boolean;
      readonly reason: string | null;
      readonly modes: readonly ReasoningMode[];
    };
    readonly defaults: typeof DEFAULT_REASONING_LIMITS;
  } {
    const connected = this.options.gateway !== null;
    return {
      profiles: listReasoningProfiles().map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        description: profile.description,
        contextKinds: profile.contextKinds,
        toolPrefixes: profile.toolPrefixes,
      })),
      limits: DEFAULT_REASONING_LIMITS,
      ceilings: REASONING_LIMIT_CEILINGS,
      provider: {
        connected,
        reason: connected
          ? null
          : (this.options.blockedReason ?? 'No AI provider is connected yet.'),
        modes: connected ? ['gateway', 'simulated'] : ['simulated'],
      },
      defaults: DEFAULT_REASONING_LIMITS,
    };
  }

  /** Every model this person could pin, across their own connections. */
  async availableModels(ownerRef: string): Promise<readonly AvailableModel[]> {
    const gateway = this.options.gateway;
    if (gateway === null) return [];
    const entries = await gateway.listConnections({ ownerRef });
    const models: AvailableModel[] = [];
    for (const entry of entries) {
      if (entry.connection.status === 'disabled') continue;
      for (const model of entry.models) {
        models.push({
          connectionId: entry.connection.id,
          modelId: model.modelId,
          // The provider's own name for it, so the chip says what will answer.
          label: model.displayName,
          providerId: entry.connection.providerId,
          providerName: entry.providerName,
          isDefaultConnection: entry.isDefault,
        });
      }
    }
    return models;
  }

  /** The pinned model, or null when this person is on Automatic. */
  modelChoice(ownerRef: string): ChatModelChoice | null {
    return this.modelChoices.get(ownerRef) ?? null;
  }

  /**
   * Pins a model, or returns to Automatic when given null.
   *
   * The choice is checked against the models this person actually has: pinning
   * something unlisted would turn every send into a refusal.
   */
  async setModelChoice(
    ownerRef: string,
    choice: null | { connectionId: string; modelId: string },
  ): Promise<ChatModelChoice | null> {
    if (choice === null) {
      this.modelChoices.set(ownerRef, null);
      return null;
    }
    const available = await this.availableModels(ownerRef);
    const match = available.find(
      (model) => model.modelId === choice.modelId && model.connectionId === choice.connectionId,
    );
    if (match === undefined) {
      throw new ReasoningError(
        'REASONING_MODEL_UNKNOWN',
        'That model is not on a connection this account can use.',
      );
    }
    const pinned: ChatModelChoice = {
      connectionId: match.connectionId,
      modelId: match.modelId,
      label: match.label,
      providerId: match.providerId,
      providerName: match.providerName,
    };
    this.modelChoices.set(ownerRef, pinned);
    return pinned;
  }

  /** Builds the tool manager for one owner and returns its read-only tool list. */
  toolsFor(ownerRef: string): ToolManager {
    const integrations = this.options.integrations;
    const tools = createToolManager(
      this.now,
      undefined,
      undefined,
      integrations !== undefined
        ? {
            connectors: [mockStorageConnector(this.now), mockDatabaseConnector(this.now)],
            connectorExecutor: integrations.connectorExecutor(),
          }
        : undefined,
      this.options.codebase,
      undefined,
      this.options.files,
      this.options.audio,
      this.options.images,
      this.options.videos,
      this.options.intelligence,
      ownerRef,
      this.options.documents,
      this.options.appBuilder,
    );
    // Read-only grants only. Nothing destructive is reachable from reasoning:
    // an operator must grant it explicitly, and the Tool System still demands
    // a human confirmation for anything risky.
    tools.grantPermission('mock.summarize', 'mock.read');
    integrations?.registerAgentTools(tools);
    return tools;
  }

  /** The tools a caller may see, with availability, for the UI. */
  toolSummaries(ownerRef: string): readonly ReasoningToolSummary[] {
    const tools = this.toolsFor(ownerRef);
    return tools.list().map((definition) => ({
      id: definition.id,
      name: definition.name,
      category: definition.category,
      riskLevel: definition.riskLevel,
      available: tools.getAvailability(definition.id).state === 'available',
    }));
  }

  private engineKey(input: {
    ownerRef: string;
    projectId?: string;
    connectionId?: string;
    modelId?: string;
    category?: PromptCategory;
    mode: ReasoningMode;
  }): string {
    return [
      input.mode,
      input.ownerRef,
      input.projectId ?? '-',
      input.connectionId ?? '-',
      input.modelId ?? '-',
      // Automatic picks a model per kind of request, so each kind keeps its own engine.
      input.category ?? '-',
    ].join('|');
  }

  private async engineFor(input: ReasoningStartInput): Promise<OwnerEngine> {
    const mode: ReasoningMode = input.mode ?? 'gateway';
    const key = this.engineKey({
      ownerRef: input.ownerRef,
      mode,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    });
    const existing = this.engines.get(key);
    if (existing !== undefined && existing.engine.listRuns().length < MAX_RUNS_PER_ENGINE) {
      return existing;
    }

    const tools = this.toolsFor(input.ownerRef);
    let provider: ReasoningProvider;
    if (mode === 'simulated') {
      provider = this.options.simulatedFactory
        ? this.options.simulatedFactory()
        : new SimulatedReasoningProvider({ respondToStep: true });
    } else {
      if (this.options.gateway === null) {
        throw new GatewayError(
          'GATEWAY_NO_PROVIDER_CONFIGURED',
          this.options.blockedReason ??
            'No AI provider is connected yet. Connect one in Settings, then run reasoning.',
        );
      }
      // Step 28: with no explicit model, the platform's router decides - and a
      // refusal is reported as-is instead of quietly trying something else.
      let connectionId = input.connectionId;
      let modelId = input.modelId;
      // A model the caller named is an instruction, so it is never swapped for
      // another provider mid-run. Only a router-chosen (Automatic) run may fall back.
      const namedByCaller = connectionId !== undefined && modelId !== undefined;
      if (connectionId === undefined || modelId === undefined) {
        if (this.options.routeFor === undefined) {
          throw new GatewayError(
            'GATEWAY_NO_PROVIDER_CONFIGURED',
            'No model has been selected for this run. Choose one in Settings → Model routing.',
          );
        }
        const routed = await this.options.routeFor({
          ownerRef: input.ownerRef,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
        });
        if (routed.outcome !== 'routed') {
          throw new GatewayError('GATEWAY_NO_PROVIDER_CONFIGURED', routed.summary);
        }
        connectionId = routed.connectionId;
        modelId = routed.modelId;
      }

      provider = new GatewayReasoningProvider({
        gateway: this.options.gateway,
        scope: {
          ownerRef: input.ownerRef,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        },
        connectionId,
        modelId,
        // On Automatic, one spent balance or outage must not end the conversation,
        // so a small backup chain applies (see FALLBACK_ORDER). A pinned model gets
        // none: if it fails the person sees the failure rather than a different model.
        ...(namedByCaller ? {} : await this.providerPlan(input.ownerRef, connectionId)),
      });
    }

    const engine = new ReasoningEngine({
      provider,
      tools,
      now: this.now,
    });
    const entry: OwnerEngine = { engine, mode, tools };
    this.engines.set(key, entry);
    return entry;
  }

  /**
   * The other connections that could answer when the first one cannot.
   *
   * Healthy connections only, ordered by the owner's stated preference (Groq,
   * then OpenRouter), each with the model its own connection is configured for.
   * A connection with no model on it is skipped rather than guessed.
   */
  private async providerPlan(
    ownerRef: string,
    primaryConnectionId: string | undefined,
  ): Promise<{ primaryProviderId?: string; fallbacks: ProviderFallback[] }> {
    const empty = { fallbacks: [] as ProviderFallback[] };
    if (!this.options.gateway) return empty;
    let entries;
    try {
      entries = await this.options.gateway.listConnections({ ownerRef });
    } catch {
      return empty;
    }
    const rank = (providerId: string) => FALLBACK_ORDER.indexOf(providerId);
    const primary = entries.find((entry) => entry.connection.id === primaryConnectionId);
    const fallbacks = entries
      // Only providers in the chain are ever used as a backup. Others stay
      // available to pick by hand but are not swapped in silently.
      .filter(
        (entry) =>
          entry.healthy &&
          entry.connection.id !== primaryConnectionId &&
          rank(entry.connection.providerId) !== -1,
      )
      .sort((a, b) => rank(a.connection.providerId) - rank(b.connection.providerId))
      .map((entry) => ({
        connectionId: entry.connection.id,
        // `models` carries the gateway's model records; the id is what the
        // gateway takes back in a completion request.
        modelId:
          entry.connection.defaultModelId ??
          entry.models.find((model) => model.available)?.modelId ??
          entry.models[0]?.modelId ??
          '',
        providerId: entry.connection.providerId,
      }))
      .filter((candidate) => candidate.modelId !== '')
      .slice(0, 2);
    return {
      ...(primary ? { primaryProviderId: primary.connection.providerId } : {}),
      fallbacks,
    };
  }

  /** Starts a run and returns as soon as it has an id. */
  async start(input: ReasoningStartInput): Promise<ReasoningRun> {
    const profile = getReasoningProfile(input.profile);
    if (profile === undefined) {
      throw new ReasoningError(
        'REASONING_UNKNOWN_PROFILE',
        'That reasoning profile does not exist.',
      );
    }
    // A pinned model is the person's instruction, so it is applied to a run that
    // does not name one. Automatic sends nothing and the router decides.
    const pinned = input.modelId === undefined ? this.modelChoice(input.ownerRef) : null;
    // On Automatic the prompt decides the kind of request, and the router picks
    // a model that suits it. A named or pinned model skips this entirely.
    const category =
      pinned === null && input.modelId === undefined ? classifyPrompt(input.task) : undefined;
    const entry = await this.engineFor(
      pinned === null
        ? { ...input, ...(category !== undefined ? { category } : {}) }
        : { ...input, connectionId: pinned.connectionId, modelId: pinned.modelId },
    );
    const availableTools = entry.tools.list().map((definition) => definition.id);

    let counter = 0;
    const early: ReasoningEvent[] = [];
    let runId: string | null = null;
    const started = entry.engine.start(
      {
        profile: input.profile,
        task: input.task,
        ownerRef: input.ownerRef,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        availableTools,
      },
      {
        onEvent: (event) => {
          counter += 1;
          // The engine can emit its first event before `start()` returns, so
          // those are buffered and published once the run id exists.
          if (runId === null) early.push(event);
          else this.publish(runId, { id: counter, runId, event });
        },
      },
    );
    runId = started.run.id;
    this.runOwners.set(runId, input.ownerRef);
    for (const event of early) {
      const index = early.indexOf(event) + 1;
      this.publish(runId, { id: index, runId, event });
    }
    void started.completion.then((run) => {
      void this.usage.record(reasoningUsageRecord(run));
      counter += 1;
      this.publish(started.run.id, {
        id: counter,
        runId: run.id,
        event: {
          type: 'usage',
          at: this.now().toISOString(),
          usage: run.usage,
        },
      });
      this.finished.set(run.id, run);
    });
    return started.run;
  }

  /** Which owner started each run. A run is invisible to every other owner. */
  private readonly runOwners = new Map<string, string>();
  private readonly finished = new Map<string, ReasoningRun>();

  /** True when this owner started the run. Unknown runs look missing, not forbidden. */
  ownsRun(runId: string, ownerRef: string): boolean {
    return this.runOwners.get(runId) === ownerRef;
  }

  private publish(runId: string, record: ReasoningEventRecord): void {
    const buffer = this.events.get(runId) ?? [];
    buffer.push(record);
    if (buffer.length > this.maxBufferedEvents)
      buffer.splice(0, buffer.length - this.maxBufferedEvents);
    this.events.set(runId, buffer);
    for (const listener of this.listeners.get(runId) ?? []) listener(record);
  }

  /**
   * The normalised activity timeline for a run, optionally from a sequence.
   *
   * This is the only place a browser is told what a run is doing. It is derived
   * from the run the service already owns, so a reconnecting client gets the
   * same rows a streaming one saw - and a run that is still working reports
   * `terminal: false` rather than a made-up ending.
   */
  async activitySnapshot(input: {
    ownerRef: string;
    runId: string;
    after?: number;
  }): Promise<AgentActivitySnapshot | undefined> {
    const run = await this.getRun({ ownerRef: input.ownerRef, runId: input.runId });
    if (run === undefined) return undefined;
    return buildActivitySnapshot(run, input.after ?? 0);
  }

  /** Replays buffered events, then follows the run live. */
  subscribe(
    runId: string,
    listener: (record: ReasoningEventRecord) => void,
    afterId = 0,
  ): () => void {
    for (const record of this.events.get(runId) ?? []) {
      if (record.id > afterId) listener(record);
    }
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
    };
  }

  /** Reads a run: from the live engine first, then the finished cache. */
  async getRun(input: {
    ownerRef: string;
    runId: string;
    profile?: ReasoningProfileId;
  }): Promise<ReasoningRun | undefined> {
    if (!this.ownsRun(input.runId, input.ownerRef)) return undefined;
    for (const entry of this.engines.values()) {
      const run = entry.engine.getRun(input.runId);
      if (run !== undefined) return run;
    }
    return this.finished.get(input.runId);
  }

  async cancel(input: { runId: string; ownerRef: string }): Promise<ReasoningRun> {
    this.assertOwned(input.runId, input.ownerRef);
    for (const entry of this.engines.values()) {
      const run = entry.engine.getRun(input.runId);
      if (run !== undefined) return entry.engine.cancel(input.runId);
    }
    throw new ReasoningError('REASONING_RUN_NOT_FOUND', 'That reasoning run does not exist.');
  }

  /**
   * Gives a run that stopped at its budget a fresh one. Owner-scoped exactly like
   * cancel: a run belonging to someone else is "not found", never "forbidden".
   */
  async continue(input: { runId: string; ownerRef: string }): Promise<ReasoningRun> {
    this.assertOwned(input.runId, input.ownerRef);
    for (const entry of this.engines.values()) {
      const run = entry.engine.getRun(input.runId);
      if (run !== undefined) return entry.engine.continueRun(input.runId);
    }
    throw new ReasoningError('REASONING_RUN_NOT_FOUND', 'That reasoning run does not exist.');
  }

  async decide(input: {
    runId: string;
    ownerRef: string;
    confirmationId: string;
    decision: 'approved' | 'rejected';
  }): Promise<ReasoningRun> {
    this.assertOwned(input.runId, input.ownerRef);
    for (const entry of this.engines.values()) {
      const run = entry.engine.getRun(input.runId);
      if (run !== undefined) {
        if (run.pendingConfirmation === undefined) {
          throw new ReasoningError(
            'REASONING_RUN_STATE',
            'That run is not waiting for a decision.',
          );
        }
        if (run.pendingConfirmation.confirmationId !== input.confirmationId) {
          throw new ReasoningError(
            'REASONING_CONFIRMATION_INVALID',
            'That confirmation does not belong to this run.',
          );
        }
        // The Tool System is the only authority that can release a paused
        // invocation, and it enforces expiry and input binding itself.
        try {
          entry.tools.confirm(input.confirmationId, input.decision);
        } catch {
          throw new ReasoningError(
            'REASONING_CONFIRMATION_INVALID',
            'That confirmation is no longer valid. Start the run again.',
          );
        }
        return entry.engine.resume(input.runId, input.confirmationId, input.decision);
      }
    }
    throw new ReasoningError('REASONING_RUN_NOT_FOUND', 'That reasoning run does not exist.');
  }

  private assertOwned(runId: string, ownerRef: string): void {
    if (!this.ownsRun(runId, ownerRef)) {
      throw new ReasoningError('REASONING_RUN_NOT_FOUND', 'That reasoning run does not exist.');
    }
  }

  history(limit = 20): ReturnType<InMemoryReasoningUsageStore['list']> {
    return this.usage.list(limit);
  }
}

export function isReasoningGatewayError(error: unknown): error is GatewayError {
  return isGatewayError(error);
}
