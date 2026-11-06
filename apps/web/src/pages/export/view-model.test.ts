import { describe, expect, it } from 'vitest';

import {
  depthOf,
  failureAdvice,
  formatBytes,
  isCovered,
  minutesLeft,
  pickerEntries,
  pluralFiles,
  reasonLabel,
  scopeSummary,
  statusTone,
  toggleSelection,
} from './view-model';

describe('export view model', () => {
  it('formats sizes and file counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(pluralFiles(1)).toBe('1 file');
    expect(pluralFiles(0)).toBe('0 files');
    expect(pluralFiles(12)).toBe('12 files');
  });

  it('words every exclusion reason, none of which names a secret', () => {
    for (const reason of [
      'credential-file',
      'secret-in-content',
      'too-large',
      'total-size-limit',
      'file-count-limit',
      'unreadable',
    ] as const) {
      expect(reasonLabel(reason).length).toBeGreaterThan(3);
    }
  });

  it('gives a conflict advice that says nothing was saved', () => {
    expect(failureAdvice('EXPORT_REVISION_CONFLICT')).toMatch(/nothing was saved/);
    expect(failureAdvice('SOMETHING_NEW')).toBe('The export could not be completed.');
  });

  it('uses red only for failure', () => {
    expect(statusTone('failed')).toBe('error');
    expect(statusTone('ready')).toBe('success');
    expect(statusTone('expired')).toBe('warning');
  });

  it('counts minutes left and never goes negative', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(minutesLeft('2026-11-05T10:14:30Z', now)).toBe(15);
    expect(minutesLeft('2026-11-05T09:00:00Z', now)).toBe(0);
    expect(minutesLeft(null, now)).toBeNull();
    expect(minutesLeft('not a date', now)).toBeNull();
  });

  it('describes the scope', () => {
    expect(scopeSummary({ scope: 'project', selection: [] })).toBe('Whole project');
    expect(scopeSummary({ scope: 'selection', selection: ['src'] })).toBe('Selection: src');
    expect(scopeSummary({ scope: 'selection', selection: ['a', 'b'] })).toBe(
      'Selection of 2 items',
    );
  });

  it('lists the picker so a folder is followed by its children', () => {
    const entries = pickerEntries(
      [{ path: 'src/index.ts' }, { path: 'package.json' }, { path: 'src/ui/App.tsx' }],
      ['src', 'src/ui'],
    );
    expect(entries.map((e) => e.path)).toEqual([
      'package.json',
      'src',
      'src/index.ts',
      'src/ui',
      'src/ui/App.tsx',
    ]);
    expect(depthOf('src/ui/App.tsx')).toBe(2);
    expect(depthOf('package.json')).toBe(0);
  });

  it('treats a chosen folder as covering its children, and nothing else', () => {
    const chosen = new Set(['src']);
    expect(isCovered('src', chosen)).toBe(true);
    expect(isCovered('src/ui/App.tsx', chosen)).toBe(true);
    expect(isCovered('srcother/file.ts', chosen)).toBe(false);
    expect(isCovered('package.json', chosen)).toBe(false);
  });

  it('toggles selection, dropping children when their folder is chosen', () => {
    let selected = toggleSelection(new Set(), 'src/index.ts');
    selected = toggleSelection(selected, 'src/ui/App.tsx');
    expect([...selected].sort()).toEqual(['src/index.ts', 'src/ui/App.tsx']);
    selected = toggleSelection(selected, 'src');
    expect([...selected]).toEqual(['src']);
    selected = toggleSelection(selected, 'src');
    expect(selected.size).toBe(0);
  });
});
