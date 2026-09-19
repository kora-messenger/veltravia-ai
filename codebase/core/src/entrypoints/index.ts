/**
 * Entry point detection (Phase 12).
 *
 * Entry points are guessed from CONVENTION and CONFIGURATION EVIDENCE with
 * explicit confidence levels - never asserted without evidence. Nothing
 * executes; this is pure static analysis.
 */

import type { DetectedEntryPoint, SourcePath } from '../types/index.js';
import { baseName } from '../languages/index.js';

/** Conventional bootstrap names -> confidence when the file exists. */
const CONVENTIONAL_ENTRY_NAMES: ReadonlyArray<{
  readonly base: string;
  readonly confidence: DetectedEntryPoint['confidence'];
}> = [
  { base: 'main.ts', confidence: 'high' },
  { base: 'main.tsx', confidence: 'high' },
  { base: 'server.ts', confidence: 'medium' },
  { base: 'server.js', confidence: 'medium' },
  { base: 'app.ts', confidence: 'medium' },
  { base: 'app.js', confidence: 'medium' },
  { base: 'index.ts', confidence: 'low' },
  { base: 'index.tsx', confidence: 'low' },
  { base: 'index.js', confidence: 'low' },
];

/** Vite convention: index.html at some directory root, plus a src entry. */
function viteEntryEvidence(paths: ReadonlySet<string>): DetectedEntryPoint[] {
  const found: DetectedEntryPoint[] = [];
  for (const path of paths) {
    if (baseName(path) === 'index.html') {
      found.push({
        filePath: path,
        confidence: 'medium',
        evidence: ['html entry document (vite-style index.html)'],
      });
    }
  }
  const srcMain = [...paths].find(
    (path) =>
      (path.startsWith('src/') || path.includes('/src/')) &&
      (baseName(path) === 'main.tsx' || baseName(path) === 'main.ts'),
  );
  if (srcMain !== undefined) {
    found.push({
      filePath: srcMain,
      confidence: 'medium',
      evidence: ['module script referenced by an html entry (vite convention src/main)'],
    });
  }
  return found;
}

export function detectEntryPoints(paths: readonly SourcePath[]): DetectedEntryPoint[] {
  const pathSet = new Set(paths);
  const results: DetectedEntryPoint[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    const name = baseName(path);
    const convention = CONVENTIONAL_ENTRY_NAMES.find((entry) => entry.base === name);
    if (convention === undefined || seen.has(path)) {
      continue;
    }
    const evidence = [`conventionally named bootstrap file "${name}"`];
    // Root or src/ level files are much stronger candidates.
    const inRootOrSrc =
      !path.includes('/') || path.startsWith('src/') || path.endsWith(`/src/${name}`);
    results.push({
      filePath: path,
      confidence: inRootOrSrc ? convention.confidence : 'low',
      evidence,
    });
    seen.add(path);
  }

  for (const candidate of viteEntryEvidence(pathSet)) {
    if (!seen.has(candidate.filePath)) {
      results.push(candidate);
      seen.add(candidate.filePath);
    }
  }

  return results;
}
