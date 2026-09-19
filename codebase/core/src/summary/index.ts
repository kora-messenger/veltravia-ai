/**
 * Codebase summary (Phase 19).
 *
 * The summary is DERIVED from indexed evidence only - the AI never
 * hallucinates it. Architecture hints are computed from framework
 * detections and structural facts (routes + components + entry points),
 * each phrased from what the index actually recorded.
 */

import type { CodebaseIndex, CodebaseSummary } from '../types/index.js';

const TEST_PATH_HINTS = ['.test.', '.spec.', '__tests__', 'tests/', '/test/'];
const CONFIG_PATH_HINTS = [
  'package.json',
  'tsconfig',
  'vite.config',
  'next.config',
  '.eslintrc',
  'eslint.config',
  'vitest.config',
  'jest.config',
  '.env',
];

function isTestPath(path: string): boolean {
  return TEST_PATH_HINTS.some((hint) => path.includes(hint));
}

function isConfigPath(path: string): boolean {
  return CONFIG_PATH_HINTS.some((hint) => path.includes(hint));
}

export function buildCodebaseSummary(index: CodebaseIndex): CodebaseSummary {
  const symbolCounts = new Map<string, number>();
  for (const symbol of index.symbols) {
    symbolCounts.set(symbol.kind, (symbolCounts.get(symbol.kind) ?? 0) + 1);
  }

  const hints: string[] = [];
  const frameworkIds = new Set(index.frameworks.map((framework) => framework.id));
  if (frameworkIds.has('react') && frameworkIds.has('vite')) {
    hints.push('React application built with Vite (SPA-style frontend detected).');
  }
  if (frameworkIds.has('react-native') || frameworkIds.has('expo')) {
    hints.push('React Native / Expo mobile application detected.');
  }
  if (frameworkIds.has('fastify') || frameworkIds.has('express')) {
    hints.push('Node.js HTTP backend detected (server-side route registration present).');
  }
  if (index.routes.length > 0) {
    hints.push(`${index.routes.length} HTTP route(s) statically detected.`);
  }
  if (index.components.length > 0) {
    hints.push(`${index.components.length} UI component(s) statically detected.`);
  }
  const failedFiles = index.files.filter((file) => file.parseStatus === 'failed');
  if (failedFiles.length > 0) {
    hints.push(`${failedFiles.length} file(s) failed to parse and are indexed as metadata only.`);
  }
  const unsupported = index.files.filter((file) => file.parseStatus === 'unsupported');
  if (unsupported.length > 0) {
    hints.push(
      `${unsupported.length} file(s) are in languages with no parser registered (metadata only).`,
    );
  }
  if (index.files.some((file) => file.flaggedSecrets)) {
    hints.push(
      'At least one indexed file contains secret-shaped content - values were never stored.',
    );
  }

  return {
    indexId: index.indexId,
    projectId: index.projectId,
    workspaceId: index.workspaceId,
    revision: index.revision,
    languages: index.languages,
    frameworks: index.frameworks,
    entryPoints: index.entryPoints,
    routes: index.routes,
    symbolCounts: [...symbolCounts.entries()]
      .map(([kind, count]) => ({
        kind: kind as CodebaseSummary['symbolCounts'][number]['kind'],
        count,
      }))
      .sort((left, right) => right.count - left.count),
    fileCount: index.fileCount,
    symbolCount: index.symbolCount,
    relationshipCount: index.relationshipCount,
    dependencyCount: index.dependencyCount,
    testFilePaths: index.files
      .filter((file) => isTestPath(file.path))
      .map((file) => file.path)
      .slice(0, 50),
    configFilePaths: index.files
      .filter((file) => isConfigPath(file.path))
      .map((file) => file.path)
      .slice(0, 50),
    architectureHints: hints,
    flaggedSecretFileCount: index.files.filter((file) => file.flaggedSecrets).length,
    createdAt: index.updatedAt,
  };
}
