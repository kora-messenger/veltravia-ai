/**
 * Validation policy for the Testing & Debugging Agent. EVERYTHING that enters
 * the system passes through here first: run requests, detected plans,
 * structural commands, diagnostic classifications, diagnoses, repair plans,
 * and limit overrides. Secret-shaped material fails closed; commands must be
 * structural (bare executable + typed arguments, never raw shell strings).
 */

import { isSecretKeyName, isSecretShaped, TestingError } from '../errors/index.js';
import {
  FAILURE_CATEGORIES,
  REPAIR_CHANGE_MODES,
  REPAIR_RISK_LEVELS,
  REPAIR_SCOPES,
  SUPPORTED_PROJECT_TYPES,
  TEST_COMMAND_PURPOSES,
  TEST_RUN_LIMIT_CEILINGS,
  TEST_RUN_LIMIT_DEFAULTS,
  type ConfidenceLevel,
  type Diagnosis,
  type DiagnosisStatement,
  type FailureCategory,
  type RepairPlan,
  type TestCommand,
  type TestPlan,
  type TestRunLimits,
} from '../types/index.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT = 4000;

/** Executable names: bare, no paths, no spaces, no shell metacharacters. */
const EXECUTABLE_PATTERN = /^[a-z][a-z0-9@/._-]{0,63}$/;
const SHELL_METACHARACTERS = /[;&|`$><\\\n"'{}[\]!]/;
const LABEL_PATTERN = /^[\w ,.:/@()'"#-]{1,120}$/;

function assertBoundedText(value: unknown, field: string, maxLength = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TestingError('TESTING_INVALID_REQUEST', `"${field}" must be a non-empty string`);
  }
  if (value.includes('\u0000')) {
    throw new TestingError('TESTING_INVALID_REQUEST', `"${field}" contains control characters`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Run requests
// ---------------------------------------------------------------------------

export interface TestRunRequest {
  readonly runId?: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export function validateTestRunRequest(input: {
  readonly runId?: unknown;
  readonly projectId: unknown;
  readonly workspaceId: unknown;
}): TestRunRequest {
  const projectId = assertBoundedText(input.projectId, 'projectId', 128);
  const workspaceId = assertBoundedText(input.workspaceId, 'workspaceId', 128);
  if (!ID_PATTERN.test(projectId) || !ID_PATTERN.test(workspaceId)) {
    throw new TestingError(
      'TESTING_INVALID_REQUEST',
      'projectId and workspaceId must be valid ids',
    );
  }
  let runId: string | undefined;
  if (input.runId !== undefined && input.runId !== null) {
    runId = assertBoundedText(input.runId, 'runId', 128);
    if (!ID_PATTERN.test(runId)) {
      throw new TestingError('TESTING_INVALID_REQUEST', 'runId must be a valid id');
    }
  }
  return { ...(runId !== undefined ? { runId } : {}), projectId, workspaceId };
}

// ---------------------------------------------------------------------------
// Commands + plans
// ---------------------------------------------------------------------------

export function validateTestCommand(input: TestCommand): TestCommand {
  if (!EXECUTABLE_PATTERN.test(input.executable)) {
    throw new TestingError(
      'TESTING_INVALID_REQUEST',
      `executable "${input.executable}" is not a bare allowlisted-style name`,
    );
  }
  if (!Array.isArray(input.arguments) || input.arguments.length > 32) {
    throw new TestingError('TESTING_INVALID_REQUEST', 'command arguments must be a bounded array');
  }
  for (const argument of input.arguments) {
    if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\u0000')) {
      throw new TestingError('TESTING_INVALID_REQUEST', 'arguments must be plain strings');
    }
    if (
      SHELL_METACHARACTERS.test(argument) &&
      argument !== '--version' &&
      !argument.startsWith('--')
    ) {
      // Only flag obvious shell-shaped payloads; the sandbox has no shell,
      // so this is defense-in-depth, not the primary gate.
      if (/[;&|`$><\\\n]/.test(argument)) {
        throw new TestingError(
          'TESTING_INVALID_REQUEST',
          `argument to "${input.executable}" looks shell-shaped`,
        );
      }
    }
  }
  if (!TEST_COMMAND_PURPOSES.includes(input.purpose)) {
    throw new TestingError('TESTING_INVALID_REQUEST', `unknown command purpose "${input.purpose}"`);
  }
  if (!LABEL_PATTERN.test(input.label)) {
    throw new TestingError('TESTING_INVALID_REQUEST', `invalid command label "${input.label}"`);
  }
  if (input.scriptName !== undefined && !/^[\w.-]{1,64}$/.test(input.scriptName)) {
    throw new TestingError('TESTING_INVALID_REQUEST', 'scriptName must be a script name');
  }
  if (isSecretShaped(input.executable) || input.arguments.some((a) => isSecretShaped(a))) {
    throw new TestingError('TESTING_SECRET_REJECTED', 'secret-shaped command material rejected');
  }
  return input;
}

export function validateTestPlan(plan: TestPlan): TestPlan {
  if (!SUPPORTED_PROJECT_TYPES.includes(plan.projectType)) {
    throw new TestingError(
      'TESTING_INVALID_REQUEST',
      `unsupported project type "${String(plan.projectType)}"`,
    );
  }
  if (plan.projectType === 'unknown') {
    throw new TestingError(
      'TESTING_UNSUPPORTED_PROJECT',
      'the project type could not be determined from the workspace',
    );
  }
  if (plan.projectId !== plan.projectId || plan.workspaceId !== plan.workspaceId) {
    throw new TestingError('TESTING_INVALID_REQUEST', 'plan ids must be strings');
  }
  if (!Array.isArray(plan.commands) || plan.commands.length > 8) {
    throw new TestingError('TESTING_INVALID_PLAN', 'plan commands must be a bounded array');
  }
  for (const command of plan.commands) {
    validateTestCommand(command);
  }
  if (
    !Number.isInteger(plan.commandTimeoutMs) ||
    plan.commandTimeoutMs < 1000 ||
    plan.commandTimeoutMs > TEST_RUN_LIMIT_CEILINGS.maxCommandTimeoutMs
  ) {
    throw new TestingError('TESTING_INVALID_PLAN', 'commandTimeoutMs out of bounds');
  }
  if (plan.validationSteps.length > 12) {
    throw new TestingError('TESTING_INVALID_PLAN', 'too many validation steps');
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Limits (never unlimited; every value is capped by a hard ceiling)
// ---------------------------------------------------------------------------

export function resolveTestRunLimits(overrides: Partial<TestRunLimits> | undefined): TestRunLimits {
  const source = { ...TEST_RUN_LIMIT_DEFAULTS, ...(overrides ?? {}) };
  const clamp = (value: number, ceiling: number): number => {
    if (!Number.isInteger(value) || value < 1) {
      throw new TestingError('TESTING_INVALID_REQUEST', 'limits must be positive integers');
    }
    return Math.min(value, ceiling);
  };
  return {
    maxRepairAttempts: clamp(source.maxRepairAttempts, TEST_RUN_LIMIT_CEILINGS.maxRepairAttempts),
    maxCommands: clamp(source.maxCommands, TEST_RUN_LIMIT_CEILINGS.maxCommands),
    maxDebugFiles: clamp(source.maxDebugFiles, TEST_RUN_LIMIT_CEILINGS.maxDebugFiles),
    maxCommandTimeoutMs: clamp(
      source.maxCommandTimeoutMs,
      TEST_RUN_LIMIT_CEILINGS.maxCommandTimeoutMs,
    ),
  };
}

// ---------------------------------------------------------------------------
// Diagnoses + repair plans (mock or AI output is validated, never trusted)
// ---------------------------------------------------------------------------

function validateStatement(statement: DiagnosisStatement, index: number): DiagnosisStatement {
  const text = assertBoundedText(
    (statement as { text?: unknown }).text,
    `statements[${index}].text`,
    1000,
  );
  const kind = (statement as { kind?: unknown }).kind;
  if (kind !== 'fact' && kind !== 'inference' && kind !== 'recommendation') {
    throw new TestingError('TESTING_INVALID_DIAGNOSIS', `statement ${index} has an unknown kind`);
  }
  if (kind === 'inference' && statement.confidence === undefined) {
    throw new TestingError(
      'TESTING_INVALID_DIAGNOSIS',
      `inference statement ${index} must carry a confidence level`,
    );
  }
  if (text.includes('\u0000') || isSecretShaped(text)) {
    throw new TestingError('TESTING_SECRET_REJECTED', 'secret-shaped diagnosis text rejected');
  }
  return statement;
}

const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['high', 'medium', 'low'];

export function validateDiagnosis(diagnosis: Diagnosis): Diagnosis {
  if (!FAILURE_CATEGORIES.includes(diagnosis.category)) {
    throw new TestingError(
      'TESTING_INVALID_DIAGNOSIS',
      `unknown failure category "${String(diagnosis.category)}"`,
    );
  }
  assertBoundedText(diagnosis.summary, 'diagnosis.summary', 1000);
  if (!CONFIDENCE_LEVELS.includes(diagnosis.confidence)) {
    throw new TestingError('TESTING_INVALID_DIAGNOSIS', 'unknown confidence level');
  }
  if (!Array.isArray(diagnosis.statements) || diagnosis.statements.length === 0) {
    throw new TestingError('TESTING_INVALID_DIAGNOSIS', 'a diagnosis needs at least one statement');
  }
  if (diagnosis.statements.length > 12) {
    throw new TestingError('TESTING_INVALID_DIAGNOSIS', 'too many diagnosis statements');
  }
  diagnosis.statements.forEach(validateStatement);
  for (const path of diagnosis.affectedPaths) {
    assertBoundedText(path, 'affectedPaths[]', 512);
  }
  if (diagnosis.affectedPaths.length > 8) {
    throw new TestingError('TESTING_INVALID_DIAGNOSIS', 'too many affected paths');
  }
  assertBoundedText(diagnosis.recommendedAction, 'diagnosis.recommendedAction', 1000);
  return diagnosis;
}

export function validateRepairPlan(plan: RepairPlan): RepairPlan {
  validateDiagnosis(plan.diagnosis);
  if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
    throw new TestingError(
      'TESTING_INVALID_REPAIR_PLAN',
      'a repair plan needs at least one change',
    );
  }
  if (plan.changes.length > 8) {
    throw new TestingError('TESTING_INVALID_REPAIR_PLAN', 'too many repair changes');
  }
  const seen = new Set<string>();
  for (const change of plan.changes) {
    const mode = (change as { mode?: unknown }).mode;
    if (!REPAIR_CHANGE_MODES.includes(mode as (typeof REPAIR_CHANGE_MODES)[number])) {
      throw new TestingError(
        'TESTING_INVALID_REPAIR_PLAN',
        `unknown change mode "${String(mode)}"`,
      );
    }
    if (!REPAIR_RISK_LEVELS.includes(plan.risk)) {
      throw new TestingError('TESTING_INVALID_REPAIR_PLAN', 'unknown risk level');
    }
    if (!REPAIR_SCOPES.includes(plan.scope)) {
      throw new TestingError('TESTING_INVALID_REPAIR_PLAN', 'unknown repair scope');
    }
    assertBoundedText(change.path, 'change.path', 512);
    if (seen.has(change.path)) {
      throw new TestingError(
        'TESTING_INVALID_REPAIR_PLAN',
        `duplicate change path "${change.path}"`,
      );
    }
    seen.add(change.path);
    if (typeof change.content !== 'string' || change.content.length > 65_536) {
      throw new TestingError('TESTING_INVALID_REPAIR_PLAN', 'change content out of bounds');
    }
    if (change.content.includes('\u0000')) {
      throw new TestingError(
        'TESTING_INVALID_REPAIR_PLAN',
        'change content has control characters',
      );
    }
    if (isSecretShaped(change.content) || isSecretKeyName(change.path)) {
      throw new TestingError('TESTING_SECRET_REJECTED', 'secret-shaped repair content rejected');
    }
    assertBoundedText(change.reason, 'change.reason', 1000);
    assertBoundedText(change.expectedEffect, 'change.expectedEffect', 1000);
  }
  assertBoundedText(plan.verificationPlan, 'repairPlan.verificationPlan', 1000);
  if (plan.testsToRerun.length > 8) {
    throw new TestingError('TESTING_INVALID_REPAIR_PLAN', 'too many testsToRerun entries');
  }
  return plan;
}

/** Confidence a classifier may assign; used by the diagnostics layer. */
export function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(value);
}
