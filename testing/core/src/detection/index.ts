/**
 * Deterministic, bounded project detection. The detector lists the workspace
 * tree and reads ONLY the package manifest (bounded, untrusted project data)
 * through the Project Engine - never the host filesystem. It maps structural
 * signals to the supported project types and derives the validation/test
 * commands as STRUCTURAL commands (bare executable + typed arguments).
 */

import { TestingError, isSecretShaped } from '../errors/index.js';
import {
  type DetectionSignal,
  type ProjectDetection,
  type SupportedProjectType,
  type TestCommand,
} from '../types/index.js';

/** The manifest the detector reads (project data - untrusted, bounded). */
export const MANIFEST_PATH = 'package.json';

const MAX_MANIFEST_BYTES = 65_536;

/** Script values this detector can derive commands from (defense-in-depth;
 * the sandbox command policy remains the real gate). */
const KNOWN_EXECUTABLES = new Set(['node', 'npm', 'npx', 'tsc', 'vitest']);

const TEST_DIRECTORIES = ['test', 'tests', '__tests__', 'spec', 'src/__tests__'] as const;

export interface FileNodeView {
  readonly path: string;
  readonly type: 'file' | 'directory';
}

export interface DetectionInput {
  readonly nodes: readonly FileNodeView[];
  /** Parsed package manifest (untrusted project data) - null when absent/broken. */
  readonly manifest: unknown;
  readonly manifestBytes: number | null;
}

export interface DetectionResult {
  readonly detection: ProjectDetection;
  readonly commands: readonly TestCommand[];
}

/** Parses a manifest script value into a structural command, or null. */
export function parseScriptCommand(scriptName: string, rawScript: string): TestCommand | null {
  const script = rawScript.trim();
  if (script.length === 0 || script.length > 1024) return null;
  // No shells exist in this architecture; still reject shell-shaped scripts
  // outright so they can never smuggle process chaining.
  if (/[;&|`$><\\\n]/.test(script)) return null;
  const tokens = script.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > 16) return null;
  const executable = tokens[0] ?? '';
  if (!KNOWN_EXECUTABLES.has(executable)) return null;
  const args = tokens.slice(1).filter((token) => token !== '');
  if (args.some((arg) => arg.includes('\u0000') || isSecretShaped(arg))) return null;
  return {
    executable,
    arguments: args,
    purpose: 'test',
    label: `npm script "${scriptName}"`,
    scriptName,
  };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

/**
 * Detects the project type and derives the TestPlan commands from the tree
 * and the manifest. Deterministic: the same input always yields the same
 * output. When evidence is insufficient, the notes say so honestly.
 */
export function detectProject(input: DetectionInput): DetectionResult {
  const signals: DetectionSignal[] = [];
  const notes: string[] = [];

  const paths = new Set(input.nodes.map((node) => node.path));
  const directories = new Set(
    input.nodes.filter((node) => node.type === 'directory').map((node) => node.path),
  );

  // Structural signals from the tree only.
  const hasManifest = paths.has(MANIFEST_PATH);
  if (hasManifest) {
    signals.push({ kind: 'package-manifest', detail: MANIFEST_PATH });
  } else {
    notes.push(`no ${MANIFEST_PATH} found in the workspace root`);
  }
  if (paths.has('tsconfig.json')) {
    signals.push({ kind: 'typescript-config', detail: 'tsconfig.json' });
  }
  const viteConfig = ['vite.config.ts', 'vite.config.js'].find((config) => paths.has(config));
  if (viteConfig !== undefined) {
    signals.push({ kind: 'vite-config', detail: viteConfig });
  }
  for (const testDirectory of TEST_DIRECTORIES) {
    if (directories.has(testDirectory) || paths.has(`${testDirectory.replace('__', '')}`)) {
      if (directories.has(testDirectory)) {
        signals.push({ kind: 'test-directory', detail: testDirectory });
        break;
      }
    }
  }

  // Manifest content is UNTRUSTED project data: parsed defensively, bounded,
  // never treated as instructions, and never executed.
  let testScript: string | null = null;
  let buildScript: string | null = null;
  let hasReact = false;
  let hasFastify = false;

  if (input.manifestBytes !== null && input.manifestBytes > MAX_MANIFEST_BYTES) {
    notes.push('the package manifest is too large to read; detection used the tree only');
  }
  if (
    input.manifest !== null &&
    typeof input.manifest === 'object' &&
    !Array.isArray(input.manifest) &&
    !isSecretShaped(JSON.stringify(input.manifest).slice(0, 2048))
  ) {
    const manifest = input.manifest as Record<string, unknown>;
    const scripts =
      typeof manifest.scripts === 'object' && manifest.scripts !== null
        ? (manifest.scripts as Record<string, unknown>)
        : {};
    testScript = readString(scripts, 'test');
    buildScript = readString(scripts, 'build');
    if (testScript !== null) {
      signals.push({ kind: 'test-script', detail: 'test' });
    }
    const dependencies =
      typeof manifest.dependencies === 'object' && manifest.dependencies !== null
        ? (manifest.dependencies as Record<string, unknown>)
        : {};
    const devDependencies =
      typeof manifest.devDependencies === 'object' && manifest.devDependencies !== null
        ? (manifest.devDependencies as Record<string, unknown>)
        : {};
    const allDependencies = { ...dependencies, ...devDependencies };
    hasReact = Object.keys(allDependencies).some((name) => name === 'react' || name === 'vite');
    hasFastify = Object.keys(allDependencies).some(
      (name) => name === 'fastify' || name === 'express',
    );
    const hasNode = Object.keys(allDependencies).length > 0 || manifest.main !== undefined;
    if (hasReact) {
      signals.push({ kind: 'react-dependency', detail: 'react/vite in the manifest' });
    }
    if (hasFastify) {
      signals.push({ kind: 'fastify-dependency', detail: 'fastify/express in the manifest' });
    }
    if (hasNode || scripts !== undefined) {
      signals.push({ kind: 'node-runtime', detail: 'Node.js package manifest' });
    }
  } else if (hasManifest) {
    notes.push('the package manifest could not be parsed as a JSON object');
  }

  let projectType: SupportedProjectType;
  if (hasReact && hasFastify) {
    projectType = 'fullstack';
  } else if (hasReact) {
    projectType = 'web';
  } else if (hasFastify || hasManifest) {
    projectType = 'backend';
    if (!hasFastify) {
      notes.push('no recognized framework; classified as a plain Node backend project');
    }
  } else {
    projectType = 'unknown';
    notes.push('the project type could not be determined from the observed signals');
  }

  // Command derivation: only from manifest scripts, only structural.
  const commands: TestCommand[] = [];
  if (testScript !== null) {
    const command = parseScriptCommand('test', testScript);
    if (command === null) {
      notes.push('the "test" script is not a derivable bare command; no test command was planned');
    } else {
      commands.push(command);
    }
  } else if (projectType !== 'unknown') {
    notes.push('no "test" script found; only validation was planned');
  }
  if (buildScript !== null) {
    const command = parseScriptCommand('build', buildScript);
    if (command !== null) {
      commands.push({ ...command, purpose: 'build', label: `npm script "build"` });
    }
  }

  const framework =
    hasReact && hasFastify
      ? 'React + Fastify'
      : hasReact
        ? 'React'
        : hasFastify
          ? 'Fastify/Express'
          : null;
  const detection: ProjectDetection = {
    projectType,
    signals,
    framework,
    runtime: hasManifest ? 'node' : null,
    testScript,
    buildScript,
    manifestPath: hasManifest ? MANIFEST_PATH : null,
    notes,
  };
  return { detection, commands };
}

/** Re-derives a script command from the CURRENT manifest (retest honesty). */
export function rederiveScriptCommand(scriptName: string, manifest: unknown): TestCommand | null {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return null;
  }
  const scripts =
    typeof (manifest as Record<string, unknown>).scripts === 'object' &&
    (manifest as Record<string, unknown>).scripts !== null
      ? ((manifest as Record<string, unknown>).scripts as Record<string, unknown>)
      : {};
  const raw = readString(scripts, scriptName);
  if (raw === null) return null;
  const command = parseScriptCommand(scriptName, raw);
  if (command === null) {
    throw new TestingError(
      'TESTING_INVALID_PLAN',
      `the current "${scriptName}" script is no longer a derivable bare command`,
    );
  }
  return command;
}
