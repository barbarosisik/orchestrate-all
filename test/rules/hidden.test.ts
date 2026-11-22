import { describe, expect, it } from 'vitest';
import { findHidden, showHidden } from '../../src/rules/hidden.js';

describe('hidden characters', () => {
  it('finds nothing in plain text, emoji or a leading byte order mark', () => {
    expect(findHidden('Use pnpm.\nTabs\tare fine.\r\n')).toEqual({ count: 0, codes: [] });
    expect(findHidden('\uFEFF# Rules')).toEqual({ count: 0, codes: [] });
    expect(findHidden('Family: 👨\u200D👩\u200D👧 and ❤️')).toEqual({ count: 0, codes: [] });
  });

  it.each([
    ['right-to-left override', 'a\u202Eb', 'U+202E'],
    ['isolate', 'a\u2066b\u2069', 'U+2066'],
    ['zero-width space', 'a\u200Bb', 'U+200B'],
    ['word joiner', 'a\u2060b', 'U+2060'],
    ['byte order mark inside', 'a\uFEFFb', 'U+FEFF'],
    ['tag character', 'a\u{E0041}b', 'U+E0041'],
    ['soft hyphen', 'a\u00ADb', 'U+00AD'],
    ['hangul filler', 'a\u3164b', 'U+3164'],
    ['variation selector supplement', 'a\u{E0100}b', 'U+E0100'],
    ['escape character', 'a\u001b[2Jb', 'U+001B'],
    ['C1 control', 'a\u0085b', 'U+0085'],
    ['joiner between letters', 'a\u200Db', 'U+200D'],
    ['text-style variation selector', 'a\uFE0Eb', 'U+FE0E'],
    ['variation selector 1', 'a\uFE00b', 'U+FE00'],
    ['combining grapheme joiner', 'a\u034Fb', 'U+034F'],
  ])('finds a %s', (_name, text, code) => {
    const found = findHidden(text);
    expect(found.count).toBeGreaterThan(0);
    expect(found.codes).toContain(code);
  });

  it('counts every hidden character and names up to five kinds', () => {
    const text = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067';
    expect(findHidden(text)).toEqual({ count: 7, codes: ['U+202A', 'U+202B', 'U+202C', 'U+202D', 'U+202E'] });
  });

  it('shows hidden characters as visible codes and leaves the rest alone', () => {
    expect(showHidden('run\u202E tests\u{E0041}')).toBe('run[U+202E] tests[U+E0041]');
    expect(showHidden('\uFEFFok 👨\u200D👩\u200D👧\n')).toBe('\uFEFFok 👨\u200D👩\u200D👧\n');
  });
});
