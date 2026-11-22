import { describe, expect, it } from 'vitest';
import { findHidden, showHidden } from '../../src/rules/hidden.js';

describe('hidden characters', () => {
  it('finds nothing in plain text, emoji or a leading byte order mark', () => {
    expect(findHidden('Use pnpm.\nTabs\tare fine.\r\n')).toEqual({ count: 0, codes: [] });
    expect(findHidden('﻿# Rules')).toEqual({ count: 0, codes: [] });
    expect(findHidden('Family: 👨‍👩‍👧 and ❤️')).toEqual({ count: 0, codes: [] });
  });

  it.each([
    ['right-to-left override', 'a‮b', 'U+202E'],
    ['isolate', 'a⁦b⁩', 'U+2066'],
    ['zero-width space', 'a​b', 'U+200B'],
    ['word joiner', 'a⁠b', 'U+2060'],
    ['byte order mark inside', 'a﻿b', 'U+FEFF'],
    ['tag character', 'a\u{E0041}b', 'U+E0041'],
    ['soft hyphen', 'a­b', 'U+00AD'],
    ['hangul filler', 'aㅤb', 'U+3164'],
    ['variation selector supplement', 'a\u{E0100}b', 'U+E0100'],
    ['escape character', 'a\u001b[2Jb', 'U+001B'],
    ['C1 control', 'a\u0085b', 'U+0085'],
    ['joiner between letters', 'a‍b', 'U+200D'],
  ])('finds a %s', (_name, text, code) => {
    const found = findHidden(text);
    expect(found.count).toBeGreaterThan(0);
    expect(found.codes).toContain(code);
  });

  it('counts every hidden character and names up to five kinds', () => {
    const text = '‪‫‬‭‮⁦⁧';
    expect(findHidden(text)).toEqual({ count: 7, codes: ['U+202A', 'U+202B', 'U+202C', 'U+202D', 'U+202E'] });
  });

  it('shows hidden characters as visible codes and leaves the rest alone', () => {
    expect(showHidden('run‮ tests\u{E0041}')).toBe('run[U+202E] tests[U+E0041]');
    expect(showHidden('﻿ok 👨‍👩‍👧\n')).toBe('﻿ok 👨‍👩‍👧\n');
  });
});
