import { RouterError } from './errors.js';
import {
  isPreferenceKind,
  type ModelChoice,
  type PreferenceKind,
  type ProjectRoutingPreference,
  type RouterPreferences,
  type TaskCategory,
} from './types.js';

/**
 * Router preferences.
 *
 * The store is a port so the router does not care where preferences live. This
 * build ships an in-memory implementation alongside the rest of the platform's
 * development stores: preferences survive for the life of the process and are
 * lost on restart. That limitation is stated in the docs and in the API response
 * rather than presented as durable storage.
 */

export interface RouterPreferenceStore {
  get(ownerRef: string): Promise<RouterPreferences | undefined>;
  put(preferences: RouterPreferences): Promise<RouterPreferences>;
  delete?(ownerRef: string): Promise<void>;
}

export class InMemoryRouterPreferenceStore implements RouterPreferenceStore {
  private readonly byOwner = new Map<string, RouterPreferences>();

  async get(ownerRef: string): Promise<RouterPreferences | undefined> {
    return this.byOwner.get(ownerRef);
  }

  async put(preferences: RouterPreferences): Promise<RouterPreferences> {
    this.byOwner.set(preferences.ownerRef, preferences);
    return preferences;
  }

  async delete(ownerRef: string): Promise<void> {
    this.byOwner.delete(ownerRef);
  }
}

/** How many projects and task overrides one owner may configure. */
export const MAX_PROJECT_PREFERENCES = 200;
export const MAX_TASK_PREFERENCES = 16;

export function defaultPreferences(ownerRef: string, now: Date): RouterPreferences {
  return {
    ownerRef,
    autoSelect: true,
    preference: 'balanced',
    defaultModel: null,
    allowFallback: false,
    taskPreferences: {},
    projectPreferences: {},
    updatedAt: now.toISOString(),
  };
}

/** Input accepted from the API. Every field is optional: absent means "leave it". */
export interface PreferenceUpdate {
  readonly autoSelect?: boolean;
  readonly preference?: PreferenceKind;
  /** `null` clears the default model. */
  readonly defaultModel?: { readonly connectionId: string; readonly modelId: string } | null;
  readonly allowFallback?: boolean;
  readonly taskPreferences?: Readonly<
    Record<string, { readonly connectionId: string; readonly modelId: string } | null>
  >;
  readonly projectPreferences?: Readonly<
    Record<
      string,
      {
        readonly connectionId?: string | null;
        readonly modelId?: string | null;
        readonly autoSelect?: boolean;
        readonly preference?: PreferenceKind;
        readonly taskPreferences?: Readonly<
          Record<string, { readonly connectionId: string; readonly modelId: string } | null>
        >;
      } | null
    >
  >;
}

/**
 * Turns a caller's choice into a validated one.
 *
 * `resolve` is supplied by the router and checks that the connection belongs to
 * this owner and that the model is actually on it. A preference that cannot be
 * honoured is refused now, with a readable reason, instead of being stored and
 * quietly ignored later.
 */
export type ChoiceResolver = (
  ownerRef: string,
  connectionId: string,
  modelId: string,
) => Promise<ModelChoice>;

function requireChoice(
  resolve: ChoiceResolver,
  ownerRef: string,
  input: { readonly connectionId: string; readonly modelId: string },
  what: string,
): Promise<ModelChoice> {
  if (typeof input.connectionId !== 'string' || input.connectionId.length === 0) {
    throw new RouterError('ROUTER_INVALID_REQUEST', `Choose a provider for ${what}.`);
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    throw new RouterError('ROUTER_INVALID_REQUEST', `Choose a model for ${what}.`);
  }
  return resolve(ownerRef, input.connectionId, input.modelId);
}

/**
 * Applies an update on top of the stored preferences and returns the new value.
 * Pure apart from the resolver call, so it can be tested without a store.
 */
export async function applyPreferenceUpdate(
  current: RouterPreferences,
  update: PreferenceUpdate,
  resolve: ChoiceResolver,
): Promise<RouterPreferences> {
  const ownerRef = current.ownerRef;

  if (update.preference !== undefined && !isPreferenceKind(update.preference)) {
    throw new RouterError('ROUTER_INVALID_REQUEST', 'That preference is not one of the options.');
  }

  let defaultModel = current.defaultModel;
  if (update.defaultModel === null) {
    defaultModel = null;
  } else if (update.defaultModel !== undefined) {
    defaultModel = await requireChoice(resolve, ownerRef, update.defaultModel, 'the default model');
  }

  const taskPreferences: Record<string, ModelChoice> = { ...current.taskPreferences };
  for (const [category, choice] of Object.entries(update.taskPreferences ?? {})) {
    if (choice === null) {
      delete taskPreferences[category];
      continue;
    }
    taskPreferences[category] = await requireChoice(
      resolve,
      ownerRef,
      choice,
      `the ${category.replace(/-/g, ' ')} default`,
    );
  }
  if (Object.keys(taskPreferences).length > MAX_TASK_PREFERENCES) {
    throw new RouterError('ROUTER_LIMIT_EXCEEDED', 'Too many task preferences are configured.');
  }

  const projectPreferences: Record<string, ProjectRoutingPreference> = Object.fromEntries(
    Object.entries(current.projectPreferences).filter(
      (entry): entry is [string, ProjectRoutingPreference] => entry[1] !== undefined,
    ),
  );
  for (const [projectId, incoming] of Object.entries(update.projectPreferences ?? {})) {
    const key = projectId.trim();
    if (key.length === 0) continue;
    if (incoming === null) {
      delete projectPreferences[key];
      continue;
    }
    if (incoming.preference !== undefined && !isPreferenceKind(incoming.preference)) {
      throw new RouterError('ROUTER_INVALID_REQUEST', 'That project preference is not valid.');
    }
    const previous = projectPreferences[key];
    let model = previous?.model;
    if (incoming.connectionId === null || incoming.modelId === null) {
      model = undefined;
    } else if (incoming.connectionId !== undefined && incoming.modelId !== undefined) {
      model = await requireChoice(
        resolve,
        ownerRef,
        { connectionId: incoming.connectionId, modelId: incoming.modelId },
        'this project',
      );
    }

    const projectTasks: Record<string, ModelChoice> = { ...(previous?.taskPreferences ?? {}) };
    for (const [category, choice] of Object.entries(incoming.taskPreferences ?? {})) {
      if (choice === null) {
        delete projectTasks[category];
        continue;
      }
      projectTasks[category] = await requireChoice(
        resolve,
        ownerRef,
        choice,
        `the ${category.replace(/-/g, ' ')} task in this project`,
      );
    }

    const autoSelect = incoming.autoSelect ?? previous?.autoSelect;
    const preference = incoming.preference ?? previous?.preference;
    const next: ProjectRoutingPreference = {
      ...(model !== undefined ? { model } : {}),
      ...(autoSelect !== undefined ? { autoSelect } : {}),
      ...(preference !== undefined ? { preference } : {}),
      ...(Object.keys(projectTasks).length > 0 ? { taskPreferences: projectTasks } : {}),
    };
    projectPreferences[key] = next;
  }
  if (Object.keys(projectPreferences).length > MAX_PROJECT_PREFERENCES) {
    throw new RouterError('ROUTER_LIMIT_EXCEEDED', 'Too many project preferences are configured.');
  }

  return {
    ownerRef,
    autoSelect: update.autoSelect ?? current.autoSelect,
    preference: update.preference ?? current.preference,
    defaultModel,
    allowFallback: update.allowFallback ?? current.allowFallback,
    taskPreferences,
    projectPreferences,
    updatedAt: new Date().toISOString(),
  };
}

/** Which stored choice applies to a task inside a project, most specific first. */
export function resolveStoredChoice(
  preferences: RouterPreferences,
  category: TaskCategory,
  projectId: string | undefined,
): {
  readonly choice: ModelChoice | null;
  readonly decidedBy: 'task-preference' | 'project-preference' | 'user-default';
} {
  const project = projectId !== undefined ? preferences.projectPreferences[projectId] : undefined;

  if (project?.taskPreferences?.[category] !== undefined) {
    return {
      choice: project.taskPreferences[category] as ModelChoice,
      decidedBy: 'task-preference',
    };
  }
  if (preferences.taskPreferences[category] !== undefined) {
    return {
      choice: preferences.taskPreferences[category] as ModelChoice,
      decidedBy: 'task-preference',
    };
  }
  if (project?.model !== undefined) {
    return { choice: project.model, decidedBy: 'project-preference' };
  }
  if (preferences.defaultModel !== null) {
    return { choice: preferences.defaultModel, decidedBy: 'user-default' };
  }
  return { choice: null, decidedBy: 'user-default' };
}

/** The preference kind in force: project override, else the owner's setting. */
export function resolvePreferenceKind(
  preferences: RouterPreferences,
  projectId: string | undefined,
): PreferenceKind {
  const project = projectId !== undefined ? preferences.projectPreferences[projectId] : undefined;
  return project?.preference ?? preferences.preference;
}

/** Whether automatic selection applies: project override, else the owner's setting. */
export function resolveAutoSelect(
  preferences: RouterPreferences,
  projectId: string | undefined,
): boolean {
  const project = projectId !== undefined ? preferences.projectPreferences[projectId] : undefined;
  return project?.autoSelect ?? preferences.autoSelect;
}
