import { describe, expect, it } from 'vitest';
import { entriesOverlap, parseOwnsEntry, type OwnsEntry } from '../../src/plan/paths.js';

function entry(raw: string): OwnsEntry {
  const result = parseOwnsEntry(raw);
  if (!result.ok) throw new Error(`expected ${raw} to parse, got ${result.issue}`);
  return result.entry;
}

describe('parseOwnsEntry: accepted forms', () => {
  it('accepts a repo-relative file', () => {
    expect(entry('src/app.ts')).toEqual({ path: 'src/app.ts', key: 'src/app.ts', isFolder: false });
  });

  it('accepts a folder ending in a slash', () => {
    expect(entry('src/feature/')).toEqual({ path: 'src/feature/', key: 'src/feature', isFolder: true });
  });

  it('converts backslashes to slashes', () => {
    expect(entry('src\\feature\\a.ts').path).toBe('src/feature/a.ts');
    expect(entry('src\\feature\\').isFolder).toBe(true);
  });

  it('collapses repeated slashes', () => {
    expect(entry('src//feature///a.ts').path).toBe('src/feature/a.ts');
  });

  it('applies Unicode NFC so composed and decomposed forms match', () => {
    const composed = entry('docs/caf\u00e9.md');
    const decomposed = entry('docs/cafe\u0301.md');
    expect(composed.key).toBe(decomposed.key);
    expect(decomposed.path).toBe('docs/caf\u00e9.md');
  });

  it('builds a case-insensitive key but keeps the original case in path', () => {
    const e = entry('Src/App.TS');
    expect(e.path).toBe('Src/App.TS');
    expect(e.key).toBe('src/app.ts');
  });

  it('accepts dotfiles and names with inner dots', () => {
    expect(entry('.eslintrc.json').key).toBe('.eslintrc.json');
    expect(entry('src/a.test.ts').key).toBe('src/a.test.ts');
  });

  it('accepts non-ASCII names', () => {
    expect(entry('docs/ünïcødé/日本.md').path).toBe('docs/ünïcødé/日本.md');
  });
});

describe('parseOwnsEntry: rejected forms', () => {
  const cases: Array<[string, string]> = [
    ['', 'empty'],
    ['/', 'absolute'],
    ['/etc/passwd', 'absolute'],
    ['\\src\\a.ts', 'absolute'],
    ['C:\\repo\\a.ts', 'absolute'],
    ['c:/repo/a.ts', 'absolute'],
    ['\\\\server\\share\\a.ts', 'absolute'],
    ['src/*.ts', 'wildcard'],
    ['src/a?.ts', 'wildcard'],
    ['src/[ab].ts', 'wildcard'],
    ['src/**', 'wildcard'],
    ['../outside.ts', 'dot-segment'],
    ['src/../../x', 'dot-segment'],
    ['./src/a.ts', 'dot-segment'],
    ['src/./a.ts', 'dot-segment'],
    ['src/a.ts:stream', 'invalid-char'],
    ['src/a.ts::$DATA', 'invalid-char'],
    ['src/a<b>.ts', 'invalid-char'],
    ['src/a|b.ts', 'invalid-char'],
    ['src/a"b.ts', 'invalid-char'],
    ['src/a\u0001.ts', 'invalid-char'],
    ['src/a.ts.', 'trailing-dot-or-space'],
    ['src/a.ts ', 'trailing-dot-or-space'],
    [' src/a.ts', 'trailing-dot-or-space'],
    ['src./a.ts', 'trailing-dot-or-space'],
    ['PROGRA~1/a.ts', 'short-name'],
    ['src/LONGFI~2.TS', 'short-name'],
    ['src/CON', 'reserved-device-name'],
    ['src/nul.txt', 'reserved-device-name'],
    ['com1/a.ts', 'reserved-device-name'],
    ['LPT9.log', 'reserved-device-name'],
  ];

  it.each(cases)('rejects %j as %s', (raw, issue) => {
    const result = parseOwnsEntry(raw);
    expect(result).toEqual({ ok: false, issue });
  });

  it('rejects very long paths', () => {
    const result = parseOwnsEntry(`${'a/'.repeat(600)}x.ts`);
    expect(result).toEqual({ ok: false, issue: 'too-long' });
  });

  it('does not treat a tilde without a digit as a short name', () => {
    expect(parseOwnsEntry('src/~draft.md').ok).toBe(true);
    expect(parseOwnsEntry('src/a~b.md').ok).toBe(true);
  });

  it('does not treat names that only start like a device name as reserved', () => {
    expect(parseOwnsEntry('src/console.ts').ok).toBe(true);
    expect(parseOwnsEntry('src/nullable.ts').ok).toBe(true);
    expect(parseOwnsEntry('com10/a.ts').ok).toBe(true);
  });
});

describe('entriesOverlap', () => {
  it('detects identical files', () => {
    expect(entriesOverlap(entry('src/a.ts'), entry('src/a.ts'))).toBe(true);
  });

  it('detects identical files that differ only in case or slashes', () => {
    expect(entriesOverlap(entry('src/A.ts'), entry('SRC\\a.TS'))).toBe(true);
  });

  it('detects a file inside an owned folder, in both argument orders', () => {
    expect(entriesOverlap(entry('src/'), entry('src/feature/a.ts'))).toBe(true);
    expect(entriesOverlap(entry('src/feature/a.ts'), entry('src/'))).toBe(true);
  });

  it('detects nested folders', () => {
    expect(entriesOverlap(entry('src/'), entry('src/feature/'))).toBe(true);
  });

  it('treats a file and a folder with the same name as overlapping', () => {
    expect(entriesOverlap(entry('src/lib'), entry('src/lib/'))).toBe(true);
  });

  it('does not confuse a name prefix with a folder prefix', () => {
    expect(entriesOverlap(entry('src/app/'), entry('src/application.ts'))).toBe(false);
    expect(entriesOverlap(entry('src/app/'), entry('src/app2/a.ts'))).toBe(false);
  });

  it('keeps sibling files separate', () => {
    expect(entriesOverlap(entry('src/a.ts'), entry('src/b.ts'))).toBe(false);
  });

  it('a file never contains another path', () => {
    expect(entriesOverlap(entry('src/a'), entry('src/a.ts'))).toBe(false);
  });
});
