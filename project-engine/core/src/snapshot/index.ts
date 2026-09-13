/**
 * Deterministic, serializable, secret-free project snapshots.
 *
 * Deterministic: identical state produces an identical snapshot (all arrays
 * sorted, stable key order). Serializable: plain JSON, no class instances.
 * Secret-free: metadata is scrubbed as defense in depth - secret-shaped
 * content is rejected at write time, so it can never reach a snapshot.
 */

import type {
  FileNode,
  IntegrationReference,
  Project,
  ProjectConfig,
  ProjectContext,
  ProjectSnapshot,
  SnapshotFileNode,
  SnapshotWorkspace,
  Workspace,
} from '../types/index.js';
import { scrubProjectMetadata } from '../errors/index.js';

/** Strips revision/updatedAt bookkeeping from a config (snapshot-safe form). */
export function stripConfigMeta(
  config: ProjectConfig,
): Omit<ProjectConfig, 'revision' | 'updatedAt'> {
  const out: Record<string, unknown> = {
    ...(config.framework !== undefined ? { framework: config.framework } : {}),
    ...(config.language !== undefined ? { language: config.language } : {}),
    ...(config.runtime !== undefined ? { runtime: config.runtime } : {}),
    ...(config.packageManager !== undefined ? { packageManager: config.packageManager } : {}),
    ...(config.buildCommand !== undefined ? { buildCommand: config.buildCommand } : {}),
    ...(config.testCommand !== undefined ? { testCommand: config.testCommand } : {}),
    ...(config.lintCommand !== undefined ? { lintCommand: config.lintCommand } : {}),
    entryPoints: [...config.entryPoints],
  };
  return out as Omit<ProjectConfig, 'revision' | 'updatedAt'>;
}

/** Strips revision/updatedAt bookkeeping from a context (snapshot-safe form). */
export function stripContextMeta(
  context: ProjectContext,
): Omit<ProjectContext, 'revision' | 'updatedAt'> {
  return {
    goals: [...context.goals],
    technologyPreferences: [...context.technologyPreferences],
    architectureNotes: [...context.architectureNotes],
    buildPreferences: [...context.buildPreferences],
    userInstructions: [...context.userInstructions],
    decisions: context.decisions.map((decision) => ({
      summary: decision.summary,
      ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
      ...(decision.decidedAt !== undefined ? { decidedAt: decision.decidedAt } : {}),
    })),
  };
}

/** File-tree METADATA only - file contents never enter snapshots. */
export function buildSnapshotWorkspace(
  workspace: Workspace,
  nodes: readonly FileNode[],
): SnapshotWorkspace {
  const sortedNodes: SnapshotFileNode[] = [...nodes]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((node) => ({
      path: node.path,
      type: node.type,
      size: node.size,
      revision: node.revision,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    }));
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    root: workspace.root,
    revision: workspace.revision,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    metadata: scrubProjectMetadata(workspace.metadata as Record<string, unknown>),
    nodes: sortedNodes,
  };
}

/**
 * Builds the full project snapshot. Callers supply the (already-sorted or
 * unsorted) pieces; everything is sorted and scrubbed here, so the output
 * is byte-for-byte identical for identical state.
 */
export function buildSnapshot(input: {
  readonly project: Project;
  readonly workspaces: readonly SnapshotWorkspace[];
  readonly config: Omit<ProjectConfig, 'revision' | 'updatedAt'> | null;
  readonly context: Omit<ProjectContext, 'revision' | 'updatedAt'> | null;
  readonly integrations: readonly IntegrationReference[];
}): ProjectSnapshot {
  return {
    project: {
      id: input.project.id,
      name: input.project.name,
      description: input.project.description,
      status: input.project.status,
      projectType: input.project.projectType,
      ownerRef: input.project.ownerRef,
      version: input.project.version,
      revision: input.project.revision,
      createdAt: input.project.createdAt,
      updatedAt: input.project.updatedAt,
      metadata: scrubProjectMetadata(input.project.metadata as Record<string, unknown>),
    },
    workspaces: [...input.workspaces].sort((a, b) => (a.id < b.id ? -1 : 1)),
    config: input.config,
    context: input.context,
    integrations: [...input.integrations].sort((a, b) =>
      a.integrationRef < b.integrationRef ? -1 : a.integrationRef > b.integrationRef ? 1 : 0,
    ),
  };
}
