/**
 * Runtime memory candidates (Step 17, Phase 22).
 *
 * NARROW, STRUCTURAL runtime facts become NON-AUTHORITATIVE project-memory
 * candidates under the Step 15 human-approval rules: provenance is
 * `system_derived` with the runtime id, status is `candidate`, and nothing
 * auto-promotes. Only stable facts are extracted (plan shape, commands,
 * revision binding). Transient runtime logs NEVER become memory.
 *
 * The output is structurally compatible with memory/core's CreateMemoryInput
 * without a package dependency (structural typing; the memory manager
 * re-validates everything anyway).
 */

/** Structural subset of memory/core CreateMemoryInput (no dependency). */
export interface RuntimeMemoryCandidate {
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly type: 'technology' | 'workflow' | 'known_limitation';
  readonly title: string;
  readonly content: string;
  readonly source: { readonly kind: 'system_derived'; readonly referenceId?: string };
  readonly confidence: 'medium' | 'low';
  readonly status: 'candidate';
}

/** Bounded facts extraction consumes - derived from a SUCCESSFULLY STARTED runtime only. */
export interface RuntimeMemoryFacts {
  readonly runtimeId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runtimeType: string;
  readonly revision: number;
  readonly hasBuildStep: boolean;
  readonly startScript: string;
  readonly isolationLevel: 'simulated' | 'isolated';
}

export function extractRuntimeMemoryCandidates(
  facts: RuntimeMemoryFacts,
): RuntimeMemoryCandidate[] {
  const candidates: RuntimeMemoryCandidate[] = [];
  const provenance = { kind: 'system_derived' as const, referenceId: facts.runtimeId };

  candidates.push({
    projectId: facts.projectId,
    workspaceId: facts.workspaceId,
    type: 'workflow',
    title: 'Preview plan (from runtime)',
    content: `Preview for this ${facts.runtimeType} project runs the "${facts.startScript}" script${facts.hasBuildStep ? ' after a build step' : ' without a build step'} (planned at workspace revision ${facts.revision}).`,
    source: provenance,
    confidence: 'medium',
    status: 'candidate',
  });

  if (facts.isolationLevel === 'simulated') {
    candidates.push({
      projectId: facts.projectId,
      workspaceId: facts.workspaceId,
      type: 'known_limitation',
      title: 'Preview isolation is simulated (from runtime)',
      content:
        'The last preview ran on a simulated runtime executor: no real build or server process ran, and no OS-level isolation was exercised. Previews do not verify that the app actually builds or serves.',
      source: provenance,
      confidence: 'medium',
      status: 'candidate',
    });
  }

  return candidates;
}
