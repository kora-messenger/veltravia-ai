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

/**
 * Structural facts from one COMPLETED codebase index build (Step 16).
 * Only evidence-derived summary facts - never symbol lists, never source
 * content, never the whole index. Provenance is `system_derived` with the
 * index id as the reference so a human can trace the origin.
 */
export interface CodebaseAnalysisFacts {
  readonly indexId: string;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly languages: readonly string[];
  readonly frameworks: readonly { readonly id: string; readonly name: string }[];
  readonly entryPointPaths: readonly string[];
  readonly testFilePaths: readonly string[];
  readonly routeCount: number;
  readonly componentCount: number;
  readonly flaggedSecretFileCount: number;
}

/**
 * Extracts durable facts from a completed codebase analysis. The full
 * code index is deliberately NOT duplicated into memory - only a few
 * stable, structural conclusions, each pending human approval.
 */
export function extractCandidatesFromCodebaseAnalysis(
  facts: CodebaseAnalysisFacts,
): CreateMemoryInput[] {
  const candidates: CreateMemoryInput[] = [];
  const provenance = {
    kind: 'system_derived' as const,
    referenceId: facts.indexId,
  };

  if (facts.frameworks.length > 0 || facts.languages.length > 0) {
    const parts = [
      facts.frameworks.length > 0
        ? `Framework evidence: ${facts.frameworks
            .slice(0, 5)
            .map((framework) => framework.name)
            .join(', ')}`
        : null,
      facts.languages.length > 0
        ? `Languages present: ${facts.languages.slice(0, 6).join(', ')}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join('. ');
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'technology',
      title: `Codebase technology profile (from index)`,
      content: `${parts}.`,
      source: provenance,
      confidence: 'medium',
    });
  }

  if (facts.entryPointPaths.length > 0) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'project_summary',
      title: `Likely application entry points (from index)`,
      content: `The index identified likely entry points: ${facts.entryPointPaths.slice(0, 5).join(', ')}.`,
      source: provenance,
      confidence: 'low',
    });
  }

  if (facts.testFilePaths.length > 0) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'testing_rule',
      title: `Test locations (from index)`,
      content: `Tests live in: ${facts.testFilePaths.slice(0, 6).join(', ')}.`,
      source: provenance,
      confidence: 'medium',
    });
  }

  if (facts.flaggedSecretFileCount > 0) {
    push(candidates, facts.projectId, facts.workspaceId, {
      type: 'known_issue',
      title: `Secret-shaped content detected (from index)`,
      content: `${facts.flaggedSecretFileCount} indexed file(s) contain secret-shaped content. Values were never stored; the files should be reviewed.`,
      source: provenance,
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
