/**
 * Framework/technology detection (Phase 6).
 *
 * Every detection needs a CONCRETE signal: a dependency name in package.json,
 * a known configuration file, or a known import specifier in parsed source.
 * No detection is ever asserted without recorded evidence, and confidence
 * is explicit. Signals are conservative - unknown patterns produce nothing
 * rather than a guess.
 */

import type { FrameworkDetection, SourcePath } from '../types/index.js';
import { baseName } from '../languages/index.js';

/** Parsed package.json dependency map (name -> version). */
export interface PackageJsonFacts {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** Files whose BASE NAME signals a technology regardless of directory. */
const CONFIG_SIGNALS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly match: readonly string[];
  readonly evidence: string;
}> = [
  {
    id: 'vite',
    name: 'Vite',
    match: ['vite.config.ts', 'vite.config.js', 'vite.config.mts'],
    evidence: 'vite configuration file present',
  },
  {
    id: 'next',
    name: 'Next.js',
    match: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    evidence: 'next.js configuration file present',
  },
  {
    id: 'expo',
    name: 'Expo',
    match: ['app.json', 'app.config.js', 'app.config.ts'],
    evidence: 'expo-style app configuration present',
  },
  {
    id: 'tsconfig',
    name: 'TypeScript',
    match: ['tsconfig.json'],
    evidence: 'typescript configuration present',
  },
  {
    id: 'npm',
    name: 'Node.js',
    match: ['package.json'],
    evidence: 'node.js package manifest present',
  },
];

/** Dependency names that signal a technology. */
const DEPENDENCY_SIGNALS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly packages: readonly string[];
}> = [
  { id: 'react', name: 'React', packages: ['react'] },
  { id: 'react-native', name: 'React Native', packages: ['react-native'] },
  { id: 'vite', name: 'Vite', packages: ['vite'] },
  { id: 'fastify', name: 'Fastify', packages: ['fastify'] },
  { id: 'express', name: 'Express', packages: ['express'] },
  { id: 'next', name: 'Next.js', packages: ['next'] },
  { id: 'expo', name: 'Expo', packages: ['expo'] },
  { id: 'typescript', name: 'TypeScript', packages: ['typescript'] },
  { id: 'vitest', name: 'Vitest', packages: ['vitest'] },
  { id: 'jest', name: 'Jest', packages: ['jest'] },
];

/** Import specifiers seen in parsed source that signal a technology. */
const IMPORT_SIGNALS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly specifier: string;
}> = [
  { id: 'react', name: 'React', specifier: 'react' },
  { id: 'react', name: 'React', specifier: 'react-dom' },
  { id: 'fastify', name: 'Fastify', specifier: 'fastify' },
  { id: 'express', name: 'Express', specifier: 'express' },
  { id: 'react-native', name: 'React Native', specifier: 'react-native' },
  { id: 'expo', name: 'Expo', specifier: 'expo' },
];

export interface DetectFrameworksInput {
  readonly paths: readonly SourcePath[];
  readonly packageJsonFacts?: PackageJsonFacts;
  /** External import specifiers observed across parsed files. */
  readonly externalImports: ReadonlySet<string>;
}

export function detectFrameworks(input: DetectFrameworksInput): FrameworkDetection[] {
  const byId = new Map<string, FrameworkDetection>();
  const add = (
    id: string,
    name: string,
    evidence: string,
    confidence: FrameworkDetection['confidence'],
  ): void => {
    const existing = byId.get(id);
    if (existing !== undefined) {
      byId.set(id, {
        ...existing,
        evidence: existing.evidence.includes(evidence)
          ? existing.evidence
          : [...existing.evidence, evidence],
        // Confidence only ever strengthens with more evidence.
        confidence:
          confidence === 'high' || existing.confidence === 'high'
            ? 'high'
            : confidence === 'medium' || existing.confidence === 'medium'
              ? 'medium'
              : 'low',
      });
      return;
    }
    byId.set(id, { id, name, evidence: [evidence], confidence });
  };

  for (const path of input.paths) {
    const name = baseName(path);
    for (const signal of CONFIG_SIGNALS) {
      if (signal.match.includes(name)) {
        add(signal.id, signal.name, `${signal.evidence} (${name})`, 'medium');
      }
    }
  }

  if (input.packageJsonFacts !== undefined) {
    const allDeps = [
      ...Object.entries(input.packageJsonFacts.dependencies ?? {}),
      ...Object.entries(input.packageJsonFacts.devDependencies ?? {}),
    ];
    for (const [depName] of allDeps) {
      for (const signal of DEPENDENCY_SIGNALS) {
        if (signal.packages.includes(depName)) {
          add(signal.id, signal.name, `declared dependency "${depName}" in package.json`, 'high');
        }
      }
    }
  }

  for (const specifier of input.externalImports) {
    for (const signal of IMPORT_SIGNALS) {
      if (specifier === signal.specifier || specifier.startsWith(`${signal.specifier}/`)) {
        add(signal.id, signal.name, `imported from "${specifier}" in source`, 'medium');
      }
    }
  }

  return [...byId.values()];
}
