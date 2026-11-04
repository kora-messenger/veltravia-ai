import { describe, expect, it } from 'vitest';

import type { GatewayNode } from '../gateway/index.js';
import type { SnapshotNode } from '../types/index.js';
import { normaliseSelectedPath, pathIsUnder, planRestoreSteps } from './plan.js';

const file = (path: string, content: string): SnapshotNode => ({
  path,
  type: 'file',
  size: content.length,
  contentHash: `h-${content}`,
  content,
});
const dir = (path: string): SnapshotNode => ({
  path,
  type: 'directory',
  size: 0,
  contentHash: '',
  content: '',
});
const live = (path: string, content: string): GatewayNode => ({
  path,
  type: 'file',
  size: content.length,
  content,
});
const liveDir = (path: string): GatewayNode => ({
  path,
  type: 'directory',
  size: 0,
  content: null,
});

describe('pathIsUnder', () => {
  it('matches the path itself and anything beneath it', () => {
    expect(pathIsUnder('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathIsUnder('src/lib/x.ts', 'src')).toBe(true);
  });

  it('compares whole segments, so "src/a" does not select "src/ab"', () => {
    expect(pathIsUnder('src/ab.ts', 'src/a')).toBe(false);
    expect(pathIsUnder('src/ab/x.ts', 'src/a')).toBe(false);
  });
});

describe('normaliseSelectedPath', () => {
  it('cleans slashes', () => {
    expect(normaliseSelectedPath('/src/a.ts/')).toBe('src/a.ts');
  });

  it.each(['', '  ', '../etc/passwd', 'src/../../x', 'a//b', './a', 'a\\b', 'a\0b'])(
    'refuses %j',
    (raw) => {
      expect(normaliseSelectedPath(raw)).toBeNull();
    },
  );
});

describe('planRestoreSteps (whole tree)', () => {
  it('updates changed files, creates missing ones and deletes extras', () => {
    const steps = planRestoreSteps(
      [file('a.ts', 'old'), file('b.ts', 'keep')],
      [live('a.ts', 'new'), live('b.ts', 'keep'), live('c.ts', 'extra')],
    );
    expect(steps).toEqual([
      { kind: 'update_file', path: 'a.ts', content: 'old' },
      { kind: 'delete_file', path: 'c.ts' },
    ]);
  });

  it('plans nothing when the trees already match', () => {
    expect(planRestoreSteps([file('a.ts', 'x')], [live('a.ts', 'x')])).toEqual([]);
  });

  it('creates directories shallow-first and removes them deep-first', () => {
    const create = planRestoreSteps([dir('a'), dir('a/b'), file('a/b/f.ts', 'x')], []);
    expect(create.map((s) => s.path)).toEqual(['a', 'a/b', 'a/b/f.ts']);
    const remove = planRestoreSteps([], [liveDir('a'), liveDir('a/b'), live('a/b/f.ts', 'x')]);
    expect(remove.map((s) => s.path)).toEqual(['a/b/f.ts', 'a/b', 'a']);
  });
});

describe('planRestoreSteps (selected paths only)', () => {
  const target = [file('a.ts', 'old-a'), file('b.ts', 'old-b'), file('keep.ts', 'old-keep')];
  const current = [
    live('a.ts', 'new-a'),
    live('b.ts', 'new-b'),
    live('keep.ts', 'new-keep'),
    live('added-later.ts', 'x'),
  ];

  it('restores only the named file and touches nothing else', () => {
    expect(planRestoreSteps(target, current, ['a.ts'])).toEqual([
      { kind: 'update_file', path: 'a.ts', content: 'old-a' },
    ]);
  });

  it('never deletes a file the person did not name', () => {
    const steps = planRestoreSteps(target, current, ['a.ts']);
    expect(steps.some((s) => s.kind === 'delete_file')).toBe(false);
    expect(steps.some((s) => s.path === 'added-later.ts')).toBe(false);
  });

  it('removes a named file that did not exist in the target', () => {
    expect(planRestoreSteps(target, current, ['added-later.ts'])).toEqual([
      { kind: 'delete_file', path: 'added-later.ts' },
    ]);
  });

  it('brings back a named file that was deleted, with its folder', () => {
    const steps = planRestoreSteps(
      [dir('src'), file('src/gone.ts', 'was here')],
      [],
      ['src/gone.ts'],
    );
    expect(steps).toEqual([
      { kind: 'create_directory', path: 'src' },
      { kind: 'create_file', path: 'src/gone.ts', content: 'was here' },
    ]);
  });

  it('a folder selection covers its contents but not its neighbours', () => {
    const steps = planRestoreSteps(
      [dir('src'), file('src/a.ts', 'old'), file('lib.ts', 'old-lib')],
      [liveDir('src'), live('src/a.ts', 'new'), live('lib.ts', 'new-lib')],
      ['src'],
    );
    expect(steps).toEqual([{ kind: 'update_file', path: 'src/a.ts', content: 'old' }]);
  });

  it('plans nothing when the named file already matches', () => {
    expect(planRestoreSteps([file('a.ts', 'x')], [live('a.ts', 'x')], ['a.ts'])).toEqual([]);
  });
});
