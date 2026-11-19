/** Dependency-graph helpers. Edges point from a task to the tasks it depends on. */

export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

/**
 * Returns one cycle as a list of ids that starts and ends with the same id (for example a -> b -> a),
 * or null when the graph has none. Edges to ids that are not in the graph are ignored.
 */
export function findCycle(graph: DependencyGraph): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue;
      const depState = state.get(dep);
      if (depState === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep];
      if (depState === undefined) {
        const found = visit(dep);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const id of graph.keys()) {
    if (state.get(id) === undefined) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}

/** True when `from` depends on `to`, directly or through other tasks. */
export function dependsTransitively(graph: DependencyGraph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue = [...(graph.get(from) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(graph.get(next) ?? []));
  }
  return false;
}
