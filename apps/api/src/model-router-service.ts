import {
  PROVIDER_CATALOG,
  type AIProviderGateway,
  type ProviderDefinition,
} from '@veltravia/ai-gateway';
import {
  InMemoryObservationStore,
  InMemoryRouterPreferenceStore,
  ModelRouter,
  type ConnectionFacts,
  type ProviderFacts,
  type RoutingDecision,
  type TaskCategory,
} from '@veltravia/ai-router';
import type { AICapability } from '@veltravia/ai-core';

/**
 * The API process's model router (Step 28).
 *
 * It reads the owner's connections from the SAME gateway that will make the
 * call, so the catalog can never describe a provider the caller cannot use, and
 * a decision can never name another owner's connection. Preferences and
 * observations are in-process, like the rest of this build: they reset on
 * restart and are documented as such.
 *
 * Nothing here calls a provider. The router selects; the gateway executes.
 */

export interface ModelRouterService {
  readonly router: ModelRouter;
  /**
   * Chooses a route for one task, or returns the refusal.
   *
   * `category` describes the work, so the same router decides for reasoning,
   * the agent layer, coding, documents and cross-source intelligence.
   */
  routeFor(
    ownerRef: string,
    input: {
      readonly category: TaskCategory;
      readonly projectId?: string;
      readonly connectionId?: string;
      readonly modelId?: string;
      readonly mode?: 'automatic' | 'manual' | 'project';
      readonly needsStreaming?: boolean;
      readonly estimatedInputTokens?: number;
      readonly purpose?: string;
    },
  ): Promise<RoutingDecision>;
  /** Records how an executed route behaved, for outage pausing and speed data. */
  recordOutcome(
    ownerRef: string,
    outcome: {
      readonly providerId: string;
      readonly modelId: string;
      readonly status: 'success' | 'failure';
      readonly latencyMs?: number;
    },
  ): Promise<void>;
}

export interface ModelRouterServiceOptions {
  /** Null when credential encryption is not configured: no owner has providers. */
  readonly gateway: AIProviderGateway | null;
  readonly now?: () => Date;
}

/** Provider declarations the router may rely on, taken from the Step 26 catalog. */
export function providerFactsFromCatalog(
  catalog: readonly ProviderDefinition[] = PROVIDER_CATALOG,
): readonly ProviderFacts[] {
  return catalog.map((provider) => ({
    providerId: provider.id,
    displayName: provider.displayName,
    modelCapabilities: provider.modelCapabilities as readonly AICapability[],
    reportsModels: provider.modelsPath !== undefined,
    ...(provider.knownModels !== undefined
      ? {
          models: provider.knownModels.map((model) => ({
            modelId: model.modelId,
            ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
            ...(model.contextWindowTokens !== undefined
              ? { contextWindowTokens: model.contextWindowTokens }
              : {}),
            ...(model.capabilities !== undefined
              ? { capabilities: model.capabilities as readonly AICapability[] }
              : {}),
          })),
        }
      : {}),
  }));
}

/**
 * Connection facts as the router sees them.
 *
 * Only the fields the router needs cross over: no credential reference, no
 * fingerprint, no base URL, nothing to replay.
 */
export async function connectionFactsFor(
  gateway: AIProviderGateway | null,
  ownerRef: string,
): Promise<readonly ConnectionFacts[]> {
  if (gateway === null) return [];
  const entries = await gateway.listConnections({ ownerRef });
  return entries.map((entry) => ({
    id: entry.connection.id,
    providerId: entry.connection.providerId,
    displayName: entry.connection.displayName,
    status: entry.connection.status,
    modelIds: entry.connection.modelIds,
    ...(entry.connection.defaultModelId ? { defaultModelId: entry.connection.defaultModelId } : {}),
    ...(entry.connection.lastValidatedAt
      ? { lastValidatedAt: entry.connection.lastValidatedAt }
      : {}),
  }));
}

export function createModelRouterService(options: ModelRouterServiceOptions): ModelRouterService {
  const gateway = options.gateway;
  const now = options.now ?? (() => new Date());
  const router = new ModelRouter({
    options: {
      connections: {
        list: (ownerRef) => connectionFactsFor(gateway, ownerRef),
      },
      providers: providerFactsFromCatalog(),
      preferences: new InMemoryRouterPreferenceStore(),
      now,
    },
    observations: new InMemoryObservationStore(),
  });

  return {
    router,
    async routeFor(ownerRef, input) {
      return router.route(
        { ownerRef, ...(input.projectId !== undefined ? { projectId: input.projectId } : {}) },
        {
          category: input.category,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.needsStreaming !== undefined ? { needsStreaming: input.needsStreaming } : {}),
          ...(input.estimatedInputTokens !== undefined
            ? { estimatedInputTokens: input.estimatedInputTokens }
            : {}),
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        },
      );
    },
    async recordOutcome(ownerRef, outcome) {
      await router.recordOutcome({ ownerRef }, outcome);
    },
  };
}

/** Categories the platform's own services ask for, in one place. */
export const SERVICE_CATEGORIES = {
  reasoning: 'complex-reasoning',
  agent: 'general-conversation',
  coding: 'coding',
  documents: 'document-analysis',
  intelligence: 'cross-source-intelligence',
} as const satisfies Readonly<Record<string, TaskCategory>>;
