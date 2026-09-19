/**
 * Bounded language detection (Phase 5).
 *
 * Detection is by file extension ONLY - explicit, honest, and cheap. Files
 * whose extension maps to no supported language are reported as
 * `unsupported`; the system never pretends to parse a language it cannot.
 * New languages are added by widening the extension map - a deliberate,
 * reviewed change.
 */

import type { SourceLanguage, SourcePath } from '../types/index.js';

/** Supported extension -> language map (lowercase, no dot). */
const EXTENSION_LANGUAGE: Readonly<Record<string, SourceLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
};

export function extensionOf(path: SourcePath): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

/** Detected language for a path, or `null` when unsupported/unknown. */
export function detectLanguage(path: SourcePath): SourceLanguage | null {
  return EXTENSION_LANGUAGE[extensionOf(path)] ?? null;
}

/** Whether the language gets a real AST parse (typescript/javascript). */
export function isParsedLanguage(language: SourceLanguage | null): boolean {
  return language === 'typescript' || language === 'javascript';
}

/** Basename helper shared by framework and entry-point detection. */
export function baseName(path: SourcePath): string {
  return path.split('/').pop() ?? path;
}

/** Directory part of a workspace-relative path ('' for root-level files). */
export function directoryOf(path: SourcePath): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
