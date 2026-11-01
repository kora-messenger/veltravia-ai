import type { AICapability } from '@veltravia/ai-core';
import { buildCatalog, catalogCapabilitySummary, describeCapabilities } from './catalog.js';
import { RouterError } from './errors.js';
import {
  applyPreferenceUpdate,
  defaultPreferences,
  resolveAutoSelect,
  resolvePreferenceKind,
  resolveStoredChoice,
  type ChoiceResolver,
  type PreferenceUpdate,
  type RouterPreferenceStore,
} from './preferences.js';
import { requirementFor, TASK_REQUIREMENT_LIST } from './tasks.js';

import {
  isTaskCategory,
  type CatalogModel,
  type ConnectionFacts,
  type ModelChoice,
  type PreferenceKind,
  type ProviderFacts,
  type ProviderModelSeed,
  type RejectedModel,
  type RouteScope,
  type RoutingDecision,
  type RoutingMode,
  type RoutingRequest,
  type RouterPreferences,
  type TaskCategory,
} from './types.js';

/** Distinct, bounded explanations for models that exist but cannot run. */
function unusableReasons(models: readonly CatalogModel[]): readonly string[] {
  const seen = new Set<string>();
  for (const model of models) {
    if (model.available) continue;
    seen.add(model.unavailableReason ?? 'The reason is unknown.');
    if (seen.size >= 3) break;
  }
  return [...seen];
}
/**
 * The model router.
 *
 * One decision point for every model call in the platform. It reads the owner's
 * catalog, states what the task requires, applies the most specific preference
 * the owner set, and either names a model with a readable reason or refuses with
 * a readable reason. It never calls a provider - the Step 26 gateway still does
 * that - so a decision costs nothing and can never bill twice.
 */

export interface ConnectionSource {
  /** Every connection this owner owns. Never another owner's. */
  list(ownerRef: string): Promise<readonly ConnectionFacts[]>;
}

export interface RouterOptions {
  readonly connections: ConnectionSource;
  readonly providers: readonly ProviderFacts[];
  readonly preferences: RouterPreferenceStore;
  /**
   * Optional provider-reported model facts per connection, when discovery ran.
   * Absent means "the vendor did not report", not "no capabilities".
   */
  readonly discovery?: (
    ownerRef: string,
    connectionId: string,
  ) => Promise<Readonly<Record<string, ProviderModelSeed>> | undefined>;
  readonly now?: () => Date;
  /** Decisions kept per owner for the "why this model" panel. */
  readonly decisionHistory?: number;
  /** How long an observed outage keeps a model out of the running. */
  readonly outageMs?: number;
}

export interface ModelObservation {
  readonly providerId: string;
  readonly modelId: string;
  readonly status: 'success' | 'failure';
  readonly latencyMs?: number;
  readonly at: string;
}

interface ObservationState {
  latencies: number[];
  failures: string[];
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

const DEFAULT_HISTORY = 40;
const DEFAULT_OUTAGE_MS = 10 * 60 * 1000;
const FAILURES_FOR_OUTAGE = 3;

/** Ids providers mark as not-yet-general: previews, labs, betas, experiments. */
const UNSTABLE_MODEL_ID = /(preview|experimental|alpha|beta|lab|test|early-access)/i;

/** In-process evidence about how models behaved. Never leaves the server. */
export class InMemoryObservationStore {
  private readonly byKey = new Map<string, ObservationState>();

  record(observation: ModelObservation): void {
    const key = `${observation.providerId}:${observation.modelId}`;
    const state = this.byKey.get(key) ?? {
      latencies: [],
      failures: [],
      lastFailureAt: null,
      lastSuccessAt: null,
    };
    const at = Date.parse(observation.at);
    if (observation.status === 'success') {
      state.lastSuccessAt = at;
      state.failures = [];
      if (typeof observation.latencyMs === 'number' && Number.isFinite(observation.latencyMs)) {
        state.latencies = [...state.latencies, observation.latencyMs].slice(-8);
      }
    } else {
      state.lastFailureAt = at;
      state.failures = [...state.failures, 'failure'].slice(-FAILURES_FOR_OUTAGE);
    }
    this.byKey.set(key, state);
  }

  /** Median of recent successful latencies, or null when nothing was measured. */
  latencyFor(providerId: string, modelId: string): number | null {
    const latencies = this.byKey.get(`${providerId}:${modelId}`)?.latencies ?? [];
    if (latencies.length === 0) return null;
    const sorted = [...latencies].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  /** A plain reason when this model is currently considered down. */
  outageFor(providerId: string, modelId: string, now: number, windowMs: number): string | null {
    const state = this.byKey.get(`${providerId}:${modelId}`);
    if (state === undefined) return null;
    if (state.failures.length < FAILURES_FOR_OUTAGE) return null;
    if (state.lastFailureAt === null || now - state.lastFailureAt > windowMs) return null;
    return 'The last few attempts through this model failed, so it is paused for a short while.';
  }

  clear(): void {
    this.byKey.clear();
  }
}

export interface RouterDeps {
  readonly options: RouterOptions;
  readonly observations?: InMemoryObservationStore;
}

const MISSING_CAPABILITY_WORDS: Readonly<Record<string, string>> = {
  'text-generation': 'writing text',
  'structured-output': 'returning typed fields',
  streaming: 'streaming its answer',
  vision: 'reading images',
  'image-generation': 'creating images',
  'tool-calling': 'calling tools',
  embeddings: 'producing vectors',
  'audio-input': 'taking audio in',
  'audio-output': 'speaking',
  'large-context': 'handling long context',
  'code-generation': 'writing code',
};

function capabilityWords(capability: string): string {
  return MISSING_CAPABILITY_WORDS[capability] ?? capability;
}

function requireOwner(scope: RouteScope): string {
  const ownerRef = typeof scope.ownerRef === 'string' ? scope.ownerRef.trim() : '';
  if (ownerRef.length === 0) {
    throw new RouterError('ROUTER_INVALID_REQUEST', 'A routing request needs an owner.');
  }
  return ownerRef;
}

let decisionCounter = 0;

export class ModelRouter {
  private readonly options: RouterOptions;
  private readonly observations: InMemoryObservationStore;
  private readonly decisions = new Map<string, RoutingDecision[]>();

  constructor(deps: RouterDeps) {
    this.options = deps.options;
    this.observations = deps.observations ?? new InMemoryObservationStore();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  // -------------------------------------------------------------------------
  // Catalog and capabilities
  // -------------------------------------------------------------------------

  async catalog(scope: RouteScope): Promise<{
    readonly models: readonly CatalogModel[];
    readonly providers: number;
    readonly capabilityCounts: Readonly<Record<string, number>>;
    readonly notes: readonly string[];
  }> {
    const ownerRef = requireOwner(scope);
    const models = await this.buildCatalog(ownerRef);
    const notes: string[] = [];
    if (models.length === 0) {
      notes.push('No provider is connected yet, so there is no model to choose from.');
    } else if (!models.some((model) => model.available)) {
      notes.push(
        `Your ${models.length === 1 ? 'connected model is' : 'connected models are'} not usable right now: ${unusableReasons(models).join('; ')}`,
      );
    }
    const unknownWindows = models.filter((model) => model.contextWindowTokens === null).length;
    if (unknownWindows > 0) {
      notes.push(
        `${unknownWindows} model(s) do not report a context window, so long-input limits cannot be checked for them.`,
      );
    }
    if (!models.some((model) => model.capabilitySource === 'provider-reported')) {
      notes.push(
        'No capabilities were reported by a vendor yet; the capabilities shown come from the platform catalog.',
      );
    }
    return {
      models,
      providers: new Set(models.map((model) => model.providerId)).size,
      capabilityCounts: catalogCapabilitySummary(models),
      notes,
    };
  }

  /** Per-category honest support state, for the settings screen. */
  async capabilities(scope: RouteScope): Promise<
    readonly {
      readonly category: TaskCategory;
      readonly displayName: string;
      readonly description: string;
      readonly required: readonly AICapability[];
      readonly supported: boolean;
      readonly modelCount: number;
      readonly reason: string | null;
    }[]
  > {
    const ownerRef = requireOwner(scope);
    const models = await this.buildCatalog(ownerRef);
    const usable = models.filter((model) => model.available);

    return TASK_REQUIREMENT_LIST.map((requirement) => {
      const matching = usable.filter((model) =>
        requirement.required.every((capability) => model.capabilities.includes(capability)),
      );
      if (requirement.structuralGap !== undefined) {
        return {
          category: requirement.category,
          displayName: requirement.displayName,
          description: requirement.description,
          required: requirement.required,
          supported: false,
          modelCount: 0,
          reason: requirement.structuralGap,
        };
      }
      if (usable.length === 0) {
        return {
          category: requirement.category,
          displayName: requirement.displayName,
          description: requirement.description,
          required: requirement.required,
          supported: false,
          modelCount: 0,
          // "Nothing is connected" and "what is connected cannot be used" are
          // different problems with different fixes; never report the wrong one.
          reason:
            models.length === 0
              ? 'No provider is connected yet.'
              : `Your ${models.length === 1 ? 'connected model is' : 'connected models are'} not usable right now: ${unusableReasons(models).join('; ')}`,
        };
      }
      if (matching.length === 0) {
        const missing = requirement.required
          .filter((capability) => !usable.some((model) => model.capabilities.includes(capability)))
          .map(capabilityWords);
        return {
          category: requirement.category,
          displayName: requirement.displayName,
          description: requirement.description,
          required: requirement.required,
          supported: false,
          modelCount: 0,
          reason: `None of your connected models declares ${missing.join(' and ')}.`,
        };
      }
      return {
        category: requirement.category,
        displayName: requirement.displayName,
        description: requirement.description,
        required: requirement.required,
        supported: true,
        modelCount: matching.length,
        reason: null,
      };
    });
  }

  private async buildCatalog(ownerRef: string): Promise<readonly CatalogModel[]> {
    const connections = await this.options.connections.list(ownerRef);
    const discovered: Record<string, Readonly<Record<string, ProviderModelSeed>>> = {};
    if (this.options.discovery !== undefined) {
      for (const connection of connections) {
        try {
          const facts = await this.options.discovery(ownerRef, connection.id);
          if (facts !== undefined && Object.keys(facts).length > 0)
            discovered[connection.id] = facts;
        } catch {
          // Discovery is evidence, not authority: a failure means "not reported".
        }
      }
    }
    const now = this.now().getTime();
    const unavailable: Record<string, string> = {};
    for (const connection of connections) {
      for (const modelId of connection.modelIds) {
        const outage = this.observations.outageFor(
          connection.providerId,
          modelId,
          now,
          this.options.outageMs ?? DEFAULT_OUTAGE_MS,
        );
        if (outage !== null) unavailable[`${connection.providerId}:${modelId}`] = outage;
      }
    }
    return buildCatalog({
      connections,
      providers: this.options.providers,
      discovered,
      unavailable,
    });
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  async preferences(scope: RouteScope): Promise<RouterPreferences> {
    const ownerRef = requireOwner(scope);
    return (
      (await this.options.preferences.get(ownerRef)) ?? defaultPreferences(ownerRef, this.now())
    );
  }

  async updatePreferences(scope: RouteScope, update: PreferenceUpdate): Promise<RouterPreferences> {
    requireOwner(scope);
    const current = await this.preferences(scope);
    const resolver: ChoiceResolver = async (ref, connectionId, modelId) =>
      this.requireOwnedChoice(ref, connectionId, modelId);
    const next = await applyPreferenceUpdate(current, update, resolver);
    return this.options.preferences.put({ ...next, updatedAt: this.now().toISOString() });
  }

  /** Validates a connection/model pair against this owner's connections. */
  private async requireOwnedChoice(
    ownerRef: string,
    connectionId: string,
    modelId: string,
  ): Promise<ModelChoice> {
    const connections = await this.options.connections.list(ownerRef);
    const connection = connections.find((entry) => entry.id === connectionId);
    if (connection === undefined) {
      throw new RouterError(
        'ROUTER_PREFERENCE_UNUSABLE',
        'That provider connection is not yours or no longer exists.',
      );
    }
    if (!connection.modelIds.includes(modelId)) {
      throw new RouterError(
        'ROUTER_PREFERENCE_UNUSABLE',
        'That model is not available on the chosen connection.',
      );
    }
    return { connectionId: connection.id, providerId: connection.providerId, modelId };
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  async route(scope: RouteScope, request: RoutingRequest): Promise<RoutingDecision> {
    const startedAt = Date.parse(this.now().toISOString());
    const ownerRef = requireOwner(scope);
    if (!isTaskCategory(request.category)) {
      throw new RouterError('ROUTER_UNKNOWN_CATEGORY', 'That task category is not supported.');
    }
    const requirement = requirementFor(request.category);
    const projectId = request.projectId ?? scope.projectId;
    const preferences = await this.preferences(scope);
    const preferenceKind = resolvePreferenceKind(preferences, projectId);
    const models = await this.buildCatalog(ownerRef);

    const required: AICapability[] = [...requirement.required, ...(request.requires ?? [])].filter(
      (capability, index, all) => all.indexOf(capability) === index,
    ) as AICapability[];

    const warnings: string[] = [];
    const missingEvidence: string[] = [];
    const rejected: RejectedModel[] = [];
    const decide = (
      outcome: RoutingDecision['outcome'],
      selected: RoutingDecision['selected'],
      summary: string,
      decidedBy: RoutingDecision['decidedBy'],
      mode: RoutingMode,
      fallback: RoutingDecision['fallback'],
    ): RoutingDecision => {
      const finishedAt = Date.parse(this.now().toISOString());
      const decision: RoutingDecision = {
        id: `rte_${startedAt.toString(36)}_${(decisionCounter += 1).toString(36)}`,
        ownerRef,
        projectId: projectId ?? null,
        category: request.category,
        mode,
        outcome,
        requestedAt: this.now().toISOString(),
        selected,
        summary,
        capabilitiesRequired: required,
        preference: preferenceKind,
        decidedBy,
        rejected,
        warnings,
        fallback,
        costComparison: preferenceKind === 'lower-cost' ? 'unavailable' : 'not-requested',
        contextWindowTokens: selected?.contextWindowTokens ?? null,
        audit: {
          candidateCount: models.length,
          consideredCount: models.filter((model) => model.available).length,
          rejectedCount: rejected.length,
          missingEvidence,
          durationMs: Math.max(0, finishedAt - startedAt),
        },
      };
      this.remember(decision);
      return decision;
    };

    if (preferenceKind === 'lower-cost') {
      missingEvidence.push('model pricing');
      warnings.push(
        'Cost comparison is unavailable: no reliable per-model pricing is configured, so this choice is not a claim about being cheapest.',
      );
    }

    // A category the platform cannot serve yet fails honestly.
    if (requirement.structuralGap !== undefined) {
      for (const model of models) {
        rejected.push(this.reject(model, requirement.structuralGap));
      }
      return decide(
        'unsupported',
        null,
        `${requirement.displayName} is not available yet. ${requirement.structuralGap}`,
        'automatic',
        request.mode ?? 'automatic',
        {
          policy: preferences.allowFallback ? 'compatible-alternate' : 'none',
          used: false,
          replaced: null,
        },
      );
    }

    // ---- manual selection -------------------------------------------------
    const wantsManual =
      request.mode === 'manual' ||
      (request.connectionId !== undefined && request.modelId !== undefined);
    if (wantsManual) {
      const chosen = await this.requireManualPick(ownerRef, models, request, required);
      if (chosen.kind === 'rejected') {
        return decide('needs-attention', null, chosen.reason, 'manual-request', 'manual', {
          policy: 'none',
          used: false,
          replaced: null,
        });
      }
      return decide(
        'routed',
        this.selectedOf(chosen.model),
        `Using ${chosen.model.displayName} through ${chosen.model.providerName} because you chose it, and it covers what ${requirement.displayName.toLowerCase()} needs (${describeCapabilities(requirement.required)}).`,
        'manual-request',
        'manual',
        { policy: 'none', used: false, replaced: null },
      );
    }

    if (models.length === 0) {
      return decide(
        'unsupported',
        null,
        'No AI provider is connected yet. Connect one in Settings → AI providers, then this task can be routed.',
        'automatic',
        request.mode ?? 'automatic',
        { policy: 'none', used: false, replaced: null },
      );
    }

    // ---- project-specific selection --------------------------------------
    if (request.mode === 'project') {
      if (projectId === undefined) {
        throw new RouterError(
          'ROUTER_INVALID_REQUEST',
          'Project routing needs a project so its own preference can be used.',
        );
      }
      const projectPreference = preferences.projectPreferences[projectId];
      if (projectPreference?.model === undefined) {
        return decide(
          'needs-attention',
          null,
          'This project has no model of its own yet. Set one here, or switch the project to automatic selection.',
          'project-preference',
          'project',
          { policy: 'none', used: false, replaced: null },
        );
      }
    }

    // ---- stored preference (default, project or task) ---------------------
    const stored = resolveStoredChoice(preferences, request.category, projectId);
    const autoSelect = resolveAutoSelect(preferences, projectId);

    // A stored choice is the owner's decision, so it is preferred whenever one
    // exists. Automatic scoring only decides when the owner has not chosen.
    if (stored.choice !== null) {
      const match = models.find(
        (model) =>
          model.connectionId === stored.choice?.connectionId &&
          model.modelId === stored.choice?.modelId,
      );
      const mismatch = this.mismatchOf(match, required, request);
      if (match === undefined || !match.available || mismatch !== null) {
        const why =
          match === undefined
            ? 'That model is no longer connected.'
            : match.available
              ? `${match.displayName} cannot do this task: ${mismatch ?? 'it does not meet the requirements'}.`
              : `${match.displayName} cannot be used right now: ${match.unavailableReason ?? 'it is unavailable'}.`;

        if (preferences.allowFallback && autoSelect) {
          const fallback = this.chooseBest(
            models,
            required,
            request,
            preferenceKind,
            projectId,
            preferences,
            warnings,
            missingEvidence,
            rejected,
          );
          if (fallback !== null) {
            return decide(
              'routed',
              this.selectedOf(fallback),
              `Your saved choice could not run this task, so ${fallback.displayName} through ${fallback.providerName} was used instead because you allowed a compatible alternative. ${why}`,
              stored.decidedBy,
              'automatic',
              {
                policy: 'compatible-alternate',
                used: true,
                replaced: match?.displayName ?? 'your saved model',
              },
            );
          }
        }
        return decide(
          'needs-attention',
          null,
          `${why} Nothing else was switched in automatically, because the router does not change your chosen model on its own.`,
          stored.decidedBy,
          autoSelect ? 'automatic' : 'manual',
          {
            policy: preferences.allowFallback ? 'compatible-alternate' : 'none',
            used: false,
            replaced: null,
          },
        );
      }
      return decide(
        'routed',
        this.selectedOf(match),
        `Using ${match.displayName} through ${match.providerName} because ${
          stored.decidedBy === 'task-preference'
            ? `you picked it for ${requirement.displayName.toLowerCase()}`
            : stored.decidedBy === 'project-preference'
              ? 'this project has its own model'
              : 'it is your default model'
        }, and it covers what that task needs (${describeCapabilities(requirement.required)}).`,
        stored.decidedBy,
        request.mode ?? 'automatic',
        {
          policy: preferences.allowFallback ? 'compatible-alternate' : 'none',
          used: false,
          replaced: null,
        },
      );
    }

    // ---- automatic selection ---------------------------------------------
    const best = this.chooseBest(
      models,
      required,
      request,
      preferenceKind,
      projectId,
      preferences,
      warnings,
      missingEvidence,
      rejected,
    );
    if (best === null) {
      const connected = models.some((model) => model.available);
      const summary = connected
        ? `None of your connected models meets what ${requirement.displayName.toLowerCase()} needs (${requirement.required
            .map(capabilityWords)
            .join(' and ')}), so nothing was chosen.`
        : 'Every provider connection is currently unusable, so nothing was chosen.';
      return decide('unsupported', null, summary, 'automatic', 'automatic', {
        policy: preferences.allowFallback ? 'compatible-alternate' : 'none',
        used: false,
        replaced: null,
      });
    }

    const why = this.whyChosen(best, required, preferenceKind, models);
    return decide('routed', this.selectedOf(best), why, 'automatic', 'automatic', {
      policy: preferences.allowFallback ? 'compatible-alternate' : 'none',
      used: false,
      replaced: null,
    });
  }

  private async requireManualPick(
    ownerRef: string,
    models: readonly CatalogModel[],
    request: RoutingRequest,
    required: readonly AICapability[],
  ): Promise<{ kind: 'ok'; model: CatalogModel } | { kind: 'rejected'; reason: string }> {
    if (request.connectionId === undefined || request.modelId === undefined) {
      throw new RouterError(
        'ROUTER_INVALID_REQUEST',
        'Manual routing needs both a provider connection and a model.',
      );
    }
    const connection = (await this.options.connections.list(ownerRef)).find(
      (entry) => entry.id === request.connectionId,
    );
    if (connection === undefined) {
      throw new RouterError(
        'ROUTER_PREFERENCE_UNUSABLE',
        'That provider connection is not yours or no longer exists.',
      );
    }
    const model = models.find(
      (entry) => entry.connectionId === request.connectionId && entry.modelId === request.modelId,
    );
    if (model === undefined) {
      throw new RouterError(
        'ROUTER_MODEL_UNAVAILABLE',
        'That model is not available on the chosen connection.',
      );
    }
    if (!model.available) {
      return {
        kind: 'rejected',
        reason: `${model.displayName} cannot be used right now: ${model.unavailableReason ?? 'it is unavailable'}.`,
      };
    }
    const mismatch = this.mismatchOf(model, required, request);
    if (mismatch !== null) {
      throw new RouterError('ROUTER_MODEL_NOT_COMPATIBLE', mismatch, {
        providerId: model.providerId,
        modelId: model.modelId,
      });
    }
    return { kind: 'ok', model };
  }

  /** Why a specific model cannot run this request, in plain words, or null. */
  private mismatchOf(
    model: CatalogModel | undefined,
    required: readonly AICapability[],
    request: RoutingRequest,
  ): string | null {
    if (model === undefined) return 'that model is not connected';
    const missing = required.filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      return `${model.displayName} does not declare ${missing.map(capabilityWords).join(' or ')}`;
    }
    if (request.needsStreaming === true && !model.streaming) {
      return `${model.displayName} does not declare streaming`;
    }
    const needed = (request.estimatedInputTokens ?? 0) + (request.expectedOutputTokens ?? 0);
    if (needed > 0) {
      if (model.contextWindowTokens === null) return null;
      if (needed > model.contextWindowTokens) {
        return `${model.displayName} can hold ${model.contextWindowTokens.toLocaleString('en-US')} tokens and this request needs about ${needed.toLocaleString('en-US')}`;
      }
    }
    return null;
  }

  private chooseBest(
    models: readonly CatalogModel[],
    required: readonly AICapability[],
    request: RoutingRequest,
    preferenceKind: PreferenceKind,
    projectId: string | undefined,
    preferences: RouterPreferences,
    warnings: string[],
    missingEvidence: string[],
    rejected: RejectedModel[],
  ): CatalogModel | null {
    const requirement = requirementFor(request.category);
    const survivors: { model: CatalogModel; score: number }[] = [];
    let sawUnknownWindow = false;
    let measuredLatency = false;

    for (const model of models) {
      if (!model.available) {
        rejected.push(this.reject(model, model.unavailableReason ?? 'it is unavailable'));
        continue;
      }
      const missing = required.filter((capability) => !model.capabilities.includes(capability));
      if (missing.length > 0) {
        rejected.push(
          this.reject(model, `does not declare ${missing.map(capabilityWords).join(' or ')}`),
        );
        continue;
      }
      if (request.needsStreaming === true && !model.streaming) {
        rejected.push(this.reject(model, 'does not declare streaming, which this request needs'));
        continue;
      }
      const needed = (request.estimatedInputTokens ?? 0) + (request.expectedOutputTokens ?? 0);
      if (needed > 0) {
        if (model.contextWindowTokens === null) {
          sawUnknownWindow = true;
          missingEvidence.push('context window for some models');
        } else if (needed > model.contextWindowTokens) {
          rejected.push(
            this.reject(
              model,
              `holds ${model.contextWindowTokens.toLocaleString('en-US')} tokens, less than the ${needed.toLocaleString('en-US')} this request needs`,
            ),
          );
          continue;
        }
      }

      let score = 0;
      // Preview, experimental and lab ids are advertised by providers but a
      // live account may refuse them (live QA: Gemini answered 400 "Developer
      // instruction is not enabled" for antigravity-preview-05-2026 while the
      // current flash model worked). Automatic routing should land on
      // something that actually serves requests; previews stay selectable by
      // name but stop winning on paper capability alone.
      if (UNSTABLE_MODEL_ID.test(model.modelId)) score -= 6;
      // A connection's default is either provider-declared or owner-chosen,
      // and both were verified against the live API, so it outranks a generic
      // capability tally. An explicit preference (faster, stronger reasoning,
      // lower cost) still decides for itself.
      if (model.connectionDefault && preferenceKind === 'balanced') score += 2.5;
      for (const capability of requirement.preferred) {
        if (model.capabilities.includes(capability)) score += 2;
      }
      if (model.capabilitySource === 'provider-reported') score += 1;
      if (preferenceKind === 'stronger-reasoning') {
        if (model.capabilities.includes('large-context')) score += 4;
        if (model.capabilities.includes('structured-output')) score += 1;
      }
      if (preferenceKind === 'faster') {
        const latency = this.observations.latencyFor(model.providerId, model.modelId);
        if (latency !== null) {
          measuredLatency = true;
          score += Math.max(0, 12 - latency / 500);
        }
      }
      if (preferenceKind === 'lower-cost') {
        // No reliable price is declared, so nothing is scored on cost.
        missingEvidence.push('model pricing');
      }
      if (preferenceKind === 'balanced') {
        if (model.streaming) score += 1;
        if (model.capabilitySource === 'provider-reported') score += 1;
      }
      // Stable ties: the owner's default connection, then the catalog order.
      if (
        preferences.defaultModel !== null &&
        preferences.defaultModel.connectionId === model.connectionId
      ) {
        score += 0.25;
      }
      if (projectId !== undefined) {
        const projectModel = preferences.projectPreferences[projectId]?.model;
        if (projectModel !== undefined && projectModel.modelId === model.modelId) score += 2;
      }
      survivors.push({ model, score });
    }

    if (sawUnknownWindow) {
      warnings.push(
        'Some models do not report a context window, so their length limit could not be checked.',
      );
    }
    if (preferenceKind === 'faster' && !measuredLatency) {
      missingEvidence.push('measured latency');
      warnings.push(
        'No response times have been measured yet in this session, so speed could not be ranked; the choice is not a claim about being fastest.',
      );
    }

    if (survivors.length === 0) return null;
    survivors.sort(
      (a, b) =>
        b.score - a.score ||
        a.model.providerName.localeCompare(b.model.providerName) ||
        a.model.displayName.localeCompare(b.model.displayName) ||
        a.model.modelId.localeCompare(b.model.modelId),
    );
    const winner = survivors[0];
    if (winner === undefined) return null;
    for (const loser of survivors.slice(1)) {
      rejected.push(
        this.reject(
          loser.model,
          `compatible, but ${winner.model.displayName} suited the request better`,
        ),
      );
    }
    return winner.model;
  }

  private whyChosen(
    model: CatalogModel,
    required: readonly AICapability[],
    preferenceKind: PreferenceKind,
    models: readonly CatalogModel[],
  ): string {
    const covered = required.map(capabilityWords).join(' and ');
    const preferenceSentence =
      preferenceKind === 'stronger-reasoning'
        ? 'it is the strongest reasoner among your connected models'
        : preferenceKind === 'faster'
          ? 'it has the best measured response time among your connected models'
          : preferenceKind === 'lower-cost'
            ? 'it meets the task, and no cost comparison was possible without reliable pricing'
            : 'it fits the task well';
    const streamed = model.streaming ? ' It also streams its answer.' : '';
    const usable = models.filter((entry) => entry.available).length;
    return `Using ${model.displayName} through ${model.providerName} because it declares ${covered} and ${preferenceSentence}.${streamed} ${usable} connected model(s) were considered.`;
  }

  private reject(model: CatalogModel, reason: string): RejectedModel {
    return {
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.modelId,
      displayName: model.displayName,
      reason,
    };
  }

  private selectedOf(model: CatalogModel): RoutingDecision['selected'] {
    return {
      connectionId: model.connectionId,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindowTokens: model.contextWindowTokens,
      streaming: model.streaming,
      capabilitySource: model.capabilitySource,
    };
  }

  // -------------------------------------------------------------------------
  // Explanations and outcomes
  // -------------------------------------------------------------------------

  private remember(decision: RoutingDecision): void {
    const limit = this.options.decisionHistory ?? DEFAULT_HISTORY;
    const list = this.decisions.get(decision.ownerRef) ?? [];
    this.decisions.set(decision.ownerRef, [decision, ...list].slice(0, limit));
  }

  /** Bounded, owner-scoped history for the "why this model" panel. */
  async recentDecisions(scope: RouteScope, limit = 10): Promise<readonly RoutingDecision[]> {
    const ownerRef = requireOwner(scope);
    return (this.decisions.get(ownerRef) ?? []).slice(0, Math.max(1, Math.min(limit, 40)));
  }

  async decision(scope: RouteScope, decisionId: string): Promise<RoutingDecision> {
    const ownerRef = requireOwner(scope);
    const found = (this.decisions.get(ownerRef) ?? []).find((entry) => entry.id === decisionId);
    if (found === undefined) {
      throw new RouterError(
        'ROUTER_DECISION_NOT_FOUND',
        'That routing decision does not exist or is no longer kept in memory.',
      );
    }
    return found;
  }

  /**
   * Records how a model behaved. Used for outage pausing and the speed
   * preference; nothing here is shared between owners or sent to a provider.
   */
  async recordOutcome(
    scope: RouteScope,
    outcome: {
      readonly providerId: string;
      readonly modelId: string;
      readonly status: 'success' | 'failure';
      readonly latencyMs?: number;
    },
  ): Promise<void> {
    const ownerRef = requireOwner(scope);
    // Only models this owner could actually use are recorded.
    const models = await this.buildCatalog(ownerRef);
    const known = models.some(
      (model) => model.providerId === outcome.providerId && model.modelId === outcome.modelId,
    );
    if (!known) return;
    this.observations.record({
      providerId: outcome.providerId,
      modelId: outcome.modelId,
      status: outcome.status,
      ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
      at: this.now().toISOString(),
    });
  }
}
