/**
 * The even-split rule: with N tasks and K ready engines, every ready engine gets floor(N/K) or ceil(N/K)
 * tasks. Tasks are never invented to fill a share; with fewer tasks than engines, some engines sit out.
 */

import type { EngineName } from './schema.js';

export interface SplitBounds {
  readonly min: number;
  readonly max: number;
}

export type SplitCheck =
  | { ok: true }
  | { ok: false; counts: Partial<Record<EngineName, number>>; min: number; max: number };

export function splitBounds(taskCount: number, engineCount: number): SplitBounds {
  if (engineCount < 1) throw new Error('At least one engine must be ready.');
  return { min: Math.floor(taskCount / engineCount), max: Math.ceil(taskCount / engineCount) };
}

export function checkEvenSplit(assignments: readonly EngineName[], ready: readonly EngineName[]): SplitCheck {
  const { min, max } = splitBounds(assignments.length, ready.length);
  const counts: Partial<Record<EngineName, number>> = {};
  for (const engine of ready) counts[engine] = 0;
  for (const engine of assignments) {
    if (engine in counts) counts[engine] = (counts[engine] ?? 0) + 1;
  }
  const even = ready.every((engine) => {
    const count = counts[engine] ?? 0;
    return count >= min && count <= max;
  });
  return even ? { ok: true } : { ok: false, counts, min, max };
}
