import { describe, expect, it } from 'vitest';
import { parseStatusZ } from '../../src/repo/status.js';

const NUL = '\u0000';

describe('parseStatusZ (git status --porcelain=v2 -z)', () => {
  it('returns nothing for a clean tree', () => {
    expect(parseStatusZ('')).toEqual([]);
  });

  it('reads ordinary changes', () => {
    const out = `1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts${NUL}`;
    expect(parseStatusZ(out)).toEqual([{ path: 'src/a.ts', state: 'changed' }]);
  });

  it('keeps spaces inside paths', () => {
    const out = `1 M. N... 100644 100644 100644 aaaa bbbb docs/my notes.md${NUL}`;
    expect(parseStatusZ(out)).toEqual([{ path: 'docs/my notes.md', state: 'changed' }]);
  });

  it('reads renames as both the new and the old path', () => {
    const out = `2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new.ts${NUL}src/old.ts${NUL}`;
    expect(parseStatusZ(out)).toEqual([
      { path: 'src/new.ts', state: 'changed' },
      { path: 'src/old.ts', state: 'changed' },
    ]);
  });

  it('reads unmerged entries', () => {
    const out = `u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/c.ts${NUL}`;
    expect(parseStatusZ(out)).toEqual([{ path: 'src/c.ts', state: 'conflicted' }]);
  });

  it('reads untracked and ignored entries, including ignored folders', () => {
    const out = `? src/new.ts${NUL}! node_modules/${NUL}! src/debug.log${NUL}`;
    expect(parseStatusZ(out)).toEqual([
      { path: 'src/new.ts', state: 'untracked' },
      { path: 'node_modules/', state: 'ignored' },
      { path: 'src/debug.log', state: 'ignored' },
    ]);
  });

  it('skips header lines', () => {
    expect(parseStatusZ(`# branch.oid abc${NUL}? x.ts${NUL}`)).toEqual([{ path: 'x.ts', state: 'untracked' }]);
  });

  it('keeps non-ASCII paths as UTF-8', () => {
    expect(parseStatusZ(`? docs/日本/ünï.md${NUL}`)).toEqual([{ path: 'docs/日本/ünï.md', state: 'untracked' }]);
  });

  it('rejects output it does not understand', () => {
    expect(() => parseStatusZ(`Z what${NUL}`)).toThrow(/Unexpected/);
    expect(() => parseStatusZ(`1 .M too few fields${NUL}`)).toThrow(/Unexpected/);
  });
});
