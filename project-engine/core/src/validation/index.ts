/**
 * Input validation shared by the Project Engine managers.
 *
 * Rules: exact types, bounded sizes, secret-free metadata. Validation errors
 * join every issue into one message so tests can regex them.
 */

import {
  isProjectType,
  type ContextDecision,
  type CreateProjectInput,
  type ProjectConfigPatch,
  type ProjectContextPatch,
  type ProjectPatch,
} from '../types/index.js';
import { InvalidProjectRequestError } from '../errors/index.js';
import { assertNoSecrets, containsSecretShapedContent } from '../secrets/index.js';

const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ENTRY_LENGTH = 2000;
const MAX_CONTEXT_ENTRIES = 256;
const MAX_CONFIG_FIELD_LENGTH = 512;
const MAX_ENTRY_POINTS = 64;
const MAX_DECISIONS = 256;

function validateName(name: unknown, reasons: string[]): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    reasons.push('name must be a non-empty string');
  } else if (name.length > MAX_NAME_LENGTH) {
    reasons.push(`name must be at most ${MAX_NAME_LENGTH} characters`);
  } else if (name.trim() !== name) {
    reasons.push('name must not start or end with whitespace');
  }
}

function validateMetadata(
  metadata: Record<string, unknown> | undefined,
  reasons: string[],
): asserts metadata is Record<string, unknown> | undefined {
  if (metadata === undefined) return;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    reasons.push('metadata must be an object');
    return;
  }
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) {
    reasons.push(`metadata must have at most ${MAX_METADATA_KEYS} keys`);
  }
  const serialized = JSON.stringify(metadata);
  if (serialized.length > MAX_METADATA_BYTES) {
    reasons.push(`metadata must be at most ${MAX_METADATA_BYTES} bytes`);
  }
}

/** Validates a `CreateProjectInput` and returns a normalized copy. */
export function validateCreateProjectInput(input: CreateProjectInput): Required<
  Pick<CreateProjectInput, 'name' | 'description' | 'projectType' | 'ownerRef'>
> & {
  version: string;
  metadata: Record<string, unknown>;
} {
  const reasons: string[] = [];
  if (input === null || typeof input !== 'object') {
    throw new InvalidProjectRequestError(['input must be an object']);
  }
  validateName(input.name, reasons);
  if (typeof input.description !== 'string') {
    reasons.push('description must be a string');
  } else if (input.description.length > MAX_DESCRIPTION_LENGTH) {
    reasons.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (!isProjectType(input.projectType)) {
    reasons.push('projectType must be one of web, mobile, backend, fullstack, library, other');
  }
  if (
    typeof input.ownerRef !== 'string' ||
    input.ownerRef.length === 0 ||
    input.ownerRef.length > 256
  ) {
    reasons.push('ownerRef must be a non-empty string of at most 256 characters');
  }
  if (
    input.version !== undefined &&
    (typeof input.version !== 'string' || input.version.length > 64)
  ) {
    reasons.push('version must be a string of at most 64 characters');
  }
  validateMetadata(input.metadata, reasons);
  if (reasons.length > 0) {
    throw new InvalidProjectRequestError(reasons);
  }
  assertNoSecrets('project metadata', input.metadata ?? {});
  return {
    name: input.name,
    description: input.description,
    projectType: input.projectType,
    ownerRef: input.ownerRef,
    version: input.version ?? '0.1.0',
    metadata: input.metadata ?? {},
  };
}

/** Validates a project patch; at least one field must be present. */
export function validateProjectPatch(patch: ProjectPatch): ProjectPatch {
  const reasons: string[] = [];
  if (patch === null || typeof patch !== 'object') {
    throw new InvalidProjectRequestError(['patch must be an object']);
  }
  if (patch.name !== undefined) validateName(patch.name, reasons);
  if (patch.description !== undefined) {
    if (
      typeof patch.description !== 'string' ||
      patch.description.length > MAX_DESCRIPTION_LENGTH
    ) {
      reasons.push(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
    }
  }
  validateMetadata(patch.metadata, reasons);
  if (Object.keys(patch).length === 0) {
    reasons.push('patch must contain at least one field');
  }
  if (reasons.length > 0) {
    throw new InvalidProjectRequestError(reasons);
  }
  if (patch.metadata !== undefined) {
    assertNoSecrets('project metadata', patch.metadata);
  }
  return patch;
}

/** Validates a string-array context category and returns a frozen copy. */
function validateStringArray(
  value: readonly string[],
  category: string,
  reasons: string[],
): readonly string[] {
  if (!Array.isArray(value)) {
    reasons.push(`${category} must be an array of strings`);
    return [];
  }
  if (value.length > MAX_CONTEXT_ENTRIES) {
    reasons.push(`${category} must have at most ${MAX_CONTEXT_ENTRIES} entries`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      reasons.push(`${category} entries must be strings`);
      break;
    }
    if (entry.length > MAX_ENTRY_LENGTH) {
      reasons.push(`${category} entries must be at most ${MAX_ENTRY_LENGTH} characters`);
      break;
    }
  }
  return Object.freeze([...value]);
}

/** Validates decisions and returns a frozen copy. */
function validateDecisions(
  decisions: readonly ContextDecision[],
  reasons: string[],
): readonly ContextDecision[] {
  if (!Array.isArray(decisions)) {
    reasons.push('decisions must be an array');
    return [];
  }
  if (decisions.length > MAX_DECISIONS) {
    reasons.push(`decisions must have at most ${MAX_DECISIONS} entries`);
  }
  const out: ContextDecision[] = [];
  for (const decision of decisions) {
    if (
      decision === null ||
      typeof decision !== 'object' ||
      typeof decision.summary !== 'string' ||
      decision.summary.length === 0 ||
      decision.summary.length > MAX_ENTRY_LENGTH
    ) {
      reasons.push('decision summaries must be non-empty strings of at most 2000 characters');
      break;
    }
    if (
      decision.rationale !== undefined &&
      (typeof decision.rationale !== 'string' || decision.rationale.length > MAX_ENTRY_LENGTH)
    ) {
      reasons.push('decision rationale must be a string of at most 2000 characters');
      break;
    }
    if (
      decision.decidedAt !== undefined &&
      (typeof decision.decidedAt !== 'string' || decision.decidedAt.length > 64)
    ) {
      reasons.push('decision decidedAt must be a string of at most 64 characters');
      break;
    }
    out.push({
      summary: decision.summary,
      ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
      ...(decision.decidedAt !== undefined ? { decidedAt: decision.decidedAt } : {}),
    });
  }
  return Object.freeze(out);
}

/**
 * Validates a project-context patch. Context is PROJECT DATA: entries may say
 * anything (they are never instructions), but secret-shaped content is still
 * rejected - context is not a credential store.
 */
export function validateContextPatch(patch: ProjectContextPatch): ProjectContextPatch {
  const reasons: string[] = [];
  if (patch === null || typeof patch !== 'object') {
    throw new InvalidProjectRequestError(['context patch must be an object']);
  }
  const knownCategories = new Set<string>([
    'goals',
    'technologyPreferences',
    'architectureNotes',
    'buildPreferences',
    'userInstructions',
    'decisions',
  ]);
  const unknownCategories = Object.keys(patch).filter((key) => !knownCategories.has(key));
  if (unknownCategories.length > 0) {
    reasons.push(`unknown context category: ${unknownCategories.join(', ')}`);
  }
  const normalized: {
    goals?: readonly string[];
    technologyPreferences?: readonly string[];
    architectureNotes?: readonly string[];
    buildPreferences?: readonly string[];
    userInstructions?: readonly string[];
    decisions?: readonly ContextDecision[];
  } = {};

  for (const category of [
    'goals',
    'technologyPreferences',
    'architectureNotes',
    'buildPreferences',
    'userInstructions',
  ] as const) {
    const value = patch[category];
    if (value !== undefined) {
      normalized[category] = validateStringArray(value, category, reasons);
    }
  }
  if (patch.decisions !== undefined) {
    normalized.decisions = validateDecisions(patch.decisions, reasons);
  }
  if (Object.keys(normalized).length === 0) {
    reasons.push('context patch must contain at least one category');
  }
  if (reasons.length > 0) {
    throw new InvalidProjectRequestError(reasons);
  }

  // Secret-shaped content is rejected even inside project data.
  const secretReasons: string[] = [];
  for (const [category, value] of Object.entries(normalized)) {
    if (!Array.isArray(value)) continue;
    value.forEach((entry: unknown, index: number) => {
      if (typeof entry === 'string' && containsSecretShapedContent(entry)) {
        secretReasons.push(`${category}[${index}] has secret-shaped content`);
      }
    });
  }
  if (secretReasons.length > 0) {
    throw new InvalidProjectRequestError(secretReasons);
  }
  return normalized;
}

/** Validates a project-config patch. Commands are metadata ONLY - never executed. */
export function validateConfigPatch(patch: ProjectConfigPatch): ProjectConfigPatch {
  const reasons: string[] = [];
  if (patch === null || typeof patch !== 'object') {
    throw new InvalidProjectRequestError(['config patch must be an object']);
  }
  const stringFields = [
    'framework',
    'language',
    'runtime',
    'packageManager',
    'buildCommand',
    'testCommand',
    'lintCommand',
  ] as const;
  const knownFields = new Set<string>([...stringFields, 'entryPoints']);
  const unknownFields = Object.keys(patch).filter((key) => !knownFields.has(key));
  if (unknownFields.length > 0) {
    reasons.push(`unknown configuration field: ${unknownFields.join(', ')}`);
  }
  const normalized: Record<string, unknown> = {};
  for (const field of stringFields) {
    const value = patch[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONFIG_FIELD_LENGTH) {
      reasons.push(
        `${field} must be a non-empty string of at most ${MAX_CONFIG_FIELD_LENGTH} characters`,
      );
    } else {
      normalized[field] = value;
    }
  }
  if (patch.entryPoints !== undefined) {
    if (!Array.isArray(patch.entryPoints) || patch.entryPoints.length > MAX_ENTRY_POINTS) {
      reasons.push(`entryPoints must be an array of at most ${MAX_ENTRY_POINTS} strings`);
    } else {
      for (const entry of patch.entryPoints) {
        if (
          typeof entry !== 'string' ||
          entry.length === 0 ||
          entry.length > MAX_CONFIG_FIELD_LENGTH
        ) {
          reasons.push('entryPoints entries must be non-empty strings of at most 512 characters');
          break;
        }
      }
      normalized.entryPoints = patch.entryPoints;
    }
  }
  if (Object.keys(normalized).length === 0) {
    reasons.push('config patch must contain at least one field');
  }
  if (reasons.length > 0) {
    throw new InvalidProjectRequestError(reasons);
  }

  // Config must be strictly secret-free.
  const flat: Record<string, unknown> = { ...normalized };
  assertNoSecrets('project configuration', flat);
  return normalized as ProjectConfigPatch;
}
