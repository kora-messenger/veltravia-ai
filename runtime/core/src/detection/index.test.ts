import { describe, expect, it } from 'vitest';
import {
  detectRuntimePlan,
  RuntimePlanRejectedError,
  RuntimeTypeUnsupportedError,
  type RuntimeDetectionEvidence,
} from '@veltravia/runtime-core';

function evidence(overrides: Partial<RuntimeDetectionEvidence> = {}): RuntimeDetectionEvidence {
  return {
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    workspaceRevision: 5,
    frameworks: ['vite', 'react'],
    manifestScripts: ['dev', 'build', 'preview'],
    hasManifest: true,
    hasLockfile: true,
    presentFiles: ['package.json', 'index.html', 'src/main.tsx', 'src/App.tsx'],
    ...overrides,
  };
}

describe('runtime plan detection', () => {
  it('derives a vite web plan: build + preview', () => {
    const plan = detectRuntimePlan(evidence());
    expect(plan.runtimeType).toBe('web');
    expect(plan.buildCommand).toEqual({
      executable: 'npm',
      arguments: ['run', 'build'],
      label: 'npm run build',
    });
    expect(plan.startCommand.arguments).toEqual(['run', 'preview']);
    expect(plan.port).toBe(4173);
    expect(plan.expectedRevision).toBe(5);
    expect(plan.evidence.join(' ')).toContain('vite');
  });

  it('falls back to the dev script when preview is absent', () => {
    const plan = detectRuntimePlan(evidence({ manifestScripts: ['dev'] }));
    expect(plan.startCommand.arguments).toEqual(['run', 'dev']);
  });

  it('detects fullstack from fastify evidence + server file', () => {
    const plan = detectRuntimePlan(
      evidence({
        frameworks: ['vite', 'react', 'fastify'],
        manifestScripts: ['dev', 'build', 'start:server'],
        presentFiles: [...evidence().presentFiles, 'server/index.ts'],
      }),
    );
    expect(plan.runtimeType).toBe('fullstack');
    expect(plan.startCommand.arguments).toEqual(['run', 'start:server']);
    expect(plan.requiredFiles).toContain('server/index.ts');
  });

  it('prefers preview even for fullstack when start:server is absent', () => {
    const plan = detectRuntimePlan(
      evidence({
        manifestScripts: ['dev', 'build', 'preview'],
        presentFiles: [...evidence().presentFiles, 'server/index.ts'],
      }),
    );
    expect(plan.startCommand.arguments).toEqual(['run', 'preview']);
  });

  it('skips the build step when the manifest has no build script', () => {
    const plan = detectRuntimePlan(evidence({ manifestScripts: ['preview'] }));
    expect(plan.buildCommand).toBeNull();
  });

  it('rejects a workspace without a manifest', () => {
    expect(() => detectRuntimePlan(evidence({ hasManifest: false }))).toThrow(
      RuntimePlanRejectedError,
    );
  });

  it('rejects a manifest with no supported start script', () => {
    expect(() => detectRuntimePlan(evidence({ manifestScripts: ['lint'] }))).toThrow(
      RuntimePlanRejectedError,
    );
  });

  it('rejects explicitly requested inactive types', () => {
    expect(() => detectRuntimePlan(evidence({ requestedType: 'mobile-preview' }))).toThrow(
      RuntimeTypeUnsupportedError,
    );
  });

  it('requires evidence at all', () => {
    expect(() => detectRuntimePlan(undefined as never)).toThrow();
  });

  it('honors an explicit web request over fullstack inference', () => {
    const plan = detectRuntimePlan(
      evidence({ requestedType: 'web', manifestScripts: ['dev', 'build', 'start:server'] }),
    );
    expect(plan.runtimeType).toBe('web');
  });
});
