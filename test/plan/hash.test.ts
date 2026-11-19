import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Of } from '../../src/plan/hash.js';

describe('canonicalJson', () => {
  it('sorts object keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined object values', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('gives the same text for the same data in a different key order', () => {
    expect(canonicalJson({ x: [1, { q: 1, p: 2 }], y: 'z' })).toBe(canonicalJson({ y: 'z', x: [1, { p: 2, q: 1 }] }));
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });

  it('rejects values that JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson({ b: 1n })).toThrow();
  });
});

describe('sha256Of', () => {
  it('is stable and prefixed', () => {
    const h = sha256Of({ a: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256Of({ a: 1 })).toBe(h);
  });

  it('changes when the content changes', () => {
    expect(sha256Of({ a: 1 })).not.toBe(sha256Of({ a: 2 }));
  });
});
