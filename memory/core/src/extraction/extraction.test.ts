import { describe, expect, it } from 'vitest';

import {
  extractCandidatesFromGenerationRun,
  extractCandidatesFromTestingRun,
  isSecretShaped,
  MemoryManager,
  MEMORY_LIMITS,
  type CreateMemoryInput,
} from '@veltravia/memory-core';
import { InMemoryMemoryRepository } from '@veltravia/memory-mock';

describe('generation extraction (Phase 18)', () => {
  it('produces bounded, provenance-stamped candidates', () => {
    const candidates = extractCandidatesFromGenerationRun({
      runId: 'gen_001',
      projectId: 'prj_a',
      workspaceId: 'ws_1',
      projectName: 'TaskApp',
      appType: 'task manager',
      templateId: 'web-react',
      framework: 'React 18',
      runtime: 'Vite',
      description: 'A simple task tracker',
      features: ['create tasks', 'mark done'],
      entities: ['Task'],
      integrations: [],
      testingCommand: 'npm test',
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(MEMORY_LIMITS.maxCandidatesPerWorkflow);
    for (const candidate of candidates) {
      expect(candidate.projectId).toBe('prj_a');
      expect(candidate.workspaceId).toBe('ws_1');
      expect(candidate.source.kind).toBe('generation_run');
      expect(candidate.source.referenceId).toBe('gen_001');
      expect(candidate.content.length).toBeLessThanOrEqual(MEMORY_LIMITS.maxContentChars);
    }
    const types = candidates.map((candidate) => candidate.type);
    expect(types).toContain('project_summary');
    expect(types).toContain('technology');
    expect(types).toContain('requirement');
    expect(types).toContain('testing_rule');
    // Never raw source code.
    expect(JSON.stringify(candidates)).not.toMatch(/import |export const |function\(/);
  });

  it('stores candidates as NON-authoritative through the manager', async () => {
    const manager = new MemoryManager({ repository: new InMemoryMemoryRepository() });
    const candidates = extractCandidatesFromGenerationRun({
      runId: 'gen_002',
      projectId: 'prj_a',
      projectName: 'NotesApp',
      appType: 'notes app',
      description: '',
      features: [],
      entities: [],
      integrations: [],
    });
    const stored: CreateMemoryInput[] = [];
    for (const candidate of candidates) {
      stored.push(await manager.createCandidate(candidate));
    }
    expect(stored.length).toBeGreaterThan(0);
    for (const record of stored) {
      expect(record.status).toBe('candidate');
    }
    const approved = await manager.approveCandidate(stored[0].id, 'prj_a');
    expect(approved.status).toBe('active');
  });
});

describe('testing extraction (Phase 19)', () => {
  it('extracts runner facts and bounded diagnosis FACTS', () => {
    const candidates = extractCandidatesFromTestingRun({
      runId: 'test_001',
      projectId: 'prj_a',
      projectType: 'node',
      framework: 'vitest',
      runtime: 'Node 20',
      testCommand: 'npm test',
      diagnosisFacts: [
        'The test command exits non-zero before any repair.',
        'FACT: the manifest declares a failing script.',
      ],
    });
    const types = candidates.map((candidate) => candidate.type);
    expect(types).toContain('testing_rule');
    expect(types).toContain('technology');
    expect(types.filter((type) => type === 'known_issue')).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.projectId).toBe('prj_a');
      expect(['test_run', 'debugging_run']).toContain(candidate.source.kind);
    }
  });

  it('never stores raw command output', () => {
    const candidates = extractCandidatesFromTestingRun({
      runId: 'test_002',
      projectId: 'prj_a',
      projectType: 'node',
      framework: 'vitest',
      runtime: 'Node 20',
      testCommand: 'npm test -- --reporter=verbose',
      diagnosisFacts: [],
    });
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toMatch(/PASS|FAIL|stdout|stderr/);
  });

  it('rejects secret-shaped diagnosis facts at store time', async () => {
    const manager = new MemoryManager({ repository: new InMemoryMemoryRepository() });
    const candidates = extractCandidatesFromTestingRun({
      runId: 'test_003',
      projectId: 'prj_a',
      projectType: 'node',
      diagnosisFacts: ['FACT: the deploy token is ghp_abcdefghijklmnopqrstuv'],
    });
    expect(candidates.length).toBeGreaterThan(0);
    await expect(manager.createCandidate(candidates[0])).rejects.toThrow();
    expect(isSecretShaped('ghp_abcdefghijklmnopqrstuv')).toBe(true);
  });
});
