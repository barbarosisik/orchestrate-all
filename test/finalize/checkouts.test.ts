import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTargetCheckouts } from '../../src/finalize/checkouts.js';
import { canonicalPath } from '../../src/repo/canonical.js';
import { createTaskWorktree } from '../../src/worktree/manager.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
const folders: string[] = [];
afterEach(() => {
  f.cleanupAll();
  while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
});

const FILES = { 'README.md': 'hello\n', '.gitignore': 'build/\n', 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n' };
const CHANGED = ['src/api/a.ts', 'src/api/new.ts', 'docs/guide.md', 'build/keep.txt'];

function make(): Fixture {
  return f.make({ files: FILES });
}

function root(fx: Fixture): string {
  return fx.ctx.repoRoot;
}

/** A linked worktree of the user's own, outside Orchestra's folder, on an existing or a new branch. */
function userWorktree(fx: Fixture, branch: string, opts: { create?: boolean } = {}): string {
  const parent = mkdtempSync(join(tmpdir(), 'orch-user-wt-'));
  folders.push(parent);
  const path = join(parent, 'wt');
  fx.repo.git('worktree', 'add', '-q', ...(opts.create === true ? ['-b', branch, path] : [path, branch]));
  return canonicalPath(path) ?? path;
}

describe('checkTargetCheckouts', () => {
  it('finds the checkout of the branch and passes when nothing is at risk', async () => {
    const fx = make();
    fx.repo.write('src/web/w.ts', 'unsaved, but finalizing does not touch it\n');
    fx.repo.write('scratch.txt', 'new file elsewhere\n');
    expect(await checkTargetCheckouts(fx.ctx, 'main', CHANGED)).toEqual({ checkouts: [root(fx)], problems: [] });
  });

  it('reports unsaved work where finalizing would write: changed, staged, new and in-the-way files', async () => {
    const fx = make();
    fx.repo.write('src/api/a.ts', 'unsaved\n');
    fx.repo.write('src/api/new.ts', 'my own new file\n');
    fx.repo.write('docs', 'a file where finalizing needs a folder\n');
    const result = await checkTargetCheckouts(fx.ctx, 'main', CHANGED);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ code: 'unsaved-work', checkout: root(fx) });
    expect([...(result.problems[0]?.paths ?? [])].sort()).toEqual(['docs', 'src/api/a.ts', 'src/api/new.ts']);
    expect(result.problems[0]?.message).toContain('src/api/a.ts (uncommitted change)');

    fx.repo.git('checkout', '--', 'src/api/a.ts');
    fx.repo.write('src/api/a.ts', 'staged\n');
    fx.repo.git('add', 'src/api/a.ts');
    const staged = await checkTargetCheckouts(fx.ctx, 'main', ['src/api/a.ts']);
    expect(staged.problems.map((p) => p.paths)).toEqual([['src/api/a.ts']]);
  });

  it('reports ignored files inside a folder finalizing writes to', async () => {
    const fx = make();
    fx.repo.write('build/out.js', 'generated\n');
    const result = await checkTargetCheckouts(fx.ctx, 'main', CHANGED);
    expect(result.problems.map((p) => [p.code, p.paths])).toEqual([['unsaved-work', ['build/']]]);
    expect(result.problems[0]?.message).toContain('ignored by git');
  });

  it('checks the user’s own worktree that has the branch, and nothing when the branch is not checked out', async () => {
    const fx = make();
    fx.repo.git('checkout', '-q', '-b', 'other');
    fx.repo.write('src/api/a.ts', 'unsaved on another branch: not at risk\n');
    expect(await checkTargetCheckouts(fx.ctx, 'main', CHANGED)).toEqual({ checkouts: [], problems: [] });

    const path = userWorktree(fx, 'main');
    writeFileSync(join(path, 'src/api/new.ts'), 'mine\n');
    const result = await checkTargetCheckouts(fx.ctx, 'main', CHANGED);
    expect(result.checkouts).toEqual([path]);
    expect(result.problems).toMatchObject([{ code: 'unsaved-work', checkout: path, paths: ['src/api/new.ts'] }]);
  });

  it('reports edits git hides (assume-unchanged, skip-worktree) where finalizing would write', async () => {
    const fx = make();
    fx.repo.git('update-index', '--assume-unchanged', 'src/api/a.ts');
    fx.repo.write('src/api/a.ts', 'edited, but git status does not say so\n');
    fx.repo.git('update-index', '--skip-worktree', 'src/web/w.ts');
    expect(fx.repo.git('status', '--porcelain')).toBe('');
    const result = await checkTargetCheckouts(fx.ctx, 'main', [...CHANGED, 'src/web/w.ts']);
    expect(result.problems).toMatchObject([{ code: 'unsaved-work', paths: ['src/api/a.ts', 'src/web/w.ts'] }]);
    expect(result.problems[0]?.message).toContain('assume-unchanged or skip-worktree');
    // Elsewhere, they are not this run's business.
    expect((await checkTargetCheckouts(fx.ctx, 'main', ['docs/guide.md'])).problems).toEqual([]);
  });

  it('allows staged changes away from the paths finalizing writes', async () => {
    const fx = make();
    fx.repo.write('src/web/w.ts', 'staged elsewhere\n');
    fx.repo.git('add', 'src/web/w.ts');
    expect(await checkTargetCheckouts(fx.ctx, 'main', CHANGED)).toEqual({ checkouts: [root(fx)], problems: [] });
  });

  it('finds a checkout of the branch spelled in another letter case, where the file system ignores case', async () => {
    const fx = make();
    fx.repo.git('checkout', '-q', '-b', 'other');
    const path = userWorktree(fx, 'main');
    const admin = join(fx.ctx.commonDir, 'worktrees', 'wt');
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/Main\n');
    writeFileSync(join(path, 'src/api/new.ts'), 'mine\n');
    const result = await checkTargetCheckouts({ ...fx.ctx, caseInsensitivePaths: true }, 'main', CHANGED);
    expect(result.checkouts).toEqual([path]);
    // On a case-sensitive file system refs/heads/Main has no file behind it, so git also lists the committed
    // files as new there; the user's own file is flagged either way.
    expect(result.problems).toMatchObject([{ code: 'unsaved-work', checkout: path }]);
    expect(result.problems[0]?.paths).toContain('src/api/new.ts');
  });

  it('finds the main checkout when the repository was opened from a linked worktree', async () => {
    const fx = make();
    const linked = userWorktree(fx, 'linked', { create: true });
    fx.repo.write('src/api/a.ts', 'unsaved in the main checkout\n');
    const fromLinked = { ...fx.ctx, repoRoot: linked };
    const result = await checkTargetCheckouts(fromLinked, 'main', CHANGED);
    expect(result.checkouts).toEqual([root(fx)]);
    expect(result.problems).toMatchObject([{ code: 'unsaved-work', checkout: root(fx), paths: ['src/api/a.ts'] }]);
  });

  it('skips a checkout of the branch whose folder the user deleted', async () => {
    const fx = make();
    fx.repo.git('checkout', '-q', '-b', 'other');
    const path = userWorktree(fx, 'main');
    rmSync(path, { recursive: true, force: true });
    expect(await checkTargetCheckouts(fx.ctx, 'main', CHANGED)).toEqual({ checkouts: [], problems: [] });
  });

  it('leaves Orchestra’s own worktrees out', async () => {
    const fx = make();
    fx.repo.git('checkout', '-q', '-b', 'other');
    const created = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
    if (!created.ok) throw new Error(created.error.message);
    writeFileSync(join(created.worktree.path, 'src/api/new.ts'), 'worker output\n');
    expect(await checkTargetCheckouts(fx.ctx, 'orchestra/run1/api', CHANGED)).toEqual({ checkouts: [], problems: [] });
  });

  it('reports a merge left half-done in a checkout of the branch', async () => {
    const fx = make();
    writeFileSync(join(fx.ctx.commonDir, 'MERGE_HEAD'), `${fx.base}\n`);
    const result = await checkTargetCheckouts(fx.ctx, 'main', CHANGED);
    expect(result.problems).toMatchObject([{ code: 'operation-in-progress', message: expect.stringContaining('a merge') }]);
  });

  it('reports a rebase of the branch in progress, even with HEAD detached', async () => {
    const fx = make();
    fx.repo.git('checkout', '-q', '--detach');
    mkdirSync(join(fx.ctx.commonDir, 'rebase-merge'));
    writeFileSync(join(fx.ctx.commonDir, 'rebase-merge', 'head-name'), 'refs/heads/main\n');
    const result = await checkTargetCheckouts(fx.ctx, 'main', CHANGED);
    expect(result).toEqual({
      checkouts: [],
      problems: [expect.objectContaining({ code: 'operation-in-progress', message: expect.stringContaining('rebase of main') })],
    });
    // A rebase of another branch is not this run's business.
    writeFileSync(join(fx.ctx.commonDir, 'rebase-merge', 'head-name'), 'refs/heads/other\n');
    expect((await checkTargetCheckouts(fx.ctx, 'main', CHANGED)).problems).toEqual([]);
  });
});
