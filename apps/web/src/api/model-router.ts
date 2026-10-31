import { apiRequest } from './client';

const base = '/api/ai/router';

/**
 * Typed client for the Step 28 model router.
 *
 * The browser reads the catalog, the per-task support state, the preferences and
 * the explanation behind a decision. It cannot execute a model call, and no
 * response carries a credential or a provider endpoint.
 */

export interface RouterModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly capabilitySource: 'provider-reported' | 'catalog' | 'manual';
  readonly contextWindowTokens: number | null;
  readonly streaming: boolean;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly discoverySource: 'connection' | 'catalog' | 'discovery';
  readonly lastValidatedAt: string | null;
}

export interface TaskSupport {
  readonly category: string;
  readonly displayName: string;
  readonly description: string;
  readonly required: readonly string[];
  readonly supported: boolean;
  readonly modelCount: number;
  readonly reason: string | null;
}

export interface ModelChoice {
  readonly connectionId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export type PreferenceKind = 'balanced' | 'lower-cost' | 'faster' | 'stronger-reasoning';

export interface ProjectPreference {
  readonly model?: ModelChoice;
  readonly autoSelect?: boolean;
  readonly preference?: PreferenceKind;
}

export interface RouterPreferences {
  readonly ownerRef: string;
  readonly autoSelect: boolean;
  readonly preference: PreferenceKind;
  readonly defaultModel: ModelChoice | null;
  readonly allowFallback: boolean;
  readonly taskPreferences: Readonly<Record<string, ModelChoice>>;
  readonly projectPreferences: Readonly<Record<string, ProjectPreference>>;
  readonly updatedAt: string;
}

export interface RejectedModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly reason: string;
}

export interface RoutingDecision {
  readonly id: string;
  readonly category: string;
  readonly mode: 'automatic' | 'manual' | 'project';
  readonly outcome: 'routed' | 'unsupported' | 'needs-attention';
  readonly requestedAt: string;
  readonly selected: {
    readonly connectionId: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly modelId: string;
    readonly displayName: string;
    readonly contextWindowTokens: number | null;
    readonly streaming: boolean;
    readonly capabilitySource: string;
  } | null;
  readonly summary: string;
  readonly capabilitiesRequired: readonly string[];
  readonly preference: PreferenceKind;
  readonly decidedBy:
    'manual-request' | 'task-preference' | 'project-preference' | 'user-default' | 'automatic';
  readonly rejected: readonly RejectedModel[];
  readonly warnings: readonly string[];
  readonly fallback: {
    readonly policy: 'none' | 'compatible-alternate';
    readonly used: boolean;
    readonly replaced: string | null;
  };
  readonly costComparison: 'unavailable' | 'not-requested';
  readonly contextWindowTokens: number | null;
  readonly audit: {
    readonly candidateCount: number;
    readonly consideredCount: number;
    readonly rejectedCount: number;
    readonly missingEvidence: readonly string[];
    readonly durationMs: number;
  };
}

export interface RouterOverview {
  readonly categories: readonly TaskSupport[];
  readonly catalog: readonly RouterModel[];
  readonly catalogNotes: readonly string[];
  readonly capabilityCounts: Readonly<Record<string, number>>;
  readonly providerCount: number;
  readonly preferences: RouterPreferences;
  readonly persistence: string;
  readonly blockedReason?: string;
}

export const getOverview = () => apiRequest<RouterOverview>(base);

export const routeTask = (input: {
  category: string;
  projectId?: string;
  connectionId?: string;
  modelId?: string;
  mode?: 'automatic' | 'manual' | 'project';
  needsStreaming?: boolean;
}) =>
  apiRequest<{ decision: RoutingDecision }>(`${base}/route`, {
    method: 'POST',
    body: input,
  });

export const listDecisions = (limit = 5) =>
  apiRequest<{ decisions: readonly RoutingDecision[]; persistence: string }>(
    `${base}/decisions?limit=${limit}`,
  );

export const savePreferences = (input: {
  autoSelect?: boolean;
  preference?: PreferenceKind;
  defaultModel?: { connectionId: string; modelId: string } | null;
  allowFallback?: boolean;
  projectPreferences?: Record<
    string,
    { connectionId?: string | null; modelId?: string | null; preference?: PreferenceKind } | null
  >;
}) =>
  apiRequest<{
    preferences: RouterPreferences;
    persistence: string;
    appliedToExecution?: boolean;
    mirrorNote?: string;
  }>(`${base}/preferences`, { method: 'PUT', body: input });

/** Plain words for a capability, so the UI never shows a raw union member. */
export function capabilityWords(capability: string): string {
  const WORDS: Readonly<Record<string, string>> = {
    'text-generation': 'writes text',
    'structured-output': 'typed fields',
    streaming: 'streams',
    vision: 'reads images',
    'image-generation': 'creates images',
    'tool-calling': 'calls tools',
    embeddings: 'vectors',
    'audio-input': 'takes audio',
    'audio-output': 'speaks',
    'large-context': 'long context',
    'code-generation': 'writes code',
  };
  return WORDS[capability] ?? capability;
}

/** Plain words for how a decision was reached. */
export function decidedByWords(decidedBy: RoutingDecision['decidedBy']): string {
  switch (decidedBy) {
    case 'manual-request':
      return 'you picked it for this request';
    case 'task-preference':
      return 'you picked it for this kind of task';
    case 'project-preference':
      return 'this project has its own model';
    case 'user-default':
      return 'it is your default model';
    default:
      return 'it was the best fit among your connected models';
  }
}

export function preferenceWords(preference: PreferenceKind): string {
  switch (preference) {
    case 'lower-cost':
      return 'Lower cost';
    case 'faster':
      return 'Faster response';
    case 'stronger-reasoning':
      return 'Stronger reasoning';
    default:
      return 'Balanced';
  }
}
