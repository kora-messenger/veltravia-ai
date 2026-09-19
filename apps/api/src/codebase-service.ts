/**
 * API codebase service (Step 16).
 *
 * Binds the Codebase Intelligence core to the API process:
 * - EngineSourceProvider adapts the Project Engine (FileTreeManager) to
 *   the core's CodebaseSourceProvider port. This is the ONLY seam: the
 *   analysis core never touches the host filesystem, and everything it
 *   reads is already-authorized project data.
 * - Safe response mapping: index views NEVER include raw source content -
 *   only paths, metadata, symbols, and bounded evidence. For source
 *   content, the existing authorized Project Engine routes remain the
 *   single pathway.
 */

import {
  CodebaseIntelligenceManager,
  type CodebaseIndex,
  type CodebaseSourceProvider,
  type SourceFileMeta,
} from '@veltravia/codebase-core';
import { InMemoryCodebaseIndexRepository } from '@veltravia/codebase-mock';
import type { ProjectEngine } from '@veltravia/project-core';

/**
 * Source provider adapter over the Project Engine. Read-only: listAll +
 * readFile + workspace revision. No mutations ever flow through here.
 */
export class EngineSourceProvider implements CodebaseSourceProvider {
  private readonly engine: ProjectEngine;

  constructor(engine: ProjectEngine) {
    this.engine = engine;
  }

  async listFiles(workspaceId: string): Promise<readonly SourceFileMeta[]> {
    const nodes = await this.engine.files.listAll(workspaceId);
    return nodes
      .filter((node) => node.type === 'file')
      .map((node) => ({
        path: node.path,
        size: node.size,
        revision: node.revision,
        type: 'file' as const,
      }));
  }

  async readFileContent(workspaceId: string, path: string): Promise<string> {
    const result = await this.engine.files.readFile(workspaceId, path);
    return result.content;
  }

  async workspaceRevision(workspaceId: string): Promise<number> {
    const workspace = await this.engine.workspaces.getWorkspace(workspaceId);
    return workspace.revision;
  }
}

/** Bounded safe view of a stored index - never symbols/relationships arrays wholesale. */
export interface CodebaseIndexResponse {
  readonly indexId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: string;
  readonly buildState: string;
  readonly languages: readonly string[];
  readonly frameworks: readonly {
    readonly id: string;
    readonly name: string;
    readonly confidence: string;
    readonly evidence: readonly string[];
  }[];
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationshipCount: number;
  readonly dependencyCount: number;
  readonly routeCount: number;
  readonly componentCount: number;
  readonly entryPointCount: number;
  readonly failedFileCount: number;
  readonly unsupportedFileCount: number;
  readonly flaggedSecretFileCount: number;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Bounded file list (safe metadata only). */
  readonly files: readonly {
    readonly path: string;
    readonly language: string | null;
    readonly size: number;
    readonly parseStatus: string;
    readonly parseNote?: string;
    readonly flaggedSecrets: boolean;
  }[];
}

const MAX_FILES_IN_VIEW = 200;

export function toCodebaseIndexResponse(index: CodebaseIndex): CodebaseIndexResponse {
  return {
    indexId: index.indexId,
    projectId: index.projectId,
    workspaceId: index.workspaceId,
    revision: index.revision,
    status: index.status,
    buildState: index.buildState,
    languages: index.languages,
    frameworks: index.frameworks.map((framework) => ({
      id: framework.id,
      name: framework.name,
      confidence: framework.confidence,
      evidence: framework.evidence,
    })),
    fileCount: index.fileCount,
    symbolCount: index.symbolCount,
    relationshipCount: index.relationshipCount,
    dependencyCount: index.dependencyCount,
    routeCount: index.routes.length,
    componentCount: index.components.length,
    entryPointCount: index.entryPoints.length,
    failedFileCount: index.files.filter((file) => file.parseStatus === 'failed').length,
    unsupportedFileCount: index.files.filter((file) => file.parseStatus === 'unsupported').length,
    flaggedSecretFileCount: index.files.filter((file) => file.flaggedSecrets).length,
    failure: index.failure ?? null,
    createdAt: index.createdAt,
    updatedAt: index.updatedAt,
    files: index.files.slice(0, MAX_FILES_IN_VIEW).map((file) => ({
      path: file.path,
      language: file.language,
      size: file.size,
      parseStatus: file.parseStatus,
      ...(file.parseNote !== undefined ? { parseNote: file.parseNote } : {}),
      flaggedSecrets: file.flaggedSecrets,
    })),
  };
}

export function createCodebaseManager(engine: ProjectEngine): CodebaseIntelligenceManager {
  return new CodebaseIntelligenceManager({
    provider: new EngineSourceProvider(engine),
    repository: new InMemoryCodebaseIndexRepository(),
  });
}
