/**
 * Assignment validation.
 *
 * An assignment that is thin is refused rather than filled in. A worker that
 * was never told what it must not touch, what it must return, or when to stop
 * is a worker that will do something the Primary Agent did not ask for, so the
 * only safe default is rejection.
 */

import { WORKER_TYPES, WORKER_LIMITS } from './types.js';
import type {
  Deliverable,
  ResourceClaim,
  WorkerAssignment,
  WorkerLimits,
  WorkerPermissions,
  WorkerType,
} from './types.js';
import { WorkerError } from './errors.js';

export interface AssignmentContext {
  /** Tool names this deployment may hand to a worker. */
  readonly allowedTools: readonly string[];
  /** Project paths that exist, when the caller knows them. Unused: scope is declared, not discovered. */
  readonly projectPaths?: readonly string[];
  /** Refuses text that looks like a credential. */
  readonly looksLikeSecret?: (text: string) => boolean;
}

const MAX_PATH = 512;

function fail(detail: string): never {
  throw new WorkerError('WORKER_ASSIGNMENT_INVALID', detail, { detail });
}

function text(
  value: unknown,
  field: string,
  max: number,
  context: AssignmentContext,
  required = true,
): string {
  if (typeof value !== 'string') fail(`${field} must be a string.`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) fail(`${field} cannot be empty.`);
  if (trimmed.length > max) fail(`${field} is longer than ${max} characters.`);
  if (context.looksLikeSecret?.(trimmed) === true) {
    throw new WorkerError('WORKER_SECRET_REJECTED', `${field} looks like a credential.`);
  }
  return trimmed;
}

/** A path a worker may name: relative, no traversal, no absolute root. */
export function assertSafePath(path: string, field: string): string {
  if (typeof path !== 'string') fail(`${field} must be a string.`);
  const trimmed = path.trim();
  if (trimmed.length === 0) fail(`${field} cannot be empty.`);
  if (trimmed.length > MAX_PATH) fail(`${field} is longer than ${MAX_PATH} characters.`);
  if (trimmed.includes('\0') || trimmed.includes('\\')) fail(`${field} is not a valid path.`);
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    fail(`${field} must be relative to the project.`);
  }
  // A leading './', a trailing slash and a '.' segment are noise, not traversal.
  const segments = trimmed.split('/').filter((segment) => segment !== '.');
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0) fail(`${field} must name a path inside the project.`);
  if (segments.some((segment) => segment === '..' || segment === '')) {
    fail(`${field} must not climb out of the project.`);
  }
  return segments.join('/');
}

function textList(
  value: unknown,
  field: string,
  max: number,
  context: AssignmentContext,
  options: { readonly required: boolean; readonly maxChars?: number } = { required: true },
): string[] {
  if (value === undefined || value === null) {
    if (options.required) fail(`${field} is required.`);
    return [];
  }
  if (!Array.isArray(value)) fail(`${field} must be a list.`);
  if (value.length > max) fail(`${field} has more than ${max} entries.`);
  const out = value.map((entry, index) =>
    text(entry, `${field}[${index}]`, options.maxChars ?? 300, context, true),
  );
  return [...new Set(out)];
}

function permissions(value: unknown): WorkerPermissions {
  if (value === undefined || value === null || typeof value !== 'object') {
    fail('permissions is required.');
  }
  const input = value as Record<string, unknown>;
  const read = (key: string): boolean => {
    const raw = input[key];
    if (raw === undefined) return false;
    if (typeof raw !== 'boolean') fail(`permissions.${key} must be true or false.`);
    return raw;
  };
  return {
    readProject: read('readProject'),
    writeProject: read('writeProject'),
    runTools: read('runTools'),
    network: read('network'),
  };
}

function limits(value: unknown): WorkerLimits {
  if (value === undefined || value === null || typeof value !== 'object') {
    fail('limits is required.');
  }
  const input = value as Record<string, unknown>;
  const number = (key: string, min: number, max: number): number => {
    const raw = input[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(`limits.${key} must be a number.`);
    const rounded = Math.floor(raw);
    if (rounded < min || rounded > max) fail(`limits.${key} must be between ${min} and ${max}.`);
    return rounded;
  };
  return {
    maxDurationMs: number(
      'maxDurationMs',
      WORKER_LIMITS.minDurationMs,
      WORKER_LIMITS.maxDurationMs,
    ),
    maxToolCalls: number('maxToolCalls', 1, WORKER_LIMITS.maxToolCalls),
    maxDeliverables: number('maxDeliverables', 1, WORKER_LIMITS.maxDeliverables),
  };
}

function deliverables(
  value: unknown,
  context: AssignmentContext,
  maxAllowed: number,
): Deliverable[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('deliverables must name at least one thing to return.');
  }
  if (value.length > maxAllowed) fail(`deliverables must not exceed the limit of ${maxAllowed}.`);
  return value.map((entry, index) => {
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      fail(`deliverables[${index}] must be an object.`);
    }
    const input = entry as Record<string, unknown>;
    const kind = input.kind;
    if (
      typeof kind !== 'string' ||
      !['file', 'patch', 'report', 'artifact', 'notes'].includes(kind)
    ) {
      fail(`deliverables[${index}].kind is not a deliverable kind.`);
    }
    const name = text(input.name, `deliverables[${index}].name`, 120, context);
    const summary = text(input.summary, `deliverables[${index}].summary`, 300, context);
    const path =
      input.path === undefined || input.path === null
        ? null
        : assertSafePath(String(input.path), `deliverables[${index}].path`);
    if ((kind === 'file' || kind === 'patch') && path === null) {
      fail(`deliverables[${index}] is a ${kind} and must name a path.`);
    }
    return { name, kind: kind as Deliverable['kind'], path, summary };
  });
}

export function workerTypeOf(value: unknown): WorkerType {
  if (typeof value === 'string' && (WORKER_TYPES as readonly string[]).includes(value)) {
    return value as WorkerType;
  }
  fail('workerType is not a known specialisation.');
}

/**
 * Validates an assignment and returns the stored form.
 *
 * Everything required by the Step 43 contract is required here: objective,
 * scope, exclusions, deliverables, acceptance criteria, tools, permissions,
 * limits, dependencies, checkpoints, cancellation conditions and reporting.
 */
export function validateAssignment(value: unknown, context: AssignmentContext): WorkerAssignment {
  if (value === undefined || value === null || typeof value !== 'object') {
    fail('An assignment object is required.');
  }
  const input = value as Record<string, unknown>;

  const objective = text(
    input.objective,
    'objective',
    WORKER_LIMITS.maxAssignmentTextLength,
    context,
  );
  if (!Array.isArray(input.scope) || input.scope.length === 0) {
    fail('scope must name at least one project path.');
  }
  const scope = (input.scope as unknown[]).map((entry, index) =>
    assertSafePath(String(entry), `scope[${index}]`),
  );
  if (scope.length > WORKER_LIMITS.maxScopePaths) {
    fail(`scope must not exceed ${WORKER_LIMITS.maxScopePaths} paths.`);
  }

  const perms = permissions(input.permissions);
  const exclusions = textList(
    input.exclusions,
    'exclusions',
    WORKER_LIMITS.maxScopePaths,
    context,
    {
      required: false,
    },
  ).map((entry) => assertSafePath(entry, 'exclusions'));
  if (perms.writeProject && exclusions.length === 0) {
    fail('a worker that may write must be told what it must not touch.');
  }

  const tools = textList(
    input.allowedTools,
    'allowedTools',
    WORKER_LIMITS.maxAllowedTools,
    context,
    {
      required: false,
      maxChars: 120,
    },
  );
  const unknownTools = tools.filter((tool) => !context.allowedTools.includes(tool));
  if (unknownTools.length > 0) {
    fail(`allowedTools names tools this deployment does not offer: ${unknownTools.join(', ')}.`);
  }
  if (perms.runTools && tools.length === 0) {
    fail('a worker allowed to run tools must be given the list it may run.');
  }
  if (perms.network && !tools.includes('network.fetch')) {
    fail('network access must come through the network.fetch tool, so name it.');
  }

  const acceptance = textList(
    input.acceptanceCriteria,
    'acceptanceCriteria',
    WORKER_LIMITS.maxAcceptanceCriteria,
    context,
  );
  if (acceptance.length === 0) fail('acceptanceCriteria must say how the work will be judged.');

  const limitsValue = limits(input.limits);
  const deliverableList = deliverables(input.deliverables, context, limitsValue.maxDeliverables);

  const dependencies = textList(input.dependencies, 'dependencies', 20, context, {
    required: false,
    maxChars: 128,
  });
  const checkpoints = textList(input.checkpoints, 'checkpoints', 10, context, { required: false });
  if (perms.writeProject && checkpoints.length === 0) {
    fail('a worker that may write must be told which checkpoints it must reach.');
  }
  const cancellation = textList(
    input.cancellationConditions,
    'cancellationConditions',
    10,
    context,
  );
  if (cancellation.length === 0) fail('cancellationConditions must say when to stop.');
  const reporting = textList(input.reporting, 'reporting', 10, context);
  if (reporting.length === 0) fail('reporting must say what the worker reports back.');

  const primaryRunId =
    input.primaryRunId === undefined || input.primaryRunId === null
      ? null
      : text(input.primaryRunId, 'primaryRunId', 128, context);

  const assignment: WorkerAssignment = {
    objective,
    scope,
    exclusions,
    deliverables: deliverableList,
    acceptanceCriteria: acceptance,
    allowedTools: tools,
    permissions: perms,
    limits: limitsValue,
    dependencies,
    checkpoints,
    cancellationConditions: cancellation,
    reporting,
    primaryRunId,
  };
  return assignment;
}

/** The claims a worker holds while it runs: what nobody else may write. */
export function claimsFor(assignment: WorkerAssignment): ResourceClaim[] {
  const claims: ResourceClaim[] = [];
  const looksLikeFile = (path: string): boolean => /\/[^/]+\.[A-Za-z0-9]+$/.test(path);
  for (const path of assignment.scope) {
    claims.push({ kind: looksLikeFile(path) ? 'file' : 'directory', path });
  }
  for (const deliverable of assignment.deliverables) {
    if (deliverable.path === null) continue;
    if (!claims.some((claim) => claim.path === deliverable.path)) {
      claims.push({ kind: 'file', path: deliverable.path });
    }
  }
  return claims;
}
