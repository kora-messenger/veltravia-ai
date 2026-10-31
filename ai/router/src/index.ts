/**
 * @veltravia/ai-router - multi-model intelligence (Step 28).
 *
 * One catalog, one decision point, one explanation. Every service that needs a
 * model asks the router which one and why; the Step 26 gateway still owns the
 * credential and the call, so no second selection system exists in the platform.
 */

export { ModelRouter, InMemoryObservationStore } from './router.js';
export type { ConnectionSource, ModelObservation, RouterDeps, RouterOptions } from './router.js';

export {
  applyPreferenceUpdate,
  defaultPreferences,
  InMemoryRouterPreferenceStore,
  MAX_PROJECT_PREFERENCES,
  MAX_TASK_PREFERENCES,
  resolveAutoSelect,
  resolvePreferenceKind,
  resolveStoredChoice,
  type ChoiceResolver,
  type PreferenceUpdate,
  type RouterPreferenceStore,
} from './preferences.js';

export {
  buildCatalog,
  catalogCapabilitySummary,
  describeCapabilities,
  type CatalogInput,
} from './catalog.js';

export { requirementFor, TASK_REQUIREMENT_LIST, TASK_REQUIREMENTS } from './tasks.js';
export type { TaskRequirement } from './tasks.js';

export {
  ROUTER_ERROR_CODES,
  RouterError,
  isRouterError,
  routerHttpStatus,
  type RouterErrorCode,
} from './errors.js';

export { isFallbackPolicy, isPreferenceKind, isRoutingMode, isTaskCategory } from './types.js';
export { FALLBACK_POLICIES, PREFERENCE_KINDS, ROUTING_MODES, TASK_CATEGORIES } from './types.js';
export type {
  CapabilitySource,
  CatalogModel,
  ConnectionFacts,
  ModelChoice,
  PreferenceKind,
  ProjectRoutingPreference,
  ProviderFacts,
  ProviderModelSeed,
  RejectedModel,
  RouteScope,
  RouterOutcome,
  RouterPreferences,
  RoutingDecision,
  RoutingMode,
  RoutingRequest,
  TaskCategory,
} from './types.js';
