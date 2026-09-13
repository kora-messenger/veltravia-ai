/**
 * Construction options shared by the Project Engine managers.
 */

import type {
  FileRepository,
  IntegrationRepository,
  ProjectContextRepository,
  ProjectRepository,
  WorkspaceRepository,
} from '../repositories/index.js';

/** Generates ids. Injectable so tests are deterministic; defaults use randomUUID. */
export type IdGenerator = () => string;

export function randomIdGenerator(prefix: string): IdGenerator {
  return () => {
    const uuid = globalThis.crypto.randomUUID();
    return `${prefix}_${uuid}`;
  };
}

export interface ProjectManagerOptions {
  readonly projects: ProjectRepository;
  readonly workspaces: WorkspaceRepository;
  readonly files: FileRepository;
  readonly context: ProjectContextRepository;
  readonly integrations: IntegrationRepository;
  /** Inject for deterministic tests; defaults to the real clock. */
  readonly now?: () => Date;
}

export interface WorkspaceManagerOptions {
  readonly projects: ProjectRepository;
  readonly workspaces: WorkspaceRepository;
  readonly now?: () => Date;
}

export interface FileTreeManagerOptions {
  readonly projects: ProjectRepository;
  readonly workspaces: WorkspaceRepository;
  readonly files: FileRepository;
  readonly now?: () => Date;
}

/** ISO timestamp from a clock. */
export function timestamp(now: () => Date): string {
  return now().toISOString();
}

/** Stable logical root identifier for a workspace (never a host path). */
export function workspaceRoot(workspaceId: string): string {
  return `workspace://${workspaceId}/`;
}
