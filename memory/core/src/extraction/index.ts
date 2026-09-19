/**
 * Conservative memory extraction from COMPLETED workflows.
 *
 * Extraction produces MemoryCandidate INPUTS - never directly stored
 * memories. The caller (the API layer) validates, stamps provenance,
 * and stores them through the MemoryManager as NON-AUTHORITATIVE
 * `candidate` records; a human approves or rejects each one.
 *
 * Rules:
 * - only durable, useful facts are extracted (never raw output, never
 *   source code, never full conversation text)
 * - conservative by design: fewer, higher-value candidates beat noise
 * - every candidate is bounded (count ceiling + field limits enforced by
 *   the manager on store)
 * - the inputs are narrow structural FACTS the API maps from real run
 *   views, so this module never depends on the generation/testing
 *   packages (no coupling, no leakage of internal run state)
 */

import type { CreateMemoryInput } from '../types/index.js';
import { MEMORY_LIMITS } from '../types/index.js';

/** Structural facts about one completed app-generation run. */
export interface GenerationRunFacts {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly projectName: string;
  readonly appType: string;
  readonly templateId?: string;
  readonly framework?: string;
  readonly runtime?: string;
  readonly description: string;
  readonly features: readonly string[];
  readonly entities: readonly string[];
  readonly integrations: readonly string[];
  readonly testingCommand?: string;
}

/** Structural facts about one completed testing/debugging run. */
export interface TestingRunFacts {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly projectType: string;
  readonly framework?: string;
  readonly runtime?: string;
  readonly testCommand?: string;
  /** FACT statements from an approved diagnosis (bounded, structured). */
  readonly diagnosisFacts: readonly string[];
}

/**
 * Extracts durable facts from a completed generation run.
 * Never stores generated source code - the Project Engine remains the
 * source of truth for project files.
 */
export function extractCandidatesFromGenerationRun(facts: GenerationRunFacts): CreateMemoryInput[] {
  const candidates: CreateMemoryInput[] = [];
  const provenance = {
    kind: 'generation_run' as const,
    referenceId: facts.runId,
  };

  push(candidates, facts.projectId, facts.workspaceId, {
    type: 'project_summary',
    title: `${facts.projectName} application summary`,
    content: `${facts.projectName} is a ${facts.appType} application${facts.description !== '' ? `: ${facts.description}` : ''}.`,
    source: provenance,
    confidence: 'medium',
  });

  if (facts.framework !== undefined || facts.runtime !== undefined) {
    const stack = [
      facts.framework !== undefined ? `Framework: ${facts.framework}` : null,
      facts.runtime !== undefined ? `Runtime: ${facts.runtime}` : null,
      facts.templateId !== undefined ? `Generated from the ${facts.templateId} template` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('. ');
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'technology',
      title: `${facts.projectName} technology stack`,
      content: `${stack}.`,
      source: provenance,
      confidence: 'high',
    });
  }

  if (facts.features.length > 0) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'requirement',
      title: `${facts.projectName} generated feature requirements`,
      content: `The application was generated with these features: ${facts.features.slice(0, 12).join(', ')}.`,
      source: provenance,
      confidence: 'medium',
    });
  }

  if (facts.testingCommand !== undefined) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'testing_rule',
      title: `${facts.projectName} test command`,
      content: `Generated tests run with: ${facts.testingCommand}.`,
      source: provenance,
      confidence: 'high',
    });
  }

  return candidates.slice(0, MEMORY_LIMITS.maxCandidatesPerWorkflow);
}

/**
 * Extracts durable facts from a completed testing/debugging run.
 * Only persists the stable surface (runner, framework) and approved
 * diagnosis FACTS - never raw command output.
 */
export function extractCandidatesFromTestingRun(facts: TestingRunFacts): CreateMemoryInput[] {
  const candidates: CreateMemoryInput[] = [];
  const provenance = {
    kind: facts.diagnosisFacts.length > 0 ? ('debugging_run' as const) : ('test_run' as const),
    referenceId: facts.runId,
  };

  if (facts.testCommand !== undefined) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'testing_rule',
      title: `Project test command`,
      content: `Tests are executed using the project's configured test runner: ${facts.testCommand}.`,
      source: provenance,
      confidence: 'high',
    });
  }

  if (facts.framework !== undefined) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'technology',
      title: `Detected ${facts.projectType} framework`,
      content: `The project's ${facts.projectType} surface runs on ${facts.framework}${facts.runtime !== undefined ? ` (${facts.runtime} runtime)` : ''}.`,
      source: provenance,
      confidence: 'medium',
    });
  }

  // Approved diagnosis FACTS become known-issue knowledge (bounded).
  for (const fact of facts.diagnosisFacts.slice(0, 3)) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'known_issue',
      title: `Diagnosed issue (from test run)`,
      content: fact,
      source: { kind: 'debugging_run', referenceId: facts.runId },
      confidence: 'medium',
    });
  }

  return candidates.slice(0, MEMORY_LIMITS.maxCandidatesPerWorkflow);
}

function push(
  candidates: CreateMemoryInput[],
  projectId: string,
  workspaceId: string | undefined,
  input: Omit<CreateMemoryInput, 'projectId' | 'workspaceId'>,
): void {
  candidates.push({
    ...input,
    projectId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  });
}
