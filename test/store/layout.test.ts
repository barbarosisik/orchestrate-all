import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOutputStream, isValidRound, roundFile, runPaths, taskFolder } from '../../src/store/layout.js';

const HOME = join('/nonexistent-orchestra-home');

describe('layout', () => {
  it('keeps every file of a run under <home>/runs/<runId>, with short names', () => {
    const paths = runPaths(HOME, '20261121-120000-abcd');
    expect(paths.folder).toBe(join(HOME, 'runs', '20261121-120000-abcd'));
    expect([paths.plan, paths.state, paths.finalize, paths.log, paths.tasks].map((p) => p.slice(paths.folder.length + 1))).toEqual([
      'plan.json',
      'state.json',
      'finalize.json',
      'log.jsonl',
      'tasks',
    ]);
    expect(['stdout', 'stderr', 'gate', 'diff'].map((k) => roundFile(paths, 'api', k as 'gate', 2).slice(paths.tasks.length + 1))).toEqual([
      join('api', 'worker-2.out'),
      join('api', 'worker-2.err'),
      join('api', 'gate-2.json'),
      join('api', 'diff-2.patch'),
    ]);
  });

  it('builds paths from valid ids and rounds only', () => {
    expect(() => runPaths(HOME, '../x')).toThrow(/not a valid run id/);
    const paths = runPaths(HOME, 'run1');
    expect(() => taskFolder(paths, 'Con')).toThrow(/not a valid task id/);
    expect(() => taskFolder(paths, 'nul')).toThrow(/not a valid task id/);
    expect(() => roundFile(paths, 'api', 'gate', 100)).toThrow(/not a valid round/);
    expect(() => roundFile(paths, 'api', '__proto__' as 'gate', 0)).toThrow(/not a kind of round file/);
    expect(isOutputStream('stdout') && isOutputStream('stderr')).toBe(true);
    expect(['gate', '__proto__', 'constructor', 1].some(isOutputStream)).toBe(false);
    expect([0, 99].every(isValidRound)).toBe(true);
    expect([-1, 100, 0.5, Number.NaN, Infinity].some(isValidRound)).toBe(false);
  });
});
