import { createProjectEngine, type CreateProjectEngineOptions } from '@veltravia/project-mock';
import type { ProjectEngine } from '@veltravia/project-core';

/**
 * Builds the API's Project Engine.
 *
 * Runs entirely in-memory (the persistence adapter is a later roadmap step):
 * projects, workspaces, and virtual file trees are real, validated, and
 * revision-protected, but stored per-process. No filesystem access, no
 * execution, no external calls - by design, not by omission.
 */
export function createEngine(options: CreateProjectEngineOptions = {}): ProjectEngine {
  return createProjectEngine(options);
}
