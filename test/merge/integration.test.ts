import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/git/run.js';
import {
  integrationBranch,
  mergeCommitMessage,
  mergeTask,
  overlapping,
  readyToMerge,
  removeIntegration,
  startIntegration,
  type MergeTask,
} from '../../src/merge/integration.js';
import { checkScope, commitTask } from '../../src/scope/check.js';
import { createTaskWorktree } from '../../src/worktree/manager.js';
import { fixtures, installHook, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const FILES = { 'README.md': 'hello\n', 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n' };
const api: MergeTask = { id: 'api', title: 'Build the API', kind: 'work', mode: 'write', owns: ['src/api/'] };
const web: MergeTask = { id: 'web', title: 'Build the web page', kind: 'work', mode: 'write', owns: ['src/web/'] };
const REF = 'refs/heads/orchestra/run1/integration';

/** Runs a task the real way (worktree, scope check, conductor commit) and returns its commit. */
async function taskCommit(fx: Fixture, task: MergeTask, start: string, files: Record<string, string | null>): Promise<string> {
  const created = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: task.id, startSha: start });
  if (!created.ok) throw new Error(created.error.message);
  const wt = created.worktree;
  for (const [path, content] of Object.entries(files)) {
    const full = join(wt.path, path);
    if (content === null) rmSync(full);
    else {
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
  }
  const scope = await checkScope(fx.ctx, wt, task, { fromCommit: start });
  if (!scope.ok || !scope.report.clean) throw new Error(JSON.stringify(scope));
  const made = await commitTask(fx.ctx, wt, task, scope.report, { message: `${task.title}\n` });
  if (!made.ok) throw new Error(made.error.message);
  return made.tip;
}

/** A commit the worker made itself in its worktree, past the scope check. */
function workerCommit(fx: Fixture, task: MergeTask, start: string, files: Record<string, string>): Promise<string> {
  return createTaskWorktree(fx.ctx, { runId: 'run1', taskId: task.id, startSha: start }).then((created) => {
    if (!created.ok) throw new Error(created.error.message);
    const path = created.worktree.path;
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(path, rel, '..'), { recursive: true });
      writeFileSync(join(path, rel), content);
    }
    fx.repo.git('-C', path, 'add', '-A');
    fx.repo.git('-C', path, 'commit', '-q', '-m', 'worker');
    return fx.repo.git('-C', path, 'rev-parse', 'HEAD');
  });
}

/** A commit built with git plumbing, so paths are stored exactly as given whatever the file system. */
async function plumbingCommit(fx: Fixture, parent: string, files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-index-'));
  try {
    const opts = { cwd: fx.repo.dir, indexFile: join(dir, 'index') };
    const git = async (args: string[], input?: string): Promise<string> => {
      const result = await runGit(args, input === undefined ? opts : { ...opts, input });
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await git(['read-tree', parent]);
    for (const [path, content] of Object.entries(files)) {
      const blob = await git(['hash-object', '-w', '--stdin'], content);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const tree = await git(['write-tree']);
    return await git(['-c', 'user.name=Worker', '-c', 'user.email=w@example.invalid', 'commit-tree', tree, '-p', parent, '-m', 'worker']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function started(fx: Fixture): Promise<string> {
  const result = await startIntegration(fx.ctx, 'run1', fx.base);
  if (!result.ok) throw new Error(result.error.message);
  return result.tip;
}

function errorCode(result: { ok: boolean; error?: { code: string } }): string {
  return result.ok ? 'ok' : (result.error?.code ?? '?');
}

describe('startIntegration', () => {
  it('creates the integration branch at the base commit, once', async () => {
    const fx = f.make({ files: FILES });
    expect(await startIntegration(fx.ctx, 'run1', fx.base)).toEqual({
      ok: true,
      branch: 'orchestra/run1/integration',
      ref: REF,
      tip: fx.base,
    });
    expect(fx.repo.git('rev-parse', REF)).toBe(fx.base);
    expect(errorCode(await startIntegration(fx.ctx, 'run1', fx.base))).toBe('branch-exists');
  });

  it('refuses bad input', async () => {
    const fx = f.make({ files: FILES });
    expect(errorCode(await startIntegration(fx.ctx, 'Run 1', fx.base))).toBe('bad-input');
    expect(errorCode(await startIntegration(fx.ctx, 'run1', fx.base.slice(0, 8)))).toBe('bad-input');
    expect(errorCode(await startIntegration(fx.ctx, 'run1', 'f'.repeat(40)))).toBe('bad-input');
  });
});

describe('mergeTask', () => {
  it('merges tasks one at a time, as Orchestra, with both parents and without touching the user branch', async () => {
    const fx = f.make({ files: FILES });
    const marker = join(fx.home, 'hooks-ran.txt');
    installHook(fx, 'reference-transaction', marker);
    let tip = await started(fx);
    const apiCommit = await taskCommit(fx, api, fx.base, { 'src/api/a.ts': 'api v2\n', 'src/api/new.ts': 'new\n' });
    const webCommit = await taskCommit(fx, web, fx.base, { 'src/web/w.ts': null });

    const first = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: apiCommit, expectedTip: tip });
    if (!first.ok || !first.merged) throw new Error(JSON.stringify(first));
    expect(first.changes.map((c) => `${c.status} ${c.path}`)).toEqual(['M src/api/a.ts', 'A src/api/new.ts']);
    tip = first.tip;
    const second = await mergeTask(fx.ctx, { runId: 'run1', task: web, start: fx.base, commit: webCommit, expectedTip: tip });
    if (!second.ok || !second.merged) throw new Error(JSON.stringify(second));

    const git = fx.repo.git;
    expect(git('rev-parse', REF)).toBe(second.tip);
    expect(git('rev-list', '--parents', '-n', '1', second.tip)).toBe(`${second.tip} ${first.tip} ${webCommit}`);
    expect(git('show', `${second.tip}:src/api/a.ts`)).toBe('api v2');
    expect(git('show', `${second.tip}:src/api/new.ts`)).toBe('new');
    expect(git('ls-tree', '-r', '--name-only', second.tip).split('\n')).toEqual(['README.md', 'src/api/a.ts', 'src/api/new.ts']);
    expect(git('log', '-1', '--format=%an <%ae>|%G?|%s', second.tip)).toBe('Orchestra <orchestra@localhost>|N|Merge task web: Build the web page');
    expect(git('rev-parse', 'main')).toBe(fx.base);
    expect(existsSync(marker)).toBe(false);
  });

  it('merges a dependent task that started from the integration tip', async () => {
    const fx = f.make({ files: FILES });
    const apiCommit = await taskCommit(fx, api, fx.base, { 'src/api/a.ts': 'api v2\n' });
    const first = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: apiCommit, expectedTip: await started(fx) });
    if (!first.ok) throw new Error(first.error.message);
    const webCommit = await taskCommit(fx, web, first.tip, { 'src/web/w.ts': 'uses api v2\n' });
    const second = await mergeTask(fx.ctx, { runId: 'run1', task: web, start: first.tip, commit: webCommit, expectedTip: first.tip });
    expect(second.ok && second.merged).toBe(true);
  });

  it('merges nothing for a task without changes', async () => {
    const fx = f.make({ files: FILES });
    const tip = await started(fx);
    const result = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: fx.base, expectedTip: tip });
    expect(result).toEqual({ ok: true, merged: false, tip, changes: [] });
    expect(fx.repo.git('rev-parse', REF)).toBe(fx.base);
  });

  it('keeps a new file where the task put it, even when the integration branch moved that folder', async () => {
    const fx = f.make({ files: FILES });
    const mover: MergeTask = { ...web, id: 'move', owns: ['src/web/', 'src/site/'] };
    const adder: MergeTask = { ...web, id: 'add', owns: ['src/web/'] };
    const moved = await taskCommit(fx, mover, fx.base, { 'src/web/w.ts': null, 'src/site/w.ts': 'w\n' });
    const added = await taskCommit(fx, adder, fx.base, { 'src/web/new.ts': 'new\n' });
    const first = await mergeTask(fx.ctx, { runId: 'run1', task: mover, start: fx.base, commit: moved, expectedTip: await started(fx) });
    if (!first.ok) throw new Error(first.error.message);
    const second = await mergeTask(fx.ctx, { runId: 'run1', task: adder, start: fx.base, commit: added, expectedTip: first.tip });
    if (!second.ok || !second.merged) throw new Error(JSON.stringify(second));
    const paths = fx.repo.git('ls-tree', '-r', '--name-only', second.tip).split('\n');
    expect(paths).toContain('src/web/new.ts');
    expect(paths).not.toContain('src/site/new.ts');
  });

  it('refuses two tasks that changed the same file, whatever the letter case', async () => {
    const fx = f.make({ files: FILES });
    const apiToo: MergeTask = { ...web, id: 'api2', owns: ['src/api/'] };
    const one = await taskCommit(fx, api, fx.base, { 'src/api/a.ts': 'one\n', 'src/api/New.ts': 'x\n' });
    const two = await taskCommit(fx, apiToo, fx.base, { 'src/api/new.ts': 'y\n' });
    const first = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: one, expectedTip: await started(fx) });
    if (!first.ok) throw new Error(first.error.message);
    const second = await mergeTask(fx.ctx, { runId: 'run1', task: apiToo, start: fx.base, commit: two, expectedTip: first.tip });
    expect(second.ok ? 'ok' : second.error).toMatchObject({ code: 'overlap', paths: ['src/api/new.ts'] });
    expect(fx.repo.git('rev-parse', REF)).toBe(first.tip);
  });

  it('refuses a task commit that changes paths outside the task', async () => {
    const fx = f.make({ files: FILES });
    const sneaky = await workerCommit(fx, api, fx.base, { 'src/web/w.ts': 'not mine\n' });
    const result = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: sneaky, expectedTip: await started(fx) });
    expect(result.ok ? 'ok' : result.error).toMatchObject({ code: 'out-of-scope', paths: ['src/web/w.ts'] });
  });

  it('refuses a new path that clashes in letter case with the merged tree', async () => {
    const fx = f.make({ files: FILES });
    const clash = await plumbingCommit(fx, fx.base, { 'src/API/x.ts': 'x\n' });
    const result = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: clash, expectedTip: await started(fx) });
    expect(result.ok ? 'ok' : result.error.code).toBe('out-of-scope');
    expect(result.ok ? '' : result.error.message).toContain('letter case');
  });

  it('refuses when the integration branch moved, and leaves it alone', async () => {
    const fx = f.make({ files: FILES });
    await started(fx);
    const apiCommit = await taskCommit(fx, api, fx.base, { 'src/api/a.ts': 'v2\n' });
    const webCommit = await taskCommit(fx, web, fx.base, { 'src/web/w.ts': 'v2\n' });
    const first = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: fx.base, commit: apiCommit, expectedTip: fx.base });
    if (!first.ok) throw new Error(first.error.message);
    const stale = await mergeTask(fx.ctx, { runId: 'run1', task: web, start: fx.base, commit: webCommit, expectedTip: fx.base });
    expect(errorCode(stale)).toBe('branch-moved');
    expect(fx.repo.git('rev-parse', REF)).toBe(first.tip);
  });

  it('refuses commits that are not related the expected way', async () => {
    const fx = f.make({ files: FILES });
    const tip = await started(fx);
    const apiCommit = await taskCommit(fx, api, fx.base, { 'src/api/a.ts': 'v2\n' });
    fx.repo.write('elsewhere.txt');
    const unrelatedStart = fx.repo.commitAll('a commit the run never saw');
    const notFromStart = await mergeTask(fx.ctx, { runId: 'run1', task: api, start: unrelatedStart, commit: apiCommit, expectedTip: tip });
    expect(notFromStart.ok ? '' : notFromStart.error.message).toContain('does not descend');
    const webCommit = await taskCommit(fx, web, unrelatedStart, { 'src/web/w.ts': 'v2\n' });
    const notOurHistory = await mergeTask(fx.ctx, { runId: 'run1', task: web, start: unrelatedStart, commit: webCommit, expectedTip: tip });
    expect(notOurHistory.ok ? '' : notOurHistory.error.message).toContain('integration history');
  });

  it('refuses bad ids, missing commits and rewritten objects', async () => {
    const fx = f.make({ files: FILES });
    const tip = await started(fx);
    const apiCommit = await taskCommit(fx, api, fx.base, { 'src/api/a.ts': 'v2\n' });
    const input = { runId: 'run1', task: api, start: fx.base, commit: apiCommit, expectedTip: tip };
    expect(errorCode(await mergeTask(fx.ctx, { ...input, runId: 'Run 1' }))).toBe('bad-input');
    expect(errorCode(await mergeTask(fx.ctx, { ...input, commit: apiCommit.slice(0, 7) }))).toBe('bad-input');
    expect(errorCode(await mergeTask(fx.ctx, { ...input, commit: 'f'.repeat(40) }))).toBe('bad-input');

    const tree = fx.repo.git('rev-parse', `${apiCommit}:src/api`);
    const file = (id: string): string => join(fx.ctx.commonDir, 'objects', id.slice(0, 2), id.slice(2));
    chmodSync(file(tree), 0o644);
    rmSync(file(tree));
    copyFileSync(file(fx.repo.git('rev-parse', `${fx.base}:src/web`)), file(tree));
    expect(errorCode(await mergeTask(fx.ctx, input))).toBe('bad-object');
    expect(fx.repo.git('rev-parse', REF)).toBe(tip);
  });
});

describe('overlapping', () => {
  it('finds the same path, ignoring case, and a file that is the other side’s folder', () => {
    expect(overlapping(['src/a.ts', 'src/b.ts'], ['src/A.ts'])).toEqual(['src/a.ts']);
    expect(overlapping(['src/x'], ['src/x/y.ts'])).toEqual(['src/x']);
    expect(overlapping(['src/x/y.ts', 'src/z.ts'], ['src/x'])).toEqual(['src/x/y.ts']);
    expect(overlapping(['src/x/y.ts'], ['src/x/z.ts', 'docs/x/y.ts'])).toEqual([]);
  });
});

describe('readyToMerge', () => {
  it('lists accepted tasks whose dependencies are merged, in plan order', () => {
    const tasks = [
      { id: 'api', dependsOn: [] },
      { id: 'web', dependsOn: ['api'] },
      { id: 'docs', dependsOn: [] },
    ];
    expect(readyToMerge(tasks, new Set(['api', 'web', 'docs']), new Set())).toEqual(['api', 'docs']);
    expect(readyToMerge(tasks, new Set(['api', 'web']), new Set(['api']))).toEqual(['web']);
    expect(readyToMerge(tasks, new Set(['web']), new Set())).toEqual([]);
  });
});

describe('removeIntegration', () => {
  it('deletes the branch only while it points where expected', async () => {
    const fx = f.make({ files: FILES });
    await started(fx);
    expect(errorCode(await removeIntegration(fx.ctx, 'run1', 'f'.repeat(40)))).toBe('branch-moved');
    expect(fx.repo.git('rev-parse', REF)).toBe(fx.base);
    expect(await removeIntegration(fx.ctx, 'run1', fx.base)).toEqual({ ok: true });
    expect(fx.repo.git('for-each-ref', REF)).toBe('');
    expect(errorCode(await removeIntegration(fx.ctx, 'Run 1', fx.base))).toBe('bad-input');
    expect(errorCode(await removeIntegration(fx.ctx, 'run1', 'abc'))).toBe('bad-input');
  });
});

describe('naming', () => {
  it('names the branch and the merge commit', () => {
    expect(integrationBranch('run1')).toBe('orchestra/run1/integration');
    expect(mergeCommitMessage('run1', { id: 'api', title: 'Build\nthe API' })).toBe(
      'Merge task api: Build the API\n\nOrchestra-Run: run1\nOrchestra-Task: api\n',
    );
    expect(mergeCommitMessage('run1', { id: 'api', title: ' ' }).split('\n')[0]).toBe('Merge task api: api');
  });
});
