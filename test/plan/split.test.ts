import { describe, expect, it } from 'vitest';
import { checkEvenSplit, splitBounds } from '../../src/plan/split.js';

describe('splitBounds', () => {
  it('gives each engine the same share when it divides evenly', () => {
    expect(splitBounds(4, 2)).toEqual({ min: 2, max: 2 });
    expect(splitBounds(3, 3)).toEqual({ min: 1, max: 1 });
  });

  it('allows one extra task when it does not divide evenly', () => {
    expect(splitBounds(5, 2)).toEqual({ min: 2, max: 3 });
    expect(splitBounds(7, 3)).toEqual({ min: 2, max: 3 });
  });

  it('lets some engines sit out when there are fewer tasks than engines', () => {
    expect(splitBounds(1, 3)).toEqual({ min: 0, max: 1 });
    expect(splitBounds(2, 3)).toEqual({ min: 0, max: 1 });
  });

  it('gives a single engine everything', () => {
    expect(splitBounds(6, 1)).toEqual({ min: 6, max: 6 });
  });

  it('rejects zero engines', () => {
    expect(() => splitBounds(3, 0)).toThrow();
  });
});

describe('checkEvenSplit', () => {
  it('accepts 2 + 2 with Claude and Codex ready', () => {
    const r = checkEvenSplit(['claude', 'codex', 'claude', 'codex'], ['claude', 'codex']);
    expect(r.ok).toBe(true);
  });

  it('accepts 1 + 1 + 1 with all three ready', () => {
    expect(checkEvenSplit(['claude', 'codex', 'antigravity'], ['claude', 'codex', 'antigravity']).ok).toBe(true);
  });

  it('accepts 3 + 2 for five tasks on two engines', () => {
    expect(checkEvenSplit(['claude', 'claude', 'claude', 'codex', 'codex'], ['claude', 'codex']).ok).toBe(true);
  });

  it('rejects 3 + 1 for four tasks on two engines', () => {
    const r = checkEvenSplit(['claude', 'claude', 'claude', 'codex'], ['claude', 'codex']);
    expect(r).toEqual({ ok: false, counts: { claude: 3, codex: 1 }, min: 2, max: 2 });
  });

  it('rejects leaving a ready engine idle when it should have work', () => {
    const r = checkEvenSplit(['claude', 'claude', 'codex'], ['claude', 'codex', 'antigravity']);
    expect(r).toEqual({ ok: false, counts: { claude: 2, codex: 1, antigravity: 0 }, min: 1, max: 1 });
  });

  it('accepts a single task on any ready engine', () => {
    expect(checkEvenSplit(['codex'], ['claude', 'codex', 'antigravity']).ok).toBe(true);
  });

  it('works with only one engine ready', () => {
    expect(checkEvenSplit(['claude', 'claude', 'claude'], ['claude']).ok).toBe(true);
  });
});
