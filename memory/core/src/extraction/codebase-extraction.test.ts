import { describe, expect, it } from 'vitest';

import { extractCandidatesFromCodebaseAnalysis } from './index.js';

describe('codebase analysis candidate extraction (Step 16)', () => {
  it('extracts bounded structural facts with system_derived provenance', () => {
    const candidates = extractCandidatesFromCodebaseAnalysis({
      indexId: 'idx-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      languages: ['typescript', 'json'],
      frameworks: [
        { id: 'react', name: 'React' },
        { id: 'fastify', name: 'Fastify' },
      ],
      entryPointPaths: ['src/main.tsx'],
      testFilePaths: ['src/services/auth.test.ts'],
      routeCount: 3,
      componentCount: 6,
      flaggedSecretFileCount: 1,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(10);
    const technology = candidates.find((c) => c.type === 'technology');
    expect(technology?.content).toContain('React');
    expect(technology?.source).toMatchObject({ kind: 'system_derived', referenceId: 'idx-1' });
    const entry = candidates.find((c) => c.type === 'project_summary');
    expect(entry?.confidence).toBe('low');
    const testing = candidates.find((c) => c.type === 'testing_rule');
    expect(testing?.content).toContain('auth.test.ts');
    const issue = candidates.find((c) => c.type === 'known_issue');
    expect(issue?.content).toContain('never stored');
  });

  it('extracts nothing when there is nothing durable', () => {
    const candidates = extractCandidatesFromCodebaseAnalysis({
      indexId: 'idx-2',
      projectId: 'proj-1',
      languages: [],
      frameworks: [],
      entryPointPaths: [],
      testFilePaths: [],
      routeCount: 0,
      componentCount: 0,
      flaggedSecretFileCount: 0,
    });
    expect(candidates).toHaveLength(0);
  });
});
