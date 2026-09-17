/**
 * Coding Agent policy: request/plan/action validation, limits resolution, and
 * the action -> Tool System mapping. The policy is authoritative and trusted;
 * user requirements, model output, project files, and tool output are DATA.
 *
 * Path SECURITY is not re-implemented here - the Project Engine remains the
 * single filesystem security authority (executed via the Tool System).
 */

import { containsSecretShapedContent } from '@veltravia/project-core';
import type { ToolManager } from '@veltravia/tool-core';

import { CodingError } from '../errors/index.js';
import {
  CODING_ACTION_TYPES,
  CODING_LIMIT_CEILINGS,
  CODING_LIMIT_DEFAULTS,
  type CodingAction,
  type CodingPlan,
  type CodingRunLimits,
  type CodingRunRequest,
} from '../types/index.js';

/** Tool ids the Coding Agent may target. It can never invent others. */
export const CODING_TOOL_IDS = {
  inspectProject: 'project.inspect',
  listFiles: 'project.list-files',
  readFile: 'project.read-file',
  createFile: 'project.create-file',
  createDirectory: 'project.create-directory',
  updateFile: 'project.update-file',
  deleteFile: 'project.delete-file',
  moveFile: 'project.move-file',
  sandboxCreate: 'sandbox.create',
  sandboxExecute: 'sandbox.execute',
} as const;

/**
 * The invoke_tool action's tool id namespace marker. Unlike the fixed
 * project/sandbox tool ids, invoke_tool targets a SERVER-ALLOWLISTED Tool
 * System tool (e.g. `github.demo.contents.get`) - the id itself comes from
 * the decision source and is validated against the allowlist in
 * bindCodingAction, then re-gated by the Tool System at execution.
 */
export const INVOKE_TOOL_ID = 'coding.invoke-tool';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT = 4000;
const MAX_ITEMS = 50;
const MAX_PATH_LENGTH = 512;

/** Credential-assignment shapes never appear in coding input surfaces. */
const ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|secret|password|passwd|token|credential)s?\s*[:=]\s*\S+/i;

function assertNoSecretShaped(text: string, surface: string): void {
  if (containsSecretShapedContent(text) || ASSIGNMENT_PATTERN.test(text)) {
    throw new CodingError('CODING_SECRET_REJECTED', `${surface} contains secret-shaped content`, {
      details: { surface },
    });
  }
}

function assertIdentifier(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new CodingError('CODING_INVALID_REQUEST', `${field} is not a valid identifier`, {
      details: { field },
    });
  }
}

function assertTextArray(value: readonly string[] | undefined, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new CodingError(
      'CODING_INVALID_REQUEST',
      `${field} must be an array of at most 50 items`,
      {
        details: { field },
      },
    );
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_TEXT) {
      throw new CodingError('CODING_INVALID_REQUEST', `${field} contains an invalid entry`, {
        details: { field },
      });
    }
    assertNoSecretShaped(item, field);
  }
  return value;
}

/**
 * Resolves run limits. Only trusted server-side configuration can raise
 * limits, and even then only up to the hard ceilings. Model output and user
 * requests carry no limits at all.
 */
export function resolveCodingLimits(overrides?: Partial<CodingRunLimits>): CodingRunLimits {
  if (overrides !== undefined) {
    for (const key of Object.keys(CODING_LIMIT_DEFAULTS) as (keyof CodingRunLimits)[]) {
      const value = overrides[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new CodingError('CODING_INVALID_REQUEST', `invalid coding limit "${key}"`, {
          details: { key },
        });
      }
    }
  }
  const maxIterations = Math.min(
    overrides?.maxIterations ?? CODING_LIMIT_DEFAULTS.maxIterations,
    CODING_LIMIT_CEILINGS.maxIterations,
  );
  const maxToolCalls = Math.min(
    overrides?.maxToolCalls ?? CODING_LIMIT_DEFAULTS.maxToolCalls,
    CODING_LIMIT_CEILINGS.maxToolCalls,
  );
  const maxDurationMs = Math.min(
    overrides?.maxDurationMs ?? CODING_LIMIT_DEFAULTS.maxDurationMs,
    CODING_LIMIT_CEILINGS.maxDurationMs,
  );
  const maxConsecutiveFailures = Math.min(
    overrides?.maxConsecutiveFailures ?? CODING_LIMIT_DEFAULTS.maxConsecutiveFailures,
    CODING_LIMIT_CEILINGS.maxConsecutiveFailures,
  );
  return { maxIterations, maxToolCalls, maxDurationMs, maxConsecutiveFailures };
}

/** Validates a run request. Rejects secret-shaped input and bad identifiers. */
export function validateCodingRunRequest(request: CodingRunRequest): CodingRunRequest {
  const { runId, projectId, workspaceId, userRequirement } = request;
  assertIdentifier(runId, 'runId');
  assertIdentifier(projectId, 'projectId');
  assertIdentifier(workspaceId, 'workspaceId');
  if (typeof userRequirement !== 'string' || userRequirement.length < 1) {
    throw new CodingError('CODING_INVALID_REQUEST', 'userRequirement must be a non-empty string', {
      details: { field: 'userRequirement' },
    });
  }
  if (userRequirement.length > MAX_TEXT) {
    throw new CodingError('CODING_INVALID_REQUEST', 'userRequirement is too long', {
      details: { field: 'userRequirement' },
    });
  }
  assertNoSecretShaped(userRequirement, 'userRequirement');
  assertTextArray(request.targetFiles, 'targetFiles');
  assertTextArray(request.constraints, 'constraints');
  assertTextArray(request.acceptanceCriteria, 'acceptanceCriteria');
  return request;
}

/** Validates a plan: concise, machine-readable, secret-free, bounded. */
export function validateCodingPlan(plan: CodingPlan): CodingPlan {
  if (plan === null || typeof plan !== 'object') {
    throw new CodingError('CODING_INVALID_PLAN', 'plan must be an object');
  }
  if (typeof plan.goal !== 'string' || plan.goal.length < 1 || plan.goal.length > MAX_TEXT) {
    throw new CodingError('CODING_INVALID_PLAN', 'plan goal must be a non-empty string', {
      details: { field: 'goal' },
    });
  }
  assertNoSecretShaped(plan.goal, 'plan.goal');
  if (
    !Array.isArray(plan.steps) ||
    plan.steps.length < 1 ||
    plan.steps.length > MAX_ITEMS ||
    plan.steps.some(
      (step) =>
        typeof step?.summary !== 'string' || step.summary.length === 0 || step.summary.length > 500,
    )
  ) {
    throw new CodingError('CODING_INVALID_PLAN', 'plan steps must be 1-50 concise summaries', {
      details: { field: 'steps' },
    });
  }
  assertTextArray(plan.filesToInspect, 'plan.filesToInspect');
  assertTextArray(plan.filesToModify, 'plan.filesToModify');
  assertTextArray(plan.validations, 'plan.validations');
  assertTextArray(plan.acceptanceCriteria, 'plan.acceptanceCriteria');
  // A plan is data: it cannot carry tool ids, permissions, commands, limits,
  // or credential references. Those simply do not exist as plan fields.
  return plan;
}

function assertPath(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodingError('CODING_INVALID_REQUEST', `${field} must be a non-empty string`, {
      details: { field },
    });
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new CodingError('CODING_INVALID_REQUEST', `${field} is too long`, {
      details: { field },
    });
  }
  // Lightweight shape check only. The Project Engine is the single security
  // authority for path normalization and traversal rejection at execution.
  /* eslint-disable no-control-regex -- rejecting control characters is the entire
     point of this pattern. */
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    /* eslint-enable no-control-regex */
    throw new CodingError('CODING_INVALID_REQUEST', `${field} contains control characters`, {
      details: { field },
    });
  }
  return value;
}

export interface CodingActionBinding {
  readonly toolId: string;
  readonly input: Record<string, unknown>;
  /** The state the run must be in (or move to) for this action. */
  readonly state: 'inspecting' | 'editing' | 'validating';
}

/**
 * Validates an action and binds it to its Tool System target. The mapping is
 * code: the model can choose an action type and its data, but never a tool id,
 * a permission, or a capability that does not exist here.
 */
/** Context for the optional `invoke_tool` action (trusted, server-provided). */
export interface CodingInvokeToolContext {
  /** The Tool System - availability and risk classification only. */
  readonly tools: ToolManager;
  /** Explicit server-side allowlist. Empty or absent = invoke_tool is off. */
  readonly allowlist: readonly string[];
}

export function bindCodingAction(
  action: CodingAction,
  projectId: string,
  workspaceId: string,
  invokeTool?: CodingInvokeToolContext,
): CodingActionBinding {
  if (action === null || typeof action !== 'object' || typeof action.type !== 'string') {
    throw new CodingError('CODING_INVALID_DECISION', 'action must be an object with a type');
  }
  if (!(CODING_ACTION_TYPES as readonly string[]).includes(action.type)) {
    throw new CodingError('CODING_INVALID_DECISION', `unknown action type "${action.type}"`, {
      details: { type: action.type },
    });
  }
  switch (action.type) {
    case 'inspect_project':
      return {
        toolId: CODING_TOOL_IDS.inspectProject,
        input: { projectId, workspaceId },
        state: 'inspecting',
      };
    case 'list_files':
      return {
        toolId: CODING_TOOL_IDS.listFiles,
        input: {
          workspaceId,
          ...(action.path !== undefined ? { path: assertPath(action.path, 'action.path') } : {}),
        },
        state: 'inspecting',
      };
    case 'read_file':
      return {
        toolId: CODING_TOOL_IDS.readFile,
        input: { workspaceId, path: assertPath(action.path, 'action.path') },
        state: 'inspecting',
      };
    case 'create_file': {
      if (action.content !== undefined) {
        assertNoSecretShaped(action.content, 'action.content');
      }
      return {
        toolId: CODING_TOOL_IDS.createFile,
        input: {
          workspaceId,
          path: assertPath(action.path, 'action.path'),
          ...(action.content !== undefined ? { content: action.content } : {}),
        },
        state: 'editing',
      };
    }
    case 'update_file': {
      assertNoSecretShaped(action.content, 'action.content');
      return {
        toolId: CODING_TOOL_IDS.updateFile,
        input: {
          workspaceId,
          path: assertPath(action.path, 'action.path'),
          content: action.content,
          // The manager substitutes its own tracked revision when absent;
          // optimistic revision protection is always enforced either way.
          expectedRevision:
            action.expectedRevision !== undefined && Number.isInteger(action.expectedRevision)
              ? action.expectedRevision
              : -1,
        },
        state: 'editing',
      };
    }
    case 'delete_file':
      return {
        toolId: CODING_TOOL_IDS.deleteFile,
        input: { workspaceId, path: assertPath(action.path, 'action.path') },
        state: 'editing',
      };
    case 'move_file':
      return {
        toolId: CODING_TOOL_IDS.moveFile,
        input: {
          workspaceId,
          fromPath: assertPath(action.fromPath, 'action.fromPath'),
          toDirectory: assertPath(action.toDirectory, 'action.toDirectory'),
        },
        state: 'editing',
      };
    case 'invoke_tool': {
      // The model can only NAME a tool; the allowlist decides whether the
      // name is real for this run, and the Tool System re-checks everything
      // at execution (schema, permissions, connector authorization,
      // confirmation). Inventing a tool id fails deterministically here.
      if (invokeTool === undefined) {
        throw new CodingError(
          'CODING_INVALID_DECISION',
          'invoke_tool is not enabled for this run (no tool allowlist was provided)',
          { details: { type: 'invoke_tool' } },
        );
      }
      const toolId = (action as { toolId?: unknown }).toolId;
      if (typeof toolId !== 'string' || toolId.length === 0 || toolId.length > 256) {
        throw new CodingError('CODING_INVALID_DECISION', 'invoke_tool requires a toolId', {
          details: { field: 'toolId' },
        });
      }
      if (!invokeTool.allowlist.includes(toolId)) {
        throw new CodingError(
          'CODING_INVALID_DECISION',
          `tool "${toolId}" is not allow-listed for this run`,
          { details: { toolId } },
        );
      }
      let inspection;
      try {
        inspection = invokeTool.tools.inspect(toolId);
      } catch {
        throw new CodingError('CODING_INVALID_DECISION', `tool "${toolId}" is not registered`, {
          details: { toolId },
        });
      }
      const input = (action as { input?: unknown }).input;
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input as Record<string, unknown>).length > 32
      ) {
        throw new CodingError(
          'CODING_INVALID_DECISION',
          'invoke_tool input must be a small object',
          { details: { toolId } },
        );
      }
      const serialized = JSON.stringify(input);
      if (serialized.length > 128 * 1024) {
        throw new CodingError('CODING_INVALID_DECISION', 'invoke_tool input is too large', {
          details: { toolId },
        });
      }
      assertNoSecretShaped(serialized, 'invoke_tool.input');
      // The binding carries the REAL Tool System tool id and its input: the
      // manager invokes the allowlisted tool through the Tool System exactly
      // like a project tool, so the full pipeline applies.
      return {
        toolId,
        input: input as Record<string, unknown>,
        state:
          inspection.definition.riskLevel === 'high' ||
          inspection.definition.riskLevel === 'critical'
            ? 'editing'
            : 'inspecting',
      };
    }
    case 'validate': {
      const args = action.arguments ?? [];
      if (!Array.isArray(args) || args.length > 32) {
        throw new CodingError(
          'CODING_INVALID_REQUEST',
          'validate arguments must be at most 32 strings',
          { details: { field: 'arguments' } },
        );
      }
      for (const arg of args) {
        if (typeof arg !== 'string' || arg.length > 4096) {
          throw new CodingError('CODING_INVALID_REQUEST', 'validate arguments must be strings', {
            details: { field: 'arguments' },
          });
        }
        assertNoSecretShaped(arg, 'action.arguments');
      }
      const command = action.command;
      if (typeof command !== 'string' || command.length === 0 || command.length > 64) {
        throw new CodingError(
          'CODING_INVALID_REQUEST',
          'validate command must be 1-64 characters',
          {
            details: { field: 'command' },
          },
        );
      }
      return {
        toolId: CODING_TOOL_IDS.sandboxExecute,
        input: { command, arguments: [...args] },
        state: 'validating',
      };
    }
  }
  // Unreachable: the allowlist check above rejects unknown action types.
  throw new CodingError('CODING_INVALID_DECISION', 'unknown action type');
}

/** Ensures every tool the Coding Agent needs is registered. */
export function assertCodingToolsRegistered(tools: ToolManager): void {
  for (const toolId of Object.values(CODING_TOOL_IDS)) {
    try {
      tools.inspect(toolId);
    } catch {
      throw new CodingError(
        'CODING_INVALID_REQUEST',
        `required tool "${toolId}" is not registered`,
        { details: { toolId } },
      );
    }
  }
}
