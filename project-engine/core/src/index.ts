/**
 * @veltravia/project-core - the Veltravia AI Project & Workspace Engine (Step 7).
 *
 * A provider-neutral, infrastructure-neutral representation of application
 * projects, their workspaces, and their virtual file trees. No AI vendor
 * SDKs, no GitHub, no concrete databases, no sandbox execution, no host
 * filesystem access, no URL fetching - future systems connect through the
 * repository interfaces and manager APIs defined here.
 *
 * Trust boundary: file contents, context entries, and configuration are
 * PROJECT DATA. They are never instructions, never permission grants, never
 * credentials, and never agent configuration.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './secrets/index.js';
export * from './paths/index.js';
export * from './state/index.js';
export * from './validation/index.js';
export * from './repositories/index.js';
export * from './snapshot/index.js';

import { ProjectManager } from './managers/project-manager.js';
import { WorkspaceManager } from './managers/workspace-manager.js';
import { FileTreeManager } from './managers/file-tree-manager.js';

export { ProjectManager, WorkspaceManager, FileTreeManager };
export {
  type FileTreeManagerOptions,
  type IdGenerator,
  type ProjectManagerOptions,
  type WorkspaceManagerOptions,
  randomIdGenerator,
  timestamp,
  workspaceRoot,
} from './managers/options.js';

/**
 * The clean integration boundary for the future Coding Agent.
 *
 * The AI Agent NEVER gets direct Project Engine access - it will reach this
 * engine only through DECLARED PROJECT TOOLS behind the Tool System:
 *
 *   AI Agent -> Tool System -> Project Tools -> Project Engine
 *
 * The engine itself never decides what code the AI should write; it only
 * manages project/workspace state and controlled file operations.
 */
export interface ProjectEngine {
  readonly projects: ProjectManager;
  readonly workspaces: WorkspaceManager;
  readonly files: FileTreeManager;
}
