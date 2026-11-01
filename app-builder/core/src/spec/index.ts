/**
 * Project specification validation (Step 30).
 *
 * Two separate questions, deliberately never merged:
 *
 * 1. Is this specification well formed? (structure, types, paths, secrets)
 * 2. Can the platform actually serve the stack it names? (support levels)
 *
 * A well-formed specification for a `planned` technology is VALID and still not
 * buildable. Collapsing the two would let the platform claim a Python build it
 * cannot run, so `SpecificationReview` reports both and the orchestrator refuses
 * at the point where it would have to lie.
 */

import { AppBuilderError } from '../errors/index.js';
import type { LanguageFrameworkRegistry } from '../registry/index.js';
import {
  isProjectKind,
  PROJECT_KINDS,
  SUPPORT_LEVELS,
  type ProjectKind,
  type ProjectSpecification,
  type ResolvedTechnology,
  type SpecificationReview,
  type StackDetection,
  type SupportLevel,
  type ValidationIssue,
} from '../types/index.js';

const MAX_SPEC_BYTES = 32_000;
const MAX_TEXT = 4_000;
const MAX_NAME = 120;
const MAX_LIST = 64;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _.'()-]{0,119}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._\-/]{0,199}$/;

const AUTH_STRATEGIES = ['none', 'email-password', 'oauth', 'sso', 'api-key', 'passkeys'];
const INTEGRATION_PROTOCOLS = ['rest', 'graphql', 'grpc', 'websocket', 'webhook', 'sdk', 'unknown'];
const INTEGRATION_ACCESS = ['read', 'write', 'both'];
const DEPLOYMENT_TARGETS = [
  'static-hosting',
  'container',
  'serverless',
  'vm',
  'app-store',
  'managed-database',
  'evm-chain',
  'none',
];

/** Secret-shaped values, rejected so a key never becomes part of a project spec. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^ghp_[A-Za-z0-9]{20,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}/i;

const SUPPORT_ORDER: Record<SupportLevel, number> = { executable: 3, scaffold: 2, planned: 1 };

function lowestSupport(levels: readonly SupportLevel[]): SupportLevel {
  if (levels.length === 0) return 'planned';
  return levels.reduce((lowest, level) =>
    SUPPORT_ORDER[level] < SUPPORT_ORDER[lowest] ? level : lowest,
  );
}

function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value)) || SECRET_ASSIGNMENT.test(value);
}

export interface SpecValidationOptions {
  /** Rejects `planned` stacks instead of merely reporting them. */
  readonly requireScaffold?: boolean;
}

/**
 * Validates one specification. Never throws for bad input: the review is the
 * answer, and `valid` reflects only structural problems.
 */
export function validateProjectSpecification(
  raw: unknown,
  registry: LanguageFrameworkRegistry,
  options: SpecValidationOptions = {},
): SpecificationReview {
  const issues: ValidationIssue[] = [];
  const notes: string[] = [];
  const resolved: ResolvedTechnology[] = [];
  const unsupported: { id: string; reason: string }[] = [];

  const addIssue = (
    path: string,
    code: string,
    message: string,
    severity: ValidationIssue['severity'] = 'error',
  ): void => {
    issues.push({ path, code, message, severity });
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    addIssue('specification', 'not-an-object', 'A project specification must be an object.');
    return {
      valid: false,
      issues,
      resolved,
      supportLevel: 'planned',
      unsupported,
      notes,
    };
  }

  const spec = raw as Record<string, unknown>;
  const serialised = JSON.stringify(spec);
  if (serialised.length > MAX_SPEC_BYTES) {
    addIssue(
      'specification',
      'too-large',
      'The specification is larger than this surface accepts.',
    );
    return { valid: false, issues, resolved, supportLevel: 'planned', unsupported, notes };
  }

  // -- unknown fields -------------------------------------------------------
  const allowed = new Set([
    'name',
    'description',
    'projectKind',
    'frontend',
    'backend',
    'mobile',
    'additionalLanguages',
    'database',
    'authentication',
    'apis',
    'dependencies',
    'build',
    'runtime',
    'environment',
    'deployment',
    'constraints',
    'version',
  ]);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) {
      addIssue(key, 'unknown-field', `"${key}" is not part of a project specification.`);
    }
  }

  // -- name / description ---------------------------------------------------
  const name = spec['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    addIssue('name', 'required', 'A project needs a name.');
  } else if (name.length > MAX_NAME || !NAME_PATTERN.test(name)) {
    addIssue(
      'name',
      'invalid-name',
      'Use letters, digits, spaces and simple punctuation (max 120 characters).',
    );
  }

  const description = spec['description'];
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > MAX_TEXT) {
      addIssue('description', 'invalid', 'A description must be text under 4000 characters.');
    } else if (looksLikeSecret(description)) {
      addIssue(
        'description',
        'secret-shaped',
        'The description looks like it contains a credential.',
      );
    }
  }

  // -- project kind ---------------------------------------------------------
  const kind = spec['projectKind'];
  if (!isProjectKind(kind)) {
    addIssue('projectKind', 'required', `Choose a project kind: ${PROJECT_KINDS.join(', ')}.`);
  }

  // -- stack roles ----------------------------------------------------------
  const roleFor = (
    role: 'frontend' | 'backend' | 'mobile',
    field: 'frontend' | 'backend' | 'mobile',
    allowedLayers: readonly string[],
  ): void => {
    const value = spec[field];
    if (value === undefined) return;
    if (typeof value !== 'string') {
      addIssue(field, 'invalid', `"${field}" must be a technology id from the registry.`);
      return;
    }
    const entry = registry.find(value);
    if (entry === undefined) {
      addIssue(
        field,
        'unknown-technology',
        `"${value}" is not in the technology registry, so it cannot be planned.`,
      );
      return;
    }
    if (!allowedLayers.includes(entry.layer)) {
      addIssue(
        field,
        'wrong-layer',
        `"${value}" is a ${entry.layer} technology and cannot fill the ${role} role.`,
      );
      return;
    }
    resolved.push({ id: entry.id, name: entry.name, role, supportLevel: entry.supportLevel });
    if (entry.supportLevel === 'planned') {
      unsupported.push({
        id: entry.id,
        reason: `${entry.name} is documented but has no scaffold or execution support in this release.`,
      });
    }
  };

  roleFor('frontend', 'frontend', ['frontend']);
  roleFor('backend', 'backend', ['backend', 'data']);
  roleFor('mobile', 'mobile', ['mobile']);

  const additional = spec['additionalLanguages'];
  if (additional !== undefined) {
    if (!Array.isArray(additional) || additional.length > 16) {
      addIssue(
        'additionalLanguages',
        'invalid',
        'Extra languages must be a short list of technology ids.',
      );
    } else {
      for (const [index, value] of additional.entries()) {
        if (typeof value !== 'string') {
          addIssue(
            `additionalLanguages.${index}`,
            'invalid',
            'Each extra language must be a technology id.',
          );
          continue;
        }
        const entry = registry.find(value);
        if (entry === undefined) {
          addIssue(
            `additionalLanguages.${index}`,
            'unknown-technology',
            `"${value}" is not in the technology registry.`,
          );
          continue;
        }
        if (entry.kind !== 'language') {
          addIssue(
            `additionalLanguages.${index}`,
            'wrong-kind',
            `"${value}" is a framework; list languages here.`,
          );
          continue;
        }
        resolved.push({
          id: entry.id,
          name: entry.name,
          role: 'language',
          supportLevel: entry.supportLevel,
        });
        if (entry.supportLevel === 'planned') {
          unsupported.push({
            id: entry.id,
            reason: `${entry.name} is documented but has no scaffold or execution support in this release.`,
          });
        }
      }
    }
  }

  // -- kind vs stack coherence ---------------------------------------------
  const kindValue = isProjectKind(kind) ? (kind as ProjectKind) : undefined;
  const hasFrontend = typeof spec['frontend'] === 'string';
  const hasBackend = typeof spec['backend'] === 'string';
  const hasMobile = typeof spec['mobile'] === 'string';

  if (kindValue !== undefined) {
    const requires: Record<ProjectKind, readonly ('frontend' | 'backend' | 'mobile')[]> = {
      web: ['frontend'],
      mobile: ['mobile'],
      backend: ['backend'],
      fullstack: ['frontend', 'backend'],
      library: [],
      cli: [],
      data: [],
      'smart-contract': [],
      other: [],
    };
    for (const role of requires[kindValue]) {
      const present =
        role === 'frontend' ? hasFrontend : role === 'backend' ? hasBackend : hasMobile;
      if (!present) {
        addIssue(role, 'required-for-kind', `A ${kindValue} project needs a ${role} technology.`);
      }
    }
    if (kindValue !== 'mobile' && kindValue !== 'fullstack' && hasMobile) {
      addIssue(
        'mobile',
        'unexpected',
        'A mobile framework only applies to a mobile project.',
        'warning',
      );
    }
    if (kindValue === 'mobile' && hasFrontend && !hasMobile) {
      addIssue(
        'frontend',
        'unexpected',
        'A mobile project needs a mobile framework, not a web frontend.',
      );
    }
  }

  // -- database -------------------------------------------------------------
  const database = spec['database'];
  if (database !== undefined) {
    if (typeof database !== 'object' || database === null || Array.isArray(database)) {
      addIssue('database', 'invalid', 'A database requirement must be an object.');
    } else {
      const db = database as Record<string, unknown>;
      for (const key of Object.keys(db)) {
        if (!['engine', 'tooling', 'migrations'].includes(key)) {
          addIssue(`database.${key}`, 'unknown-field', `"${key}" is not a database field.`);
        }
      }
      if (typeof db['engine'] !== 'string' || db['engine'].length === 0) {
        addIssue(
          'database.engine',
          'required',
          'Name the database engine, for example "postgres".',
        );
      }
      if (db['migrations'] !== undefined && typeof db['migrations'] !== 'boolean') {
        addIssue('database.migrations', 'invalid', 'Migrations is a yes/no field.');
      }
    }
  }

  // -- authentication -------------------------------------------------------
  const authentication = spec['authentication'];
  if (authentication !== undefined) {
    if (
      typeof authentication !== 'object' ||
      authentication === null ||
      Array.isArray(authentication)
    ) {
      addIssue('authentication', 'invalid', 'Authentication must be an object.');
    } else {
      const auth = authentication as Record<string, unknown>;
      for (const key of Object.keys(auth)) {
        if (!['strategy', 'providers', 'notes'].includes(key)) {
          addIssue(
            `authentication.${key}`,
            'unknown-field',
            `"${key}" is not an authentication field.`,
          );
        }
      }
      if (typeof auth['strategy'] !== 'string' || !AUTH_STRATEGIES.includes(auth['strategy'])) {
        addIssue(
          'authentication.strategy',
          'invalid',
          `Choose one of: ${AUTH_STRATEGIES.join(', ')}.`,
        );
      }
    }
  }

  // -- apis ----------------------------------------------------------------
  const apis = spec['apis'];
  if (apis !== undefined) {
    if (!Array.isArray(apis) || apis.length > MAX_LIST) {
      addIssue('apis', 'invalid', 'APIs must be a short list.');
    } else {
      for (const [index, item] of apis.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          addIssue(`apis.${index}`, 'invalid', 'Each integration must be an object.');
          continue;
        }
        const integration = item as Record<string, unknown>;
        for (const key of Object.keys(integration)) {
          if (!['name', 'protocol', 'access'].includes(key)) {
            addIssue(
              `apis.${index}.${key}`,
              'unknown-field',
              `"${key}" is not an integration field.`,
            );
          }
        }
        if (typeof integration['name'] !== 'string' || integration['name'].trim().length === 0) {
          addIssue(`apis.${index}.name`, 'required', 'Each integration needs a name.');
        }
        if (
          typeof integration['protocol'] !== 'string' ||
          !INTEGRATION_PROTOCOLS.includes(integration['protocol'])
        ) {
          addIssue(
            `apis.${index}.protocol`,
            'invalid',
            `Protocol must be one of: ${INTEGRATION_PROTOCOLS.join(', ')}.`,
          );
        }
        if (
          typeof integration['access'] !== 'string' ||
          !INTEGRATION_ACCESS.includes(integration['access'])
        ) {
          addIssue(
            `apis.${index}.access`,
            'invalid',
            `Access must be one of: ${INTEGRATION_ACCESS.join(', ')}.`,
          );
        }
      }
    }
  }

  // -- dependencies --------------------------------------------------------
  const dependencies = spec['dependencies'];
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies) || dependencies.length > MAX_LIST) {
      addIssue('dependencies', 'invalid', 'Dependencies must be a short list of names.');
    } else {
      for (const [index, item] of dependencies.entries()) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 160) {
          addIssue(`dependencies.${index}`, 'invalid', 'Each dependency must be a short name.');
        } else if (looksLikeSecret(item)) {
          addIssue(
            `dependencies.${index}`,
            'secret-shaped',
            'A dependency name looks like a credential.',
          );
        }
      }
    }
  }

  // -- build --------------------------------------------------------------
  const build = spec['build'];
  if (build !== undefined) {
    if (typeof build !== 'object' || build === null || Array.isArray(build)) {
      addIssue('build', 'invalid', 'Build configuration must be an object.');
    } else {
      const b = build as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (!['outputDirectory', 'buildCommand', 'environmentVariables', 'notes'].includes(key)) {
          addIssue(`build.${key}`, 'unknown-field', `"${key}" is not a build field.`);
        }
      }
      const out = b['outputDirectory'];
      if (out !== undefined) {
        if (typeof out !== 'string' || !SAFE_RELATIVE_PATH.test(out) || out.includes('..')) {
          addIssue(
            'build.outputDirectory',
            'unsafe-path',
            'Use a relative output path inside the project.',
          );
        }
      }
      if (b['buildCommand'] !== undefined) {
        addIssue(
          'build.buildCommand',
          'not-accepted',
          'Build commands come from the technology registry, never from a specification.',
        );
      }
    }
  }

  // -- runtime ------------------------------------------------------------
  const runtimeConfig = spec['runtime'];
  if (runtimeConfig !== undefined) {
    if (
      typeof runtimeConfig !== 'object' ||
      runtimeConfig === null ||
      Array.isArray(runtimeConfig)
    ) {
      addIssue('runtime', 'invalid', 'Runtime configuration must be an object.');
    } else {
      const r = runtimeConfig as Record<string, unknown>;
      for (const key of Object.keys(r)) {
        if (!['runtimeIds', 'startCommand', 'ports', 'notes'].includes(key)) {
          addIssue(`runtime.${key}`, 'unknown-field', `"${key}" is not a runtime field.`);
        }
      }
      const ports = r['ports'];
      if (ports !== undefined) {
        if (!Array.isArray(ports) || ports.length > 8) {
          addIssue('runtime.ports', 'invalid', 'Ports must be a short list.');
        } else {
          for (const [index, port] of ports.entries()) {
            if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
              addIssue(
                `runtime.ports.${index}`,
                'invalid',
                'A port must be an integer between 1 and 65535.',
              );
            }
          }
        }
      }
      if (r['startCommand'] !== undefined) {
        addIssue(
          'runtime.startCommand',
          'not-accepted',
          'Start commands come from the technology registry, never from a specification.',
        );
      }
    }
  }

  // -- environment --------------------------------------------------------
  const environment = spec['environment'];
  if (environment !== undefined) {
    if (!Array.isArray(environment) || environment.length > MAX_LIST) {
      addIssue(
        'environment',
        'invalid',
        'Environment requirements must be a short list of variable names.',
      );
    } else {
      for (const [index, item] of environment.entries()) {
        if (typeof item !== 'string' || !ENV_NAME_PATTERN.test(item)) {
          addIssue(
            `environment.${index}`,
            'invalid',
            'List variable NAMES only (for example DATABASE_URL); never their values.',
          );
        }
      }
    }
  }

  // -- deployment ---------------------------------------------------------
  const deployment = spec['deployment'];
  if (deployment !== undefined) {
    if (typeof deployment !== 'object' || deployment === null || Array.isArray(deployment)) {
      addIssue('deployment', 'invalid', 'Deployment requirements must be an object.');
    } else {
      const d = deployment as Record<string, unknown>;
      for (const key of Object.keys(d)) {
        if (!['target', 'notes'].includes(key)) {
          addIssue(`deployment.${key}`, 'unknown-field', `"${key}" is not a deployment field.`);
        }
      }
      if (typeof d['target'] !== 'string' || !DEPLOYMENT_TARGETS.includes(d['target'])) {
        addIssue(
          'deployment.target',
          'invalid',
          `Target must be one of: ${DEPLOYMENT_TARGETS.join(', ')}.`,
        );
      } else if (d['target'] === 'app-store' && kindValue !== undefined && kindValue !== 'mobile') {
        addIssue(
          'deployment.target',
          'inconsistent',
          'An app-store target only fits a mobile project.',
          'warning',
        );
      }
    }
  }

  // -- constraints --------------------------------------------------------
  const constraints = spec['constraints'];
  if (constraints !== undefined) {
    if (!Array.isArray(constraints) || constraints.length > MAX_LIST) {
      addIssue('constraints', 'invalid', 'Constraints must be a short list of statements.');
    } else {
      for (const [index, item] of constraints.entries()) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 400) {
          addIssue(`constraints.${index}`, 'invalid', 'Each constraint must be short text.');
        } else if (looksLikeSecret(item)) {
          addIssue(
            `constraints.${index}`,
            'secret-shaped',
            'A constraint looks like it contains a credential.',
          );
        }
      }
    }
  }

  // -- version ------------------------------------------------------------
  const version = spec['version'];
  if (
    version !== undefined &&
    (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
  ) {
    addIssue('version', 'invalid', 'A specification version is a positive integer.');
  }

  const supportLevel = lowestSupport(resolved.map((entry) => entry.supportLevel));
  const hasErrors = issues.some((issue) => issue.severity === 'error');

  if (supportLevel === 'planned' && resolved.length > 0) {
    notes.push(
      'At least one chosen technology is documented but not buildable yet, so this plan can describe it but not scaffold or run it.',
    );
  }
  if (options.requireScaffold === true && supportLevel === 'planned' && !hasErrors) {
    addIssue(
      'projectKind',
      'unsupported-technology',
      'This stack has no scaffold support in this release, so nothing would be generated.',
    );
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    resolved,
    supportLevel,
    unsupported,
    notes,
  };
}

/** Validates and throws the typed error a route can map to a status. */
export function assertValidSpecification(
  raw: unknown,
  registry: LanguageFrameworkRegistry,
  options: SpecValidationOptions = {},
): SpecificationReview {
  const review = validateProjectSpecification(raw, registry, options);
  if (!review.valid) {
    const first = review.issues.find((issue) => issue.severity === 'error');
    throw new AppBuilderError(
      'APP_BUILDER_INVALID_SPECIFICATION',
      first === undefined
        ? 'The project specification is not valid.'
        : `${first.path}: ${first.message}`,
      { issueCount: review.issues.length },
    );
  }
  return review;
}

export interface StackComparison {
  readonly consistent: boolean;
  /** Requested technologies the detected stack does not contain. */
  readonly missing: readonly string[];
  /** Detected technologies the specification does not mention. */
  readonly extra: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Compares what the user asked for with what the project actually contains.
 *
 * The builder never "fixes" this by swapping the stack: a conflict is reported
 * so a human decides whether the spec or the code is right.
 */
export function compareRequestedStack(
  spec: ProjectSpecification,
  detection: StackDetection,
  registry: LanguageFrameworkRegistry,
): StackComparison {
  const requested = [spec.frontend, spec.backend, spec.mobile]
    .filter((value): value is string => typeof value === 'string')
    .concat(spec.additionalLanguages ?? []);

  const detectedIds = new Set(detection.projects.map((project) => project.id));
  const detectedLanguages = new Set(detection.languages.map((language) => language.id));

  const missing: string[] = [];
  for (const id of requested) {
    const entry = registry.find(id);
    if (entry === undefined) continue;
    const present = entry.kind === 'framework' ? detectedIds.has(id) : detectedLanguages.has(id);
    if (!present) missing.push(id);
  }

  const requestedSet = new Set(requested);
  const extra: string[] = [];
  for (const detected of detection.projects) {
    if (requestedSet.has(detected.id)) continue;
    const entry = registry.find(detected.id);
    if (entry === undefined) continue;
    if (entry.kind === 'framework' && entry.layer === 'other') continue;
    extra.push(detected.id);
  }

  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(
      'The project does not currently contain every requested technology. Nothing was substituted: the specification stands and the difference is reported.',
    );
  }
  if (extra.length > 0) {
    notes.push('The project contains technologies the specification does not mention.');
  }

  return {
    consistent: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    notes,
  };
}

/** Support-level ordering, exported so callers do not re-implement it. */
export function compareSupportLevels(a: SupportLevel, b: SupportLevel): number {
  return SUPPORT_ORDER[a] - SUPPORT_ORDER[b];
}

export { SUPPORT_LEVELS };
