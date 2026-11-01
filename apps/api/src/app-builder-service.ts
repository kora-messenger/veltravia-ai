import {
  AppBuilderManager,
  LanguageFrameworkRegistry,
  type AppBuilderPorts,
  type CodingSessionResult,
  type EnsureProjectResult,
  type ProjectKind,
} from '@veltravia/app-builder-core';
import type { CodingAgentManager } from '@veltravia/coding-agent-core';
import type { ProjectEngine, ProjectType } from '@veltravia/project-core';

/**
 * API wiring for the App Builder (Step 30).
 *
 * The core package owns the architecture and never writes anything by itself.
 * This module supplies the real adapters:
 *
 *   projects -> the existing project & workspace engine (real files)
 *   coding   -> the existing coding agent (real runs)
 *   sandbox  -> none; the sandbox engine is simulated, so it reports that
 *   preview  -> none started by the builder yet
 *   deploy   -> no provider enabled
 *
 * Every unavailable capability answers with a reason instead of pretending.
 */

/** Project kinds the project engine knows about; anything exotic maps to `other`. */
function projectTypeFor(kind: ProjectKind): ProjectType {
  switch (kind) {
    case 'web':
      return 'web';
    case 'mobile':
      return 'mobile';
    case 'backend':
      return 'backend';
    case 'fullstack':
      return 'fullstack';
    case 'library':
      return 'library';
    default:
      return 'other';
  }
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('already exists');
}

export interface CreateAppBuilderOptions {
  readonly projectEngine: ProjectEngine;
  readonly codingAgent: CodingAgentManager;
  readonly now?: () => Date;
}

export function createAppBuilderManager(options: CreateAppBuilderOptions): AppBuilderManager {
  const now = options.now ?? (() => new Date());
  const { projectEngine, codingAgent } = options;

  const ports: AppBuilderPorts = {
    projects: {
      async ensureProject(input): Promise<EnsureProjectResult> {
        const project = await projectEngine.projects.createProject({
          name: input.name,
          description: input.description,
          projectType: projectTypeFor(input.projectKind),
          ownerRef: input.ownerRef,
          metadata: { source: 'app-builder' },
        });
        const workspaces = await projectEngine.workspaces.listWorkspaces(project.id);
        const existing = workspaces[0];
        const workspace =
          existing ??
          (await projectEngine.workspaces.createWorkspace(project.id, { name: 'main' }));
        return { projectId: project.id, workspaceId: workspace.id };
      },

      async createDirectory(workspaceId, path) {
        try {
          await projectEngine.files.createDirectory(workspaceId, path);
        } catch (error) {
          // A plan may legitimately repeat a parent directory; reuse is fine.
          if (!isAlreadyExists(error)) throw error;
        }
      },

      async createFile(workspaceId, path, content) {
        await projectEngine.files.createFile(workspaceId, { path, content });
      },

      async listFilePaths(workspaceId) {
        const nodes = await projectEngine.files.listAll(workspaceId);
        return nodes.filter((node) => node.type === 'file').map((node) => node.path);
      },

      async readFileText(workspaceId, path, maxBytes) {
        try {
          const { content } = await projectEngine.files.readFile(workspaceId, path);
          return content.length > maxBytes ? content.slice(0, maxBytes) : content;
        } catch {
          // A manifest that cannot be read simply contributes no signals.
          return undefined;
        }
      },

      async workspaceBelongsToProject(workspaceId, projectId) {
        try {
          const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
          return workspace.projectId === projectId;
        } catch {
          return false;
        }
      },
    },

    sandbox: {
      available: false,
      reason:
        'The sandbox engine is simulated in this release, so no real build or test is run. Commands come from the technology registry and are shown, not executed.',
      async run() {
        return { exitCode: null, output: '', real: false };
      },
    },

    codingAgent: {
      async startSession(request): Promise<CodingSessionResult> {
        const run = await codingAgent.startRun({
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          userRequirement: request.instruction,
        });
        return { runId: run.runId, status: run.state };
      },
    },

    preview: {
      async request() {
        return {
          available: false,
          mode: 'none',
          url: null,
          reason:
            'Preview runtimes are started from the project workspace, not automatically by the builder. Nothing is started here.',
        };
      },
    },

    deployment: {
      available: false,
      reason:
        'No deployment provider is enabled. The port exists so one can be added without changing the builder.',
      async deploy() {
        return { started: false, reason: 'No deployment provider is enabled in this release.' };
      },
    },
  };

  return new AppBuilderManager({
    registry: new LanguageFrameworkRegistry(),
    ports,
    now: () => now().toISOString(),
  });
}
