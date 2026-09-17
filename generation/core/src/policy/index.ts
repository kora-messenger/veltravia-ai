/**
 * Generation policy: idea/specification/plan validation and limits
 * resolution. The policy is authoritative and trusted; user ideas, planner
 * output, project files, and tool output are DATA - they never carry
 * permissions, limits, tool ids, or credentials.
 *
 * Path SECURITY is not re-implemented here - the Project Engine (reached
 * through the Tool System) remains the single filesystem security authority.
 */

import { containsSecretShapedContent } from '@veltravia/project-core';

import { GenerationError } from '../errors/index.js';
import {
  APP_TYPES,
  GENERATION_LIMIT_CEILINGS,
  GENERATION_LIMIT_DEFAULTS,
  type AppSpecification,
  type AppType,
  type DependencyRequest,
  type GenerationCommand,
  type GenerationPlan,
  type GenerationRunLimits,
  type PlannedFile,
  type ProjectTemplate,
  type SpecEntity,
  type SpecScreen,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_TEXT = 4000;
const MAX_ITEMS = 50;
const MAX_PATH_LENGTH = 512;
const MAX_FILE_BYTES = 65_536;
const MAX_COMMANDS = 50;
const MAX_COMMAND_ARGS = 32;
const MAX_NAME_LENGTH = 120;
const MAX_VERSION_LENGTH = 64;

/** Executables a plan may EVER request. The sandbox re-validates at runtime. */
export const PLAN_ALLOWED_COMMANDS: readonly string[] = ['node', 'npm', 'npx', 'python', 'pip'];

const DEPENDENCY_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION_RANGE_PATTERN = /^[\^~><=*x0-9., >=-]{1,64}$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,119}$/;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function assertNoSecretShaped(value: string, field: string): void {
  if (containsSecretShapedContent(value)) {
    throw new GenerationError(
      'GENERATION_SECRET_REJECTED',
      `${field} contains secret-shaped content and was rejected`,
      { field },
    );
  }
}

function assertText(value: unknown, field: string, maxLength = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GenerationError('GENERATION_INVALID_REQUEST', `${field} must be a non-empty string`, {
      field,
    });
  }
  if (value.length > maxLength) {
    throw new GenerationError('GENERATION_INVALID_REQUEST', `${field} is too long`, { field });
  }
  assertNoSecretShaped(value, field);
  return value;
}

function assertPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GenerationError('GENERATION_INVALID_REQUEST', `${field} must be a non-empty path`, {
      field,
    });
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new GenerationError('GENERATION_INVALID_REQUEST', `${field} is too long`, { field });
  }
  if (value.startsWith('/') || value.includes('..') || value.includes('\\')) {
    throw new GenerationError(
      'GENERATION_INVALID_REQUEST',
      `${field} is not a safe relative path`,
      {
        field,
      },
    );
  }
  // eslint-disable-next-line no-control-regex -- control-character rejection is intentional
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new GenerationError(
      'GENERATION_INVALID_REQUEST',
      `${field} contains control characters`,
      {
        field,
      },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Resolves run limits. Only trusted server-side configuration can raise
 * them, and even then only up to the hard ceilings. Ideas, specs, and plans
 * carry no limits at all.
 */
export function resolveGenerationLimits(
  overrides?: Partial<GenerationRunLimits>,
): GenerationRunLimits {
  if (overrides !== undefined) {
    for (const key of Object.keys(GENERATION_LIMIT_DEFAULTS) as (keyof GenerationRunLimits)[]) {
      const value = overrides[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new GenerationError('GENERATION_INVALID_REQUEST', `invalid limit "${key}"`, {
          key,
        });
      }
    }
  }
  return {
    maxRepairAttempts: Math.min(
      overrides?.maxRepairAttempts ?? GENERATION_LIMIT_DEFAULTS.maxRepairAttempts,
      GENERATION_LIMIT_CEILINGS.maxRepairAttempts,
    ),
    maxFilesChanged: Math.min(
      overrides?.maxFilesChanged ?? GENERATION_LIMIT_DEFAULTS.maxFilesChanged,
      GENERATION_LIMIT_CEILINGS.maxFilesChanged,
    ),
    maxCommands: Math.min(
      overrides?.maxCommands ?? GENERATION_LIMIT_DEFAULTS.maxCommands,
      GENERATION_LIMIT_CEILINGS.maxCommands,
    ),
    maxDurationMs: Math.min(
      overrides?.maxDurationMs ?? GENERATION_LIMIT_DEFAULTS.maxDurationMs,
      GENERATION_LIMIT_CEILINGS.maxDurationMs,
    ),
  };
}

// ---------------------------------------------------------------------------
// Idea
// ---------------------------------------------------------------------------

/** Validates the raw user idea before any planning happens. */
export function validateIdea(idea: string): string {
  if (typeof idea !== 'string' || idea.length < 10) {
    throw new GenerationError(
      'GENERATION_INVALID_REQUEST',
      'the idea must be a string of at least 10 characters',
      { field: 'idea' },
    );
  }
  if (idea.length > MAX_TEXT) {
    throw new GenerationError('GENERATION_INVALID_REQUEST', 'the idea is too long', {
      field: 'idea',
    });
  }
  assertNoSecretShaped(idea, 'idea');
  return idea;
}

// ---------------------------------------------------------------------------
// App specification
// ---------------------------------------------------------------------------

function assertSpecList(
  value: readonly unknown[] | undefined,
  field: string,
  validateItem: (item: unknown, field: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new GenerationError(
      'GENERATION_INVALID_SPEC',
      `${field} must be an array of at most 50`,
      {
        field,
      },
    );
  }
  for (const item of value) validateItem(item, field);
}

function validateScreen(item: unknown, field: string): void {
  if (item === null || typeof item !== 'object') {
    throw new GenerationError('GENERATION_INVALID_SPEC', `${field} entries must be objects`, {
      field,
    });
  }
  const screen = item as Partial<SpecScreen>;
  assertText(screen.name, `${field}.name`, 120);
  if (screen.description !== undefined) {
    assertText(screen.description, `${field}.description`, 500);
  }
}

function validateEntity(item: unknown, field: string): void {
  if (item === null || typeof item !== 'object') {
    throw new GenerationError('GENERATION_INVALID_SPEC', `${field} entries must be objects`, {
      field,
    });
  }
  const entity = item as Partial<SpecEntity>;
  assertText(entity.name, `${field}.name`, 120);
  if (!Array.isArray(entity.fields) || entity.fields.length > MAX_ITEMS) {
    throw new GenerationError(
      'GENERATION_INVALID_SPEC',
      `${field}.fields must be an array of at most 50`,
      { field },
    );
  }
  for (const fieldEntry of entity.fields) {
    const entry = fieldEntry as { name?: unknown; type?: unknown };
    assertText(entry.name, `${field}.fields.name`, 120);
    assertText(entry.type, `${field}.fields.type`, 64);
  }
}

/**
 * Validates an application specification with strict schemas. The SAME
 * validation applies to mock output, AI output, and any future source -
 * raw model output is never trusted.
 */
export function validateAppSpecification(spec: AppSpecification): AppSpecification {
  if (spec === null || typeof spec !== 'object') {
    throw new GenerationError('GENERATION_INVALID_SPEC', 'specification must be an object');
  }
  const name = assertText(spec.name, 'spec.name', MAX_NAME_LENGTH);
  if (!SAFE_NAME_PATTERN.test(name)) {
    throw new GenerationError(
      'GENERATION_INVALID_SPEC',
      'spec.name may only contain letters, digits, spaces, dots, underscores and dashes',
      { field: 'spec.name' },
    );
  }
  assertText(spec.description, 'spec.description', MAX_TEXT);
  if (!APP_TYPES.includes(spec.appType)) {
    throw new GenerationError(
      'GENERATION_UNSUPPORTED_APP_TYPE',
      `unsupported application type "${String(spec.appType)}"`,
      { supported: APP_TYPES },
    );
  }
  const platforms = ['web', 'server', 'web+server'] as const;
  if (!platforms.includes(spec.targetPlatform)) {
    throw new GenerationError('GENERATION_INVALID_SPEC', 'spec.targetPlatform is invalid', {
      field: 'spec.targetPlatform',
    });
  }
  if (spec.frontendTechnology !== undefined) {
    assertText(spec.frontendTechnology, 'spec.frontendTechnology', 200);
  }
  if (spec.backendTechnology !== undefined) {
    assertText(spec.backendTechnology, 'spec.backendTechnology', 200);
  }
  if (spec.databaseRequirement !== undefined) {
    assertText(spec.databaseRequirement, 'spec.databaseRequirement', 200);
  }
  if (spec.authenticationRequirement !== undefined) {
    assertText(spec.authenticationRequirement, 'spec.authenticationRequirement', 200);
  }
  assertSpecList(spec.features, 'spec.features', (item, field) => {
    assertText(item as string, field, 500);
  });
  assertSpecList(spec.screens, 'spec.screens', validateScreen);
  assertSpecList(spec.entities, 'spec.entities', validateEntity);
  assertSpecList(spec.integrations, 'spec.integrations', (item, field) => {
    assertText(item as string, field, 200);
  });
  if (spec.styling !== undefined) assertText(spec.styling, 'spec.styling', 500);
  if (spec.deploymentTarget !== undefined) {
    assertText(spec.deploymentTarget, 'spec.deploymentTarget', 200);
  }
  assertSpecList(spec.constraints, 'spec.constraints', (item, field) => {
    assertText(item as string, field, 500);
  });
  assertText(spec.version, 'spec.version', MAX_VERSION_LENGTH);
  assertText(spec.generatedAt, 'spec.generatedAt', 64);
  return spec;
}

// ---------------------------------------------------------------------------
// Dependency + command validation
// ---------------------------------------------------------------------------

export function validateDependencyRequest(dep: DependencyRequest): DependencyRequest {
  if (dep === null || typeof dep !== 'object') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'dependency requests must be objects');
  }
  if (typeof dep.name !== 'string' || !DEPENDENCY_NAME_PATTERN.test(dep.name)) {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'invalid dependency name', {
      field: 'dependencies.name',
    });
  }
  if (typeof dep.versionRange !== 'string' || !VERSION_RANGE_PATTERN.test(dep.versionRange)) {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'invalid dependency version range', {
      field: 'dependencies.versionRange',
    });
  }
  assertText(dep.reason, 'dependencies.reason', 500);
  if (dep.source !== 'npm') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'unsupported dependency source', {
      field: 'dependencies.source',
    });
  }
  return dep;
}

export function validateGenerationCommand(command: GenerationCommand): GenerationCommand {
  if (command === null || typeof command !== 'object') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'commands must be objects');
  }
  if (typeof command.command !== 'string' || !PLAN_ALLOWED_COMMANDS.includes(command.command)) {
    throw new GenerationError(
      'GENERATION_INVALID_PLAN',
      `command "${String(command.command)}" is not allowed in plans`,
      { allowed: PLAN_ALLOWED_COMMANDS },
    );
  }
  if (!Array.isArray(command.arguments) || command.arguments.length > MAX_COMMAND_ARGS) {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'command arguments are invalid', {
      field: 'commands.arguments',
    });
  }
  for (const argument of command.arguments) {
    if (typeof argument !== 'string' || argument.length > 4096) {
      throw new GenerationError('GENERATION_INVALID_PLAN', 'command argument is invalid', {
        field: 'commands.arguments',
      });
    }
    // No shell - ever. Metacharacters make a structured command ambiguous.
    if (/[;&|`$><]/.test(argument)) {
      throw new GenerationError(
        'GENERATION_INVALID_PLAN',
        'command arguments must not contain shell metacharacters',
        { field: 'commands.arguments' },
      );
    }
    assertNoSecretShaped(argument, 'commands.arguments');
  }
  assertText(command.purpose, 'commands.purpose', 500);
  if (command.phase !== 'test') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'unsupported command phase', {
      field: 'commands.phase',
    });
  }
  return command;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function assertFileList(
  files: readonly unknown[] | undefined,
  field: string,
  maxBytes: number,
): void {
  if (files === undefined) return;
  if (!Array.isArray(files)) {
    throw new GenerationError('GENERATION_INVALID_PLAN', `${field} must be an array`, { field });
  }
  const seen = new Set<string>();
  for (const entry of files) {
    const file = entry as Partial<PlannedFile>;
    const path = assertPath(file.path, `${field}.path`);
    if (seen.has(path)) {
      throw new GenerationError('GENERATION_INVALID_PLAN', `duplicate file path "${path}"`, {
        field,
      });
    }
    seen.add(path);
    if (typeof file.content !== 'string') {
      throw new GenerationError('GENERATION_INVALID_PLAN', `${field}.content must be a string`, {
        field,
      });
    }
    if (file.content.length > maxBytes) {
      throw new GenerationError('GENERATION_INVALID_PLAN', `${field}.content is too large`, {
        field,
      });
    }
    assertNoSecretShaped(file.content, `${field}.content`);
  }
}

/**
 * Validates a generation plan. The plan is DATA: unknown fields do not
 * exist as validation surface, no raw shell, no tool-id injection, no
 * secret-shaped content, no duplicate paths, and the template must exist
 * and actually support the specification's application type.
 */
export function validateGenerationPlan(
  plan: GenerationPlan,
  spec: AppSpecification,
  template: ProjectTemplate,
  limits: GenerationRunLimits,
): GenerationPlan {
  if (plan === null || typeof plan !== 'object') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'plan must be an object');
  }
  assertText(plan.version, 'plan.version', MAX_VERSION_LENGTH);
  if (plan.project === null || typeof plan.project !== 'object') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'plan.project must be an object');
  }
  assertText(plan.project.name, 'plan.project.name', MAX_NAME_LENGTH);
  assertText(plan.project.description, 'plan.project.description', MAX_TEXT);
  assertText(plan.project.projectType, 'plan.project.projectType', 64);
  if (plan.templateId !== template.id) {
    throw new GenerationError(
      'GENERATION_INVALID_PLAN',
      'plan.templateId does not match the selected template',
      {
        field: 'plan.templateId',
      },
    );
  }
  if (!Array.isArray(plan.filesToCreate) || plan.filesToCreate.length === 0) {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'a plan must create at least one file', {
      field: 'plan.filesToCreate',
    });
  }
  assertFileList(plan.filesToCreate, 'plan.filesToCreate', MAX_FILE_BYTES);
  assertFileList(plan.filesToModify, 'plan.filesToModify', MAX_FILE_BYTES);
  const totalFiles = plan.filesToCreate.length + plan.filesToModify.length;
  if (totalFiles > limits.maxFilesChanged) {
    throw new GenerationError('GENERATION_FILE_LIMIT', 'plan exceeds the file-change limit', {
      limit: limits.maxFilesChanged,
      requested: totalFiles,
    });
  }
  if (!Array.isArray(plan.dependencies) || plan.dependencies.length > MAX_ITEMS) {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'plan.dependencies is invalid', {
      field: 'plan.dependencies',
    });
  }
  for (const dependency of plan.dependencies) {
    validateDependencyRequest(dependency);
  }
  if (!Array.isArray(plan.commands) || plan.commands.length > MAX_COMMANDS) {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'plan.commands is invalid', {
      field: 'plan.commands',
    });
  }
  if (plan.commands.length > limits.maxCommands) {
    throw new GenerationError('GENERATION_COMMAND_LIMIT', 'plan exceeds the command limit', {
      limit: limits.maxCommands,
      requested: plan.commands.length,
    });
  }
  for (const command of plan.commands) {
    validateGenerationCommand(command);
  }
  if (plan.risk === null || typeof plan.risk !== 'object') {
    throw new GenerationError('GENERATION_INVALID_PLAN', 'plan.risk must be an object');
  }
  assertSpecList(plan.risk.destructiveActions, 'plan.risk.destructiveActions', (item, field) => {
    assertText(item as string, field, 500);
  });
  assertSpecList(
    plan.risk.confirmationRequiringTools,
    'plan.risk.confirmationRequiringTools',
    (item, field) => {
      assertText(item as string, field, 200);
    },
  );
  assertSpecList(
    plan.risk.externalIntegrations,
    'plan.risk.externalIntegrations',
    (item, field) => {
      assertText(item as string, field, 200);
    },
  );
  // The template must actually serve this application type.
  if (!template.supportedAppTypes.includes(spec.appType)) {
    throw new GenerationError(
      'GENERATION_UNSUPPORTED_TEMPLATE',
      'the template does not support this application type',
      {
        templateId: template.id,
        appType: spec.appType,
      },
    );
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Repair proposals
// ---------------------------------------------------------------------------

const MAX_REPAIR_FILES = 50;

/**
 * Validates a repair proposal before it is applied. Repair output is DATA:
 * bounded file count, safe relative paths, no duplicates, size-bounded
 * content, and no secret-shaped material. The Tool System re-enforces all
 * of this at write time - this is the earlier, cheaper rejection.
 */
export function validateRepairProposal(files: readonly PlannedFile[]): readonly PlannedFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new GenerationError(
      'GENERATION_INVALID_REQUEST',
      'a repair must write at least one file',
    );
  }
  if (files.length > MAX_REPAIR_FILES) {
    throw new GenerationError(
      'GENERATION_INVALID_REQUEST',
      'repair proposal writes too many files',
      {
        limit: MAX_REPAIR_FILES,
      },
    );
  }
  const seen = new Set<string>();
  for (const file of files) {
    const path = assertPath(file.path, 'repair.path');
    if (seen.has(path)) {
      throw new GenerationError('GENERATION_INVALID_REQUEST', `duplicate repair path "${path}"`);
    }
    seen.add(path);
    if (typeof file.content !== 'string' || file.content.length === 0) {
      throw new GenerationError(
        'GENERATION_INVALID_REQUEST',
        'repair content must be a non-empty string',
      );
    }
    if (file.content.length > MAX_FILE_BYTES) {
      throw new GenerationError('GENERATION_INVALID_REQUEST', 'repair content is too large');
    }
    assertNoSecretShaped(file.content, 'repair content');
  }
  return files;
}

/** Selects the template for a spec from a registry; unsupported types fail. */
export function selectTemplate(
  spec: AppSpecification,
  templates: readonly ProjectTemplate[],
): ProjectTemplate {
  const candidates = templates.filter((template) =>
    template.supportedAppTypes.includes(spec.appType),
  );
  if (candidates.length === 0) {
    throw new GenerationError(
      'GENERATION_UNSUPPORTED_TEMPLATE',
      'no template supports this application type',
      {
        appType: spec.appType,
      },
    );
  }
  return candidates[0] as ProjectTemplate;
}

/** Which app types a set of templates covers (for honest catalog reporting). */
export function supportedAppTypes(templates: readonly ProjectTemplate[]): readonly AppType[] {
  return APP_TYPES.filter((appType) =>
    templates.some((template) => template.supportedAppTypes.includes(appType)),
  );
}
