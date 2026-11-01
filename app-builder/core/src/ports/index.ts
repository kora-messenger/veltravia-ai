/**
 * Ports the App Builder depends on (Step 30).
 *
 * Every capability the builder needs from the rest of Veltravia is an interface
 * here, so the builder owns no storage, no execution and no network of its own:
 *
 *   projects  -> @veltravia/project-core (existing project & workspace engine)
 *   sandbox   -> @veltravia/sandbox-core   (simulated in this release)
 *   coding    -> @veltravia/coding-agent-core (existing run pipeline)
 *   preview   -> @veltravia/runtime-core   (existing preview runtimes)
 *   deploy    -> no implementation in this release
 *
 * Adapters live in the API layer. That keeps this package free of Fastify,
 * filesystem access and vendor SDKs, and keeps "which runtime answers" a
 * deployment decision rather than a code decision.
 */

import type { ProjectKind } from '../types/index.js';

export interface EnsureProjectInput {
  readonly ownerRef: string;
  readonly name: string;
  readonly description: string;
  readonly projectKind: ProjectKind;
}

export interface EnsureProjectResult {
  readonly projectId: string;
  readonly workspaceId: string;
}

/** File and project operations, backed by the real project engine in the API. */
export interface ProjectFilesPort {
  /** Creates (or reuses) a project and its first workspace. */
  ensureProject(input: EnsureProjectInput): Promise<EnsureProjectResult>;
  createDirectory(workspaceId: string, path: string): Promise<void>;
  createFile(workspaceId: string, path: string, content: string): Promise<void>;
  /** Every file path in the workspace, for detection. Directories excluded. */
  listFilePaths(workspaceId: string): Promise<readonly string[]>;
  /** Reads a manifest file's text, truncated, for dependency signals. */
  readFileText(workspaceId: string, path: string, maxBytes: number): Promise<string | undefined>;
  /** Confirms a workspace belongs to a project, so a mismatch cannot be staged. */
  workspaceBelongsToProject(workspaceId: string, projectId: string): Promise<boolean>;
}

export interface SandboxRunRequest {
  readonly workspaceId: string;
  readonly argv: readonly string[];
  readonly maxSeconds: number;
}

export interface SandboxRunResult {
  readonly exitCode: number | null;
  readonly output: string;
  /** False when the sandbox is simulated, so callers never claim a real build. */
  readonly real: boolean;
}

/**
 * Build and test execution. `available` is false in this release: the sandbox
 * engine is simulated, and reporting a simulated build as a real one would be
 * exactly the kind of lie this architecture exists to prevent.
 */
export interface SandboxPort {
  readonly available: boolean;
  readonly reason: string;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export interface CodingSessionRequest {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly instruction: string;
}

export interface CodingSessionResult {
  readonly runId: string;
  readonly status: string;
}

/** Delegates to the existing coding agent rather than re-implementing it. */
export interface CodingAgentPort {
  startSession(request: CodingSessionRequest): Promise<CodingSessionResult>;
}

export interface PreviewRequest {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface PreviewResult {
  readonly available: boolean;
  readonly mode: string;
  readonly url: string | null;
  readonly reason: string;
}

export interface PreviewPort {
  request(request: PreviewRequest): Promise<PreviewResult>;
}

export interface DeploymentRequest {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly target: string;
}

export interface DeploymentResult {
  readonly started: boolean;
  readonly reason: string;
}

/** No deployment provider is enabled in this release. */
export interface DeploymentPort {
  readonly available: boolean;
  readonly reason: string;
  deploy(request: DeploymentRequest): Promise<DeploymentResult>;
}
