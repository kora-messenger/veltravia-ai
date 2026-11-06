import { describe, expect, it } from 'vitest';

import { detectRenames, threeWay } from './diff.js';

const m = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));
const one = (base: string | null, local: string | null, remote: string | null) =>
  threeWay(
    m(base === null ? {} : { f: base }),
    m(local === null ? {} : { f: local }),
    m(remote === null ? {} : { f: remote }),
  );

/**
 * An independent statement of the rules, written as a table rather than as the
 * branching the implementation uses. If the two ever disagree, one is wrong.
 */
const V = [null, 'A', 'B'] as const;
type V = (typeof V)[number];

function expected(base: V, local: V, remote: V): string {
  if (local === remote) {
    if (local === null) return 'nothing';
    return base === local ? 'unchanged' : 'converged';
  }
  const localMoved = local !== base;
  const remoteMoved = remote !== base;
  if (!localMoved && remoteMoved) {
    return remote === null ? 'pull-delete' : base === null ? 'pull-add' : 'pull-modify';
  }
  if (localMoved && !remoteMoved) {
    return local === null ? 'push-delete' : base === null ? 'push-add' : 'push-modify';
  }
  if (local === null) return 'conflict:local-deleted-remote-modified';
  if (remote === null) return 'conflict:remote-deleted-local-modified';
  return base === null ? 'conflict:both-added' : 'conflict:both-modified';
}

describe('threeWay: every combination of base, local and remote', () => {
  const cases: [V, V, V][] = [];
  for (const b of V) for (const l of V) for (const r of V) cases.push([b, l, r]);

  it.each(cases)('base=%s local=%s remote=%s', (base, local, remote) => {
    const outcomes = one(base, local, remote);
    const want = expected(base, local, remote);
    if (want === 'nothing') {
      expect(outcomes).toEqual([]);
      return;
    }
    expect(outcomes).toHaveLength(1);
    const got = outcomes[0];
    const label = got?.kind === 'conflict' ? `conflict:${got.conflict}` : got?.kind;
    expect(label).toBe(want);
  });

  it('covers all 27 combinations', () => {
    expect(cases).toHaveLength(27);
  });
});

describe('threeWay: what each outcome carries', () => {
  it('a push names the project hash, a pull names the remote hash', () => {
    expect(one(null, 'A', null)[0]).toEqual({ kind: 'push-add', path: 'f', hash: 'A' });
    expect(one('A', 'B', 'A')[0]).toEqual({ kind: 'push-modify', path: 'f', hash: 'B' });
    expect(one('A', null, 'A')[0]).toEqual({ kind: 'push-delete', path: 'f' });
    expect(one(null, null, 'B')[0]).toEqual({ kind: 'pull-add', path: 'f', hash: 'B' });
    expect(one('A', 'A', 'B')[0]).toEqual({ kind: 'pull-modify', path: 'f', hash: 'B' });
    expect(one('A', 'A', null)[0]).toEqual({ kind: 'pull-delete', path: 'f' });
  });

  it('a conflict carries all three hashes so neither side is lost', () => {
    expect(one('A', 'B', null)[0]).toEqual({
      kind: 'conflict',
      path: 'f',
      conflict: 'remote-deleted-local-modified',
      localHash: 'B',
      remoteHash: null,
      baseHash: 'A',
    });
  });

  it('identical edits on both sides are not a conflict', () => {
    expect(one('A', 'B', 'B')[0]).toEqual({ kind: 'converged', path: 'f', hash: 'B' });
    expect(one(null, 'B', 'B')[0]).toEqual({ kind: 'converged', path: 'f', hash: 'B' });
  });

  it('with no base, a file only on one side is an add, not a delete', () => {
    const out = threeWay(m(), m({ a: '1' }), m({ b: '2' }));
    expect(out.map((o) => `${o.kind}:${o.path}`)).toEqual(['push-add:a', 'pull-add:b']);
  });

  it('with no base, the same path with different content is a conflict', () => {
    const out = threeWay(m(), m({ a: '1' }), m({ a: '2' }));
    expect(out[0]).toMatchObject({ kind: 'conflict', conflict: 'both-added' });
  });

  it('returns paths in a stable order', () => {
    const out = threeWay(m(), m({ z: '1', a: '1', m: '1' }), m());
    expect(out.map((o) => o.path)).toEqual(['a', 'm', 'z']);
  });

  it('handles many paths independently', () => {
    const base = m({ same: 'x', edited: 'x', removed: 'x' });
    const local = m({ same: 'x', edited: 'y', added: 'n' });
    const remote = m({ same: 'x', edited: 'x', removed: 'x', theirs: 't' });
    const out = Object.fromEntries(threeWay(base, local, remote).map((o) => [o.path, o.kind]));
    expect(out).toEqual({
      same: 'unchanged',
      edited: 'push-modify',
      removed: 'push-delete',
      added: 'push-add',
      theirs: 'pull-add',
    });
  });
});

describe('detectRenames', () => {
  it('pairs one deletion with one addition of identical content', () => {
    expect(detectRenames([{ path: 'old.ts', hash: 'H' }], [{ path: 'new.ts', hash: 'H' }])).toEqual(
      [{ fromPath: 'old.ts', toPath: 'new.ts', hash: 'H' }],
    );
  });

  it('does not guess when it is ambiguous', () => {
    // Two copies disappeared and one appeared: which one moved is unknowable.
    expect(
      detectRenames(
        [
          { path: 'a.ts', hash: 'H' },
          { path: 'b.ts', hash: 'H' },
        ],
        [{ path: 'c.ts', hash: 'H' }],
      ),
    ).toEqual([]);
    expect(
      detectRenames(
        [{ path: 'a.ts', hash: 'H' }],
        [
          { path: 'c.ts', hash: 'H' },
          { path: 'd.ts', hash: 'H' },
        ],
      ),
    ).toEqual([]);
  });

  it('ignores different content', () => {
    expect(detectRenames([{ path: 'a', hash: '1' }], [{ path: 'b', hash: '2' }])).toEqual([]);
  });

  it('finds several independent renames', () => {
    const out = detectRenames(
      [
        { path: 'a', hash: '1' },
        { path: 'b', hash: '2' },
      ],
      [
        { path: 'y', hash: '2' },
        { path: 'x', hash: '1' },
      ],
    );
    expect(out.map((r) => `${r.fromPath}>${r.toPath}`)).toEqual(['a>x', 'b>y']);
  });
});
