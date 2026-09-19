/**
 * API memory service (Step 15).
 *
 * Binds the memory core to the API process: safe response mapping, and
 * conservative candidate extraction from COMPLETED generation/testing
 * runs. This is the ONLY place raw run views get mapped to memory FACTS -
 * extraction inputs are narrow, structural, and never carry source code,
 * command output, or secrets. Nothing here stores a memory directly;
 * candidates always flow through the MemoryManager as NON-AUTHORITATIVE
 * `candidate` records pending human approval.
 */

import {
  extractCandidatesFromGenerationRun,
  extractCandidatesFromTestingRun,
  type CreateMemoryInput,
  type ProjectMemory,
} from '@veltravia/memory-core';
import type { AppGenerationManager, GenerationRunView } from '@veltravia/generation-core';
import type { TestingManager, TestRunView } from '@veltravia/testing-core';

/** A safe, normalized view of one project memory for HTTP responses. */
export interface MemoryResponse {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly source: { readonly kind: string; readonly referenceId?: string };
  readonly confidence: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly lastVerifiedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toMemoryResponse(memory: ProjectMemory): MemoryResponse {
  return {
    id: memory.id,
    projectId: memory.projectId,
    workspaceId: memory.workspaceId,
    type: memory.type,
    title: memory.title,
    content: memory.content,
    source: memory.source,
    confidence: memory.confidence,
    status: memory.status,
    verificationStatus: memory.verificationStatus,
    lastVerifiedAt: memory.lastVerifiedAt,
    revision: memory.revision,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export interface ExtractedCandidate {
  readonly input: CreateMemoryInput;
}

/**
 * Maps a COMPLETED generation run to candidate memory inputs.
 * Only structural spec facts are read - never generated file content,
 * never command output. Non-completed runs are rejected (nothing is
 * extracted from failed, cancelled, or in-flight runs).
 */
export function candidatesFromGenerationRun(run: GenerationRunView): ExtractedCandidate[] {
  if (run.state !== 'completed') {
    throw new Error('RUN_NOT_COMPLETED');
  }
  // The safe run view carries only bounded metadata: idea, spec name,
  // app type, template id, and the test summary command. Spec feature
  // lists and generated code are deliberately NOT exposed here, so
  // extraction stays honest and minimal.
  const testCommand = run.result?.tests?.commands[0];
  const inputs = extractCandidatesFromGenerationRun({
    runId: run.runId,
    projectId: run.projectId ?? '',
    ...(run.workspaceId !== null ? { workspaceId: run.workspaceId } : {}),
    projectName: run.specName ?? 'Generated application',
    appType: run.appType ?? 'application',
    ...(run.templateId !== null ? { templateId: run.templateId } : {}),
    description: run.idea,
    features: [],
    entities: [],
    integrations: [],
    ...(testCommand !== undefined
      ? { testingCommand: `${testCommand.command} ${testCommand.arguments.join(' ')}` }
      : {}),
  });
  return inputs.map((input) => ({ input }));
}

/**
 * Maps a COMPLETED testing run to candidate memory inputs. Only the
 * stable surface (project type, framework, runtime) and approved
 * diagnosis FACT statements are read - raw command output never enters
 * memory.
 */
export function candidatesFromTestingRun(run: TestRunView): ExtractedCandidate[] {
  if (run.state !== 'completed') {
    throw new Error('RUN_NOT_COMPLETED');
  }
  const diagnosisFacts =
    run.diagnosis?.statements
      .filter((statement) => statement.kind === 'fact')
      .map((statement) => statement.text) ?? [];
  const testCommand = run.plan?.commands[0];
  const inputs = extractCandidatesFromTestingRun({
    runId: run.runId,
    projectId: run.projectId,
    ...(run.workspaceId !== undefined && run.workspaceId !== null
      ? { workspaceId: run.workspaceId }
      : {}),
    projectType: run.plan?.projectType ?? run.projectType ?? 'node',
    ...(run.plan?.framework !== null && run.plan?.framework !== undefined
      ? { framework: run.plan.framework }
      : {}),
    ...(run.plan?.runtime !== null && run.plan?.runtime !== undefined
      ? { runtime: run.plan.runtime }
      : {}),
    ...(testCommand !== undefined
      ? { testCommand: `${testCommand.executable} ${testCommand.arguments.join(' ')}` }
      : {}),
    diagnosisFacts,
  });
  return inputs.map((input) => ({ input }));
}

/** Loads a generation run view for extraction (typed manager call). */
export function getGenerationRun(manager: AppGenerationManager, runId: string): GenerationRunView {
  return manager.getRun(runId);
}

/** Loads a testing run view for extraction (typed manager call). */
export function getTestingRun(manager: TestingManager, runId: string): TestRunView {
  return manager.getRun(runId);
}
