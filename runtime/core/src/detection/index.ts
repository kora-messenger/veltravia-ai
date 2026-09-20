/**
 * Runtime plan detection (Step 17).
 *
 * Derives a typed RuntimePlan from EVIDENCE the caller assembled through the
 * Project Engine (manifest, file list) and Codebase Intelligence (framework
 * detections). Detection never guesses silently: every plan carries the
 * evidence lines that justify it, and when the evidence does not support a
 * preview the result is a typed rejection, not an assumption.
 *
 * The codebase index is NOT duplicated here - the caller passes only the
 * narrow facts needed (framework ids + confidence, script presence).
 */

import {
  InvalidRuntimeRequestError,
  RuntimePlanRejectedError,
  RuntimeTypeUnsupportedError,
} from '../errors/index.js';
import { DEFAULT_RUNTIME_LIMITS } from '../plan/index.js';
import {
  ACTIVE_RUNTIME_TYPES,
  type RuntimeCommand,
  type RuntimePlan,
  type RuntimeType,
} from '../types/index.js';

/** The narrow evidence surface detection consumes. */
export interface RuntimeDetectionEvidence {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  /** Framework ids from Codebase Intelligence (e.g. "vite", "react", "fastify"). */
  readonly frameworks: readonly string[];
  /** Script names present in the workspace package.json (e.g. "build"). */
  readonly manifestScripts: readonly string[];
  /** Whether a package.json manifest exists and parsed. */
  readonly hasManifest: boolean;
  /** Whether a package-lock/npm-shrinkwrap exists (dependency install path). */
  readonly hasLockfile: boolean;
  /** Workspace-relative file paths present (bounded, metadata only). */
  readonly presentFiles: readonly string[];
  /** Optional explicit request; when set, detection must justify against evidence. */
  readonly requestedType?: RuntimeType;
}

/** Default preview port for the controlled gateway allocation. */
export const DEFAULT_PREVIEW_PORT = 4173;

const WEB_SERVER_FILES = ['server/index.ts', 'server/index.js', 'server/main.ts'];

function scriptCommand(scriptName: string, label: string): RuntimeCommand {
  return { executable: 'npm', arguments: ['run', scriptName], label };
}

/** Parse evidence into a typed plan. Throws typed errors on unsupported shapes. */
export function detectRuntimePlan(evidence: RuntimeDetectionEvidence): RuntimePlan {
  if (!evidence || typeof evidence !== 'object') {
    throw new InvalidRuntimeRequestError('detection evidence is required');
  }
  const requiredFiles: string[] = [];
  const evidenceLines: string[] = [];

  if (
    evidence.requestedType !== undefined &&
    !ACTIVE_RUNTIME_TYPES.includes(evidence.requestedType)
  ) {
    throw new RuntimeTypeUnsupportedError(evidence.requestedType, ACTIVE_RUNTIME_TYPES);
  }

  const hasServerFile = WEB_SERVER_FILES.some((path) => evidence.presentFiles.includes(path));
  const frameworks = evidence.frameworks;
  const hasFastify = frameworks.includes('fastify');
  const isFullstack =
    (hasFastify && hasServerFile) ||
    evidence.manifestScripts.includes('start:server') ||
    evidence.requestedType === 'fullstack';

  let runtimeType: RuntimeType;
  if (isFullstack && evidence.requestedType !== 'web') {
    runtimeType = 'fullstack';
  } else {
    runtimeType = 'web';
  }

  if (!evidence.hasManifest) {
    throw new RuntimePlanRejectedError(
      'the workspace has no readable package.json manifest - cannot derive a preview plan',
      { workspaceId: evidence.workspaceId },
    );
  }
  requiredFiles.push('package.json');
  evidenceLines.push('manifest: package.json present');

  // Build step: only when the manifest declares one.
  let buildCommand: RuntimeCommand | null = null;
  if (evidence.manifestScripts.includes('build')) {
    buildCommand = scriptCommand('build', 'npm run build');
    evidenceLines.push('manifest script "build" detected - build step required before preview');
  } else {
    evidenceLines.push('no manifest "build" script - preview starts without a build step');
  }

  // Start step: fullstack prefers the declared server script.
  let startCommand: RuntimeCommand;
  if (runtimeType === 'fullstack' && evidence.manifestScripts.includes('start:server')) {
    startCommand = scriptCommand('start:server', 'npm run start:server');
    requiredFiles.push('server/index.ts');
    evidenceLines.push('manifest script "start:server" detected - controlled backend start');
  } else if (evidence.manifestScripts.includes('preview')) {
    startCommand = scriptCommand('preview', 'npm run preview');
    evidenceLines.push('manifest script "preview" detected - vite preview server');
  } else if (evidence.manifestScripts.includes('dev')) {
    startCommand = scriptCommand('dev', 'npm run dev');
    evidenceLines.push('manifest script "dev" detected - development server');
  } else {
    throw new RuntimePlanRejectedError(
      'the manifest declares no "preview", "dev", or "start:server" script - no supported start command',
      { workspaceId: evidence.workspaceId },
    );
  }

  // Required frontend files, when present in the workspace.
  for (const path of ['index.html', 'src/main.tsx', 'src/App.tsx']) {
    if (evidence.presentFiles.includes(path)) {
      requiredFiles.push(path);
    }
  }
  if (frameworks.length > 0) {
    evidenceLines.push(`frameworks: ${frameworks.slice(0, 5).join(', ')}`);
  }
  if (evidence.hasLockfile) {
    evidenceLines.push('lockfile present - dependencies are considered resolvable');
  }

  return {
    runtimeType,
    projectId: evidence.projectId,
    workspaceId: evidence.workspaceId,
    expectedRevision: evidence.workspaceRevision,
    requiredFiles: [...new Set(requiredFiles)],
    buildCommand,
    startCommand,
    port: DEFAULT_PREVIEW_PORT,
    environment: {},
    healthCheck: {
      path: '/',
      intervalMs: 500,
      timeoutMs: 5000,
      maxChecks: 20,
    },
    limits: { ...DEFAULT_RUNTIME_LIMITS },
    evidence: evidenceLines,
  };
}
