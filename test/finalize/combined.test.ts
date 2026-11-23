import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCombined, distinctCommands } from '../../src/finalize/combined.js';
import { mergeTask, startIntegration } from '../../src/merge/integration.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';
import { node, runTask, taskCommit, userCommit } from '../helpers/run.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const FILES = { 'README.md': 'hello\n', '.gitignore': 'dist/\n', 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n' };
const integrity = { globalGitFiles: [] };

/** Fails when two routes files under src/ name the same route: fine for each task alone, not together. */
const NO_DUPLICATE_ROUTES = node(
  "const fs=require('fs');const seen=new Set();" +
    "for(const d of ['src/api','src/web']){const f=d+'/routes.txt';if(!fs.existsSync(f))continue;" +
    "for(const r of fs.readFileSync(f,'utf8').split('\\n').filter(Boolean)){" +
    "if(seen.has(r)){console.error('duplicate route '+r);process.exit(1)}seen.add(r)}}",
);
const README_SAYS_HELLO = node("process.exit(require('fs').readFileSync('README.md','utf8')==='hello\\n'?0:1)");

const api = runTask('api', ['src/api/'], [NO_DUPLICATE_ROUTES, README_SAYS_HELLO]);
const web = runTask('web', ['src/web/'], [NO_DUPLICATE_ROUTES]);

async function startRun(fx: Fixture): Promise<string> {
  const started = await startIntegration(fx.ctx, 'run1', fx.base);
  if (!started.ok) throw new Error(started.error.message);
  return started.tip;
}

async function merge(fx: Fixture, task: typeof api, tip: string, files: Record<string, string>): Promise<string> {
  const commit = await taskCommit(fx, 'run1', task, fx.base, files);
  const merged = await mergeTask(fx.ctx, { runId: 'run1', task, start: fx.base, commit, expectedTip: tip });
  if (!merged.ok) throw new Error(merged.error.message);
  return merged.tip;
}

describe('distinctCommands', () => {
  it('keeps each command once, in the order first listed', () => {
    expect(distinctCommands([api, web, runTask('x', [], [['a'], ['a', 'b']])])).toEqual([
      NO_DUPLICATE_ROUTES,
      README_SAYS_HELLO,
      ['a'],
      ['a', 'b'],
    ]);
  });
});

describe('checkCombined', () => {
  it('catches tasks that pass alone but fail together, after the merge that broke them', async () => {
    const fx = f.make({ files: FILES });
    let tip = await startRun(fx);
    tip = await merge(fx, api, tip, { 'src/api/routes.txt': '/health\n/users\n' });

    const afterApi = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip, tasks: [api] }, { integrity });
    expect(afterApi).toMatchObject({ passed: true, tip, problem: null, cleanup: [] });
    expect(afterApi.tasks).toMatchObject([{ id: 'api', passed: true }]);

    tip = await merge(fx, web, tip, { 'src/web/routes.txt': '/health\n' });
    const afterWeb = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip, tasks: [api, web] }, { integrity });
    expect(afterWeb.passed).toBe(false);
    expect(afterWeb.problem).toBeNull();
    expect(afterWeb.tasks.map((t) => [t.id, t.passed, t.commands.map((c) => c.status)])).toEqual([
      ['api', false, ['failed', 'passed']],
      ['web', false, ['failed']],
    ]);
    // The shared command ran once.
    expect(afterWeb.gate?.acceptance.commands).toHaveLength(2);
    expect(afterWeb.tasks[1]?.commands[0]).toBe(afterWeb.tasks[0]?.commands[0]);
    expect(afterWeb.tasks[0]?.commands[0]?.stderr.text).toContain('duplicate route /health');

    // The check worktree is gone; the integration branch is where it was.
    expect(existsSync(join(fx.home, 'wt', 'run1', 'integration'))).toBe(false);
    expect(fx.repo.git('rev-parse', 'refs/heads/orchestra/run1/integration')).toBe(tip);
    expect(fx.repo.git('worktree', 'list', '--porcelain')).not.toContain('integration');
  });

  it('fails when a command changes a tracked file, and lists files commands add without failing', async () => {
    const fx = f.make({ files: FILES });
    const tip = await startRun(fx);
    const writes = runTask('w', [], [node("require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/out.js','x')"), node("require('fs').writeFileSync('notes.txt','x')")]);
    const added = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip, tasks: [writes] }, { integrity });
    expect(added.passed).toBe(true);
    expect(added.gate?.added).toEqual(['notes.txt']);

    const edits = runTask('e', [], [node("require('fs').writeFileSync('README.md','changed\\n')")]);
    const changed = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip, tasks: [edits] }, { integrity });
    expect(changed).toMatchObject({ passed: false, problem: null });
    expect(changed.gate?.trackedChanged).toEqual(['README.md']);
    expect(changed.tasks).toMatchObject([{ id: 'e', passed: true }]);
  });

  it('passes with no commands at all', async () => {
    const fx = f.make({ files: FILES });
    const tip = await startRun(fx);
    const result = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip, tasks: [runTask('q', [])] }, { integrity });
    expect(result).toMatchObject({ passed: true, tasks: [{ id: 'q', passed: true, commands: [] }] });
  });

  it('does not run when the check worktree cannot be made', async () => {
    const fx = f.make({ files: FILES });
    await startRun(fx);
    const other = userCommit(fx, { 'README.md': 'moved\n' });
    const moved = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip: other, tasks: [api] }, { integrity });
    expect(moved).toMatchObject({ passed: false, gate: null, tasks: [], problem: expect.stringContaining('not at') });

    const missing = await checkCombined(fx.ctx, { runId: 'run1', name: 'finalize', tip: fx.base, tasks: [api] }, { integrity });
    expect(missing).toMatchObject({ passed: false, problem: expect.stringContaining('does not exist') });
  });
});

describe('checkCombined and the run manager', () => {
  it("makes, checks and removes its worktree inside the caller's exclusive sections, never nested", async () => {
    const fx = f.make({ files: FILES });
    const tip = await merge(fx, api, await startRun(fx), { 'src/api/routes.txt': 'a\n' });
    let depth = 0;
    let deepest = 0;
    let sections = 0;
    const exclusive = async <T,>(work: () => Promise<T>): Promise<T> => {
      depth++;
      sections++;
      deepest = Math.max(deepest, depth);
      try {
        return await work();
      } finally {
        depth--;
      }
    };
    const result = await checkCombined(fx.ctx, { runId: 'run1', name: 'integration', tip, tasks: [api] }, { integrity, exclusive });
    expect(result.passed).toBe(true);
    expect(sections).toBeGreaterThanOrEqual(5);
    expect(deepest).toBe(1);
  });
});
