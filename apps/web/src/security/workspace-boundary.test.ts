/**
 * Frontend credential/trust boundary (Step 11C-2).
 *
 * Static scans that keep the browser a pure presentation client:
 * - no provider SDK imports, provider endpoints, or credential literals in
 *   web source
 * - no environment reads (credentials must not enter frontend env vars)
 * - no unsafe HTML rendering of model/user output
 * - no browser persistence of credential-shaped keys
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));

function collectFiles(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...collectFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      // Scan production source only - test files legitimately assert on
      // these patterns as literals.
      entries.push(full);
    }
  }
  return entries;
}

/** The ONLY value the web app persists; everything else is suspect. */
const PERSISTED_STORAGE_KEYS = new Set(['veltravia.theme-preference']);

describe('frontend credential boundary', () => {
  const files = collectFiles(WEB_SRC);

  it('scans a non-empty source tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no provider SDKs, provider endpoints, or credential literals', () => {
    const forbidden = [
      /@google\/genai/,
      /generativelanguage\.googleapis\.com/,
      /api\.openai\.com/,
      /GEMINI_API_KEY/,
      /OPENAI_API_KEY/,
      /ANTHROPIC_API_KEY/,
      /OPENROUTER/,
      /\bsk-[A-Za-z0-9]{8,}\b/,
      /ghp_[A-Za-z0-9]/,
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('reads no environment variables (credentials never enter frontend env)', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} reads process.env`).not.toMatch(/process\.env/);
      expect(source, `${file} reads import.meta.env`).not.toMatch(/import\.meta\.env/);
    }
  });

  it('never renders unsafe HTML or executes model output', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} renders unsafe HTML`).not.toMatch(/dangerouslySetInnerHTML/);
      expect(source, `${file} injects raw HTML`).not.toMatch(/innerHTML\s*=/);
      expect(source, `${file} evaluates model output`).not.toMatch(/eval\(/);
    }
  });

  it('persists nothing except the approved local keys', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const writes = [
        ...source.matchAll(/(?:localStorage|sessionStorage)\.setItem\(\s*'([^']+)'/g),
      ];
      for (const match of writes) {
        expect(PERSISTED_STORAGE_KEYS.has(match[1] ?? ''), `${file} persists ${match[1]}`).toBe(
          true,
        );
      }
      // Tokens must not be stashed anywhere else either.
      expect(source, `${file} stores a token`).not.toMatch(/\.setItem\(\s*['"][^'"]*token/i);
    }
  });

  it('keeps provider-bearing packages out of the web manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(WEB_SRC, '..', 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string>>;
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      expect(name, `web depends on ${name}`).not.toMatch(/genai|openai|anthropic/i);
    }
  });
});
