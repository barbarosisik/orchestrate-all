import { describe, expect, it } from 'vitest';
import { parseRawDiff } from '../../src/scope/diff.js';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function raw(...entries: Array<[string, string]>): string {
  return entries.map(([meta, path]) => `${meta}\u0000${path}\u0000`).join('');
}

describe('parseRawDiff', () => {
  it('reads added, changed, deleted and retyped paths, including odd names', () => {
    const output = raw(
      [`:000000 100644 ${Z} ${A} A`, 'src/new file.ts'],
      [`:100644 100755 ${A} ${B} M`, 'bin/run'],
      [`:100644 000000 ${A} ${Z} D`, 'docs/café.md'],
      [`:100644 120000 ${A} ${B} T`, 'line\nbreak'],
    );
    expect(parseRawDiff(output)).toEqual([
      { path: 'src/new file.ts', status: 'A', oldMode: '000000', newMode: '100644' },
      { path: 'bin/run', status: 'M', oldMode: '100644', newMode: '100755' },
      { path: 'docs/café.md', status: 'D', oldMode: '100644', newMode: '000000' },
      { path: 'line\nbreak', status: 'T', oldMode: '100644', newMode: '120000' },
    ]);
  });

  it('returns nothing for no changes', () => {
    expect(parseRawDiff('')).toEqual([]);
  });

  it('refuses anything it does not understand', () => {
    expect(() => parseRawDiff(`:100644 100644 ${A} ${B} R100\u0000a\u0000b\u0000`)).toThrow(/Unexpected/);
    expect(() => parseRawDiff(`:100644 100644 ${A} ${B} M\u0000`)).toThrow(/Unexpected/);
    expect(() => parseRawDiff(`100644 100644 ${A} ${B} M\u0000a\u0000`)).toThrow(/Unexpected/);
  });
});
