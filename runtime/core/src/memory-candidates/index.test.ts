import { describe, expect, it } from 'vitest';
import { extractRuntimeMemoryCandidates } from '@veltravia/runtime-core';

describe('runtime memory candidates', () => {
  it('extracts a workflow candidate with runtime provenance', () => {
    const candidates = extractRuntimeMemoryCandidates({
      runtimeId: 'rt_1',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      runtimeType: 'fullstack',
      revision: 4,
      hasBuildStep: true,
      startScript: 'npm run start:server',
      isolationLevel: 'simulated',
    });
    const workflow = candidates.find((candidate) => candidate.type === 'workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.status).toBe('candidate');
    expect(workflow?.source.kind).toBe('system_derived');
    expect(workflow?.source.referenceId).toBe('rt_1');
    expect(workflow?.content).toContain('start:server');
  });

  it('documents the simulated-isolation limitation as a candidate', () => {
    const candidates = extractRuntimeMemoryCandidates({
      runtimeId: 'rt_1',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      runtimeType: 'web',
      revision: 1,
      hasBuildStep: false,
      startScript: 'npm run preview',
      isolationLevel: 'simulated',
    });
    expect(candidates.some((candidate) => candidate.type === 'known_limitation')).toBe(true);
  });

  it('skips the limitation candidate when the executor is genuinely isolated', () => {
    const candidates = extractRuntimeMemoryCandidates({
      runtimeId: 'rt_1',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      runtimeType: 'web',
      revision: 1,
      hasBuildStep: true,
      startScript: 'npm run preview',
      isolationLevel: 'isolated',
    });
    expect(candidates.every((candidate) => candidate.type !== 'known_limitation')).toBe(true);
  });
});
