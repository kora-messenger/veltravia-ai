import type { CodebaseIntelligenceManager } from '@veltravia/codebase-core';
import type { ProjectEngine } from '@veltravia/project-core';
import {
  RuntimeManager,
  type RuntimeEvidenceProvider,
  type RuntimeWorkspaceGateway,
} from '@veltravia/runtime-core';
import { createMockRuntimeExecutor } from '@veltravia/runtime-mock';

/**
 * Builds the API's RuntimeManager (Step 17).
 *
 * The runtime layer ships the SIMULATED MockRuntimeExecutor: it builds and
 * serves nothing and provides NO OS-level isolation - development/CI
 * configuration only. A production executor (container / microVM /
 * dedicated worker) later implements the same RuntimeExecutor interface;
 * nothing else changes.
 *
 * The gateway + evidence provider adapt the REAL Project Engine and
 * Codebase Intelligence (Step 16): ownership and revisions are always
 * resolved server-side, never trusted from the browser.
 */
export function createRuntimeManager(options: {
  projectEngine: ProjectEngine;
  codebase: CodebaseIntelligenceManager;
  now?: () => Date;
  auditSink?: (event: unknown) => void;
}): RuntimeManager {
  const { projectEngine, codebase } = options;

  const gateway: RuntimeWorkspaceGateway = {
    async getWorkspace(workspaceId: string) {
      // getWorkspace throws a typed ProjectError for unknown ids (API maps to 404).
      const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
      return {
        projectId: workspace.projectId,
        revision: workspace.revision,
        status: workspace.status,
      };
    },
    async listWorkspaceFiles(workspaceId: string) {
      const nodes = await projectEngine.files.listAll(workspaceId);
      return nodes.filter((node) => node.type === 'file').map((node) => node.path);
    },
    async projectExists(projectId: string) {
      try {
        const project = await projectEngine.projects.getProject(projectId);
        return project.status !== 'deleted';
      } catch {
        return false;
      }
    },
  };

  const KNOWN_FRAMEWORK_DEPENDENCIES = [
    'vite',
    'react',
    'react-dom',
    'fastify',
    'express',
    'next',
    'vue',
    'svelte',
  ];

  const evidenceProvider: RuntimeEvidenceProvider = async (workspaceId, requestedType) => {
    const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
    const nodes = await projectEngine.files.listAll(workspaceId);
    const filePaths = nodes.filter((node) => node.type === 'file').map((node) => node.path);

    // Manifest evidence: read through the Project Engine (an already-authorized
    // project file read), never from the host filesystem.
    let hasManifest = false;
    let manifestScripts: string[] = [];
    let manifestDependencies: string[] = [];
    if (filePaths.includes('package.json')) {
      try {
        const { content } = await projectEngine.files.readFile(workspaceId, 'package.json');
        const parsed = JSON.parse(content) as {
          scripts?: Record<string, unknown>;
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
        };
        hasManifest = true;
        manifestScripts = Object.keys(parsed.scripts ?? {}).filter(
          (key) => typeof parsed.scripts?.[key] === 'string',
        );
        manifestDependencies = [
          ...Object.keys(parsed.dependencies ?? {}),
          ...Object.keys(parsed.devDependencies ?? {}),
        ];
      } catch {
        hasManifest = false;
      }
    }

    // Framework evidence: prefer the Codebase Intelligence index when one is
    // COMPLETED and CURRENT; fall back to manifest dependency names (still
    // file evidence, never a silent guess).
    let frameworks: string[] = [];
    try {
      const index = await codebase.getIndex(workspace.projectId, workspaceId);
      if (index.status === 'current' && index.revision === workspace.revision) {
        frameworks = index.frameworks.map((detection) => detection.id);
      }
    } catch {
      frameworks = [];
    }
    if (frameworks.length === 0) {
      frameworks = KNOWN_FRAMEWORK_DEPENDENCIES.filter((dependency) =>
        manifestDependencies.some(
          (name) => name === dependency || name.startsWith(`${dependency}@`),
        ),
      );
    }

    return {
      projectId: workspace.projectId,
      workspaceId,
      workspaceRevision: workspace.revision,
      frameworks,
      manifestScripts,
      hasManifest,
      hasLockfile: filePaths.some(
        (path) => path === 'package-lock.json' || path === 'npm-shrinkwrap.json',
      ),
      presentFiles: filePaths,
      ...(requestedType !== undefined ? { requestedType } : {}),
    };
  };

  return new RuntimeManager({
    executor: createMockRuntimeExecutor(),
    gateway,
    evidenceProvider,
    ...(options.now !== undefined ? { now: () => options.now!() } : {}),
    ...(options.auditSink !== undefined ? { auditSink: options.auditSink } : {}),
    projectNameProvider: async (projectId) => {
      try {
        const project = await projectEngine.projects.getProject(projectId);
        return project.name;
      } catch {
        return projectId;
      }
    },
  });
}
