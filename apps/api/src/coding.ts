import {
  CodingAgentManager,
  createProjectTools,
  CODING_TOOL_IDS,
  type CodingDecisionSource,
} from '@veltravia/coding-agent-core';
import { createScriptedCodingDecisionSource } from '@veltravia/coding-agent-mock';
import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxManager } from '@veltravia/sandbox-core';
import type { ToolManager } from '@veltravia/tool-core';

import { createToolManager } from './tools.js';

/**
 * The API's demo Coding Agent decision source.
 *
 * DEVELOPMENT-ONLY LIMITATION (documented in docs/coding-agent.md): the API's
 * coding agent runs on a deterministic, offline scripted decision source - no
 * real model is wired into the API yet (prompt tuning belongs to a later
 * step). The orchestration, state machine, gates, confirmation flow, limits,
 * and audit are fully real: swapping the scripted source for an AI-routed
 * CodingDecisionSource changes nothing else.
 */
function createDemoCodingDecisionSource(): CodingDecisionSource {
  return createScriptedCodingDecisionSource([
    {
      type: 'plan',
      plan: {
        goal: 'Create a small markdown note in the workspace.',
        steps: [{ summary: 'Create notes.md with a short line of text' }],
        filesToInspect: [],
        filesToModify: ['notes.md'],
        validations: [],
        acceptanceCriteria: ['notes.md exists in the workspace'],
      },
    },
    {
      type: 'action',
      action: {
        type: 'create_file',
        path: 'notes.md',
        content: 'Created by the Veltravia coding demo agent.',
      },
    },
    { type: 'complete', summary: 'Created notes.md in the workspace.' },
  ]);
}

export interface CreateCodingManagerOptions {
  readonly projectEngine: ProjectEngine;
  readonly tools?: ToolManager;
  /** Sandbox manager for registering sandbox tools when no tools manager is injected. */
  readonly sandboxes?: SandboxManager;
  readonly now?: () => Date;
  /** Overrides the decision source (tests may inject their own script). */
  readonly decisionSource?: CodingDecisionSource;
  /** Trusted server-side config: plans need human approval. Default: true. */
  readonly requirePlanApproval?: boolean;
}

/**
 * Builds the API's CodingAgentManager.
 *
 * Every project file operation and every sandbox validation flows through
 * the SAME Tool System pipeline (validation, explicit grants, risk-based
 * confirmation). Registration grants nothing: this wiring grants exactly the
 * permissions the coding agent needs, server-side, and nothing else.
 */
export function createCodingManager(options: CreateCodingManagerOptions): CodingAgentManager {
  const tools =
    options.tools ?? createToolManager(options.now ?? (() => new Date()), options.sandboxes);
  const projectTools = createProjectTools(options.projectEngine);
  for (const definition of projectTools.definitions) {
    tools.register(definition);
  }
  for (const implementation of projectTools.implementations) {
    tools.registerImplementation(implementation);
  }
  // Explicit, minimal, server-side grants - nothing the agent itself can add.
  // Only tools that are actually registered are granted; registration itself
  // grants nothing (Step 5 rule).
  for (const toolId of Object.values(CODING_TOOL_IDS)) {
    if (!tools.has(toolId)) continue;
    const inspection = tools.inspect(toolId);
    for (const permission of inspection.requiredPermissions) {
      tools.grantPermission(toolId, permission);
    }
  }
  return new CodingAgentManager({
    tools,
    decisionSource: options.decisionSource ?? createDemoCodingDecisionSource(),
    now: options.now,
    requirePlanApproval: options.requirePlanApproval ?? true,
  });
}
