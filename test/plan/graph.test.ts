import { describe, expect, it } from 'vitest';
import { dependsTransitively, findCycle } from '../../src/plan/graph.js';

function graph(edges: Record<string, string[]>): Map<string, readonly string[]> {
  return new Map(Object.entries(edges));
}

describe('findCycle', () => {
  it('returns null for a graph without cycles', () => {
    expect(findCycle(graph({ a: [], b: ['a'], c: ['a', 'b'] }))).toBeNull();
  });

  it('finds a self loop', () => {
    expect(findCycle(graph({ a: ['a'] }))).toEqual(['a', 'a']);
  });

  it('finds a two-node cycle', () => {
    expect(findCycle(graph({ a: ['b'], b: ['a'] }))).toEqual(['a', 'b', 'a']);
  });

  it('finds a longer cycle behind an acyclic prefix', () => {
    const cycle = findCycle(graph({ start: ['x'], x: ['y'], y: ['z'], z: ['x'] }));
    expect(cycle).toEqual(['x', 'y', 'z', 'x']);
  });

  it('ignores edges to unknown nodes', () => {
    expect(findCycle(graph({ a: ['missing'] }))).toBeNull();
  });
});

describe('dependsTransitively', () => {
  const g = graph({ a: [], b: ['a'], c: ['b'], d: [] });

  it('is true for a direct dependency', () => {
    expect(dependsTransitively(g, 'b', 'a')).toBe(true);
  });

  it('is true for an indirect dependency', () => {
    expect(dependsTransitively(g, 'c', 'a')).toBe(true);
  });

  it('is false in the other direction', () => {
    expect(dependsTransitively(g, 'a', 'c')).toBe(false);
  });

  it('is false for unrelated tasks', () => {
    expect(dependsTransitively(g, 'd', 'a')).toBe(false);
  });

  it('is false for a task and itself without a loop', () => {
    expect(dependsTransitively(g, 'a', 'a')).toBe(false);
  });
});
