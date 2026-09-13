import { describe, expect, it } from 'vitest';
import {
  InvalidPathError,
  baseName,
  isDescendantOrSelf,
  isValidPath,
  normalizePath,
  parentPath,
  rejectReason,
} from './index.js';

describe('normalizePath', () => {
  it('accepts and returns normalized workspace-relative paths', () => {
    expect(normalizePath('src/App.tsx')).toBe('src/App.tsx');
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
    expect(normalizePath('package.json')).toBe('package.json');
    expect(normalizePath('README.md')).toBe('README.md');
    expect(normalizePath('deep/nested/dir/file.ts')).toBe('deep/nested/dir/file.ts');
  });

  it('rejects parent-directory traversal', () => {
    expect(() => normalizePath('../etc/passwd')).toThrow(InvalidPathError);
    expect(() => normalizePath('src/../../secrets.txt')).toThrow(InvalidPathError);
    expect(() => normalizePath('a/b/../../../c.txt')).toThrow(InvalidPathError);
  });

  it('rejects absolute host paths', () => {
    expect(() => normalizePath('/etc/passwd')).toThrow(InvalidPathError);
    expect(() => normalizePath('/Users/name/project')).toThrow(InvalidPathError);
  });

  it('rejects Windows paths', () => {
    expect(() => normalizePath('C:\\Windows\\System32')).toThrow(InvalidPathError);
    expect(() => normalizePath('C:/Windows/System32')).toThrow(InvalidPathError);
    expect(() => normalizePath('src\\App.tsx')).toThrow(InvalidPathError);
  });

  it('rejects null bytes and control characters', () => {
    expect(() => normalizePath('src/App.tsx\0.js')).toThrow(InvalidPathError);
    expect(() => normalizePath('bad\nname.txt')).toThrow(InvalidPathError);
    expect(() => normalizePath('bad\x07name.txt')).toThrow(InvalidPathError);
  });

  it('rejects malformed paths', () => {
    expect(() => normalizePath('')).toThrow(InvalidPathError);
    expect(() => normalizePath('src//App.tsx')).toThrow(InvalidPathError);
    expect(() => normalizePath('src/')).toThrow(InvalidPathError);
    expect(() => normalizePath('src/./App.tsx')).toThrow(InvalidPathError);
    expect(() => normalizePath('src/.hidden')).not.toThrow(); // dot-prefixed NAMES are fine
    expect(() => normalizePath('a/'.repeat(80) + 'deep.txt')).toThrow(InvalidPathError); // too deep
  });
});

describe('rejectReason / isValidPath', () => {
  it('reports stable rejection reasons', () => {
    expect(rejectReason('../traversal')).toBe('traversal-segment');
    expect(rejectReason('/absolute')).toBe('absolute-path');
    expect(rejectReason('C:\\win')).toBe('backslash-separator');
    expect(rejectReason('nul\0l')).toBe('null-byte');
    expect(rejectReason('src')).toBeNull();
    expect(isValidPath('src/App.tsx')).toBe(true);
    expect(isValidPath('../escape')).toBe(false);
  });

  it('never includes raw rejected input in the error message', () => {
    let message = '';
    try {
      normalizePath('../../etc/passwd');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('passwd');
  });
});

describe('path helpers', () => {
  it('computes parents, names, and subtree membership', () => {
    expect(parentPath('src/App.tsx')).toBe('src');
    expect(parentPath('package.json')).toBe('');
    expect(baseName('src/App.tsx')).toBe('App.tsx');
    expect(isDescendantOrSelf('src', 'src/App.tsx')).toBe(true);
    expect(isDescendantOrSelf('src', 'src-x/App.tsx')).toBe(false);
    expect(isDescendantOrSelf('src', 'src')).toBe(true);
  });
});
