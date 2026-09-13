import { describe, expect, it } from 'vitest';
import { ProjectTransitionError } from '../errors/index.js';
import {
  assertProjectTransition,
  assertWorkspaceTransition,
  canTransitionProject,
  canTransitionWorkspace,
} from './index.js';

describe('project transitions', () => {
  it('allows the legal lifecycle', () => {
    expect(() => assertProjectTransition('active', 'archived')).not.toThrow();
    expect(() => assertProjectTransition('archived', 'active')).not.toThrow();
    expect(() => assertProjectTransition('active', 'deleted')).not.toThrow();
    expect(() => assertProjectTransition('archived', 'deleted')).not.toThrow();
  });

  it('rejects deleted -> active (terminal status)', () => {
    expect(() => assertProjectTransition('deleted', 'active')).toThrow(ProjectTransitionError);
    expect(canTransitionProject('deleted', 'active')).toBe(false);
    expect(canTransitionProject('deleted', 'archived')).toBe(false);
  });

  it('rejects no-op transitions', () => {
    expect(() => assertProjectTransition('active', 'active')).toThrow(ProjectTransitionError);
  });
});

describe('workspace transitions', () => {
  it('allows the legal lifecycle', () => {
    expect(() => assertWorkspaceTransition('active', 'locked')).not.toThrow();
    expect(() => assertWorkspaceTransition('locked', 'active')).not.toThrow();
    expect(() => assertWorkspaceTransition('active', 'archived')).not.toThrow();
    expect(() => assertWorkspaceTransition('locked', 'archived')).not.toThrow();
    expect(() => assertWorkspaceTransition('archived', 'active')).not.toThrow();
  });

  it('rejects illegal transitions', () => {
    expect(canTransitionWorkspace('archived', 'locked')).toBe(false);
    expect(canTransitionWorkspace('locked', 'locked')).toBe(false);
    expect(() => assertWorkspaceTransition('archived', 'archived')).toThrow(ProjectTransitionError);
  });
});
