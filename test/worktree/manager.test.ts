import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreeGit } from '../../src/git/context.js';
import { canonicalPath } from '../../src/repo/canonical.js';
import { checkWorktreeLinks } from '../../src/worktree/links.js';
import {
  createTaskWorktree,
  listWorktrees,
  parseWorktreeList,
  removeTaskWorktree,
  startCommitFor,
  type TaskWorktree,
} from '../../src/worktree/manager.js';
import { fixtures, installHook, type Fixture } from '../helpers/fixture.js';
import { makeRepo } from '../helpers/tmprepo.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

async function create(fx: Fixture, taskId = 'api', runId = 'run1', startSha = fx.base): Promise<TaskWorktree> {
  const result = await createTaskWorktree(fx.ctx, { runId, taskId, startSha });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.worktree;
}

async function errorCode(fx: Fixture, input: { runId?: string; taskId?: string; startSha?: string }): Promise<string> {
  const result = await createTaskWorktree(fx.ctx, {
    runId: input.runId ?? 'run1',
    taskId: input.taskId ?? 'api',
    startSha: input.startSha ?? fx.base,
  });
  return result.ok ? 'ok' : result.error.code;
}

describe('createTaskWorktree', () => {
  it('creates a locked worktree on its own branch at the start commit, outside the repository', async () => {
    const fx = f.make({ files: { 'README.md': 'hello\n', 'src/a.ts': 'a\n' } });
    const wt = await create(fx);

    expect(wt.path).toBe(join(canonicalPath(fx.home) ?? '', 'wt', 'run1', 'api'));
    expect(wt.branch).toBe('orchestra/run1/api');
    expect(wt.ref).toBe('refs/heads/orchestra/run1/api');
    expect(readFileSync(join(wt.path, 'src/a.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('a\n');
    expect(fx.repo.git('rev-parse', wt.ref)).toBe(fx.base);
    expect(fx.repo.git('-C', wt.path, 'symbolic-ref', 'HEAD')).toBe(wt.ref);
    expect(join(wt.adminDir, '..')).toBe(join(fx.ctx.commonDir, 'worktrees'));

    const list = await listWorktrees(fx.ctx);
    if (!list.ok) throw new Error(list.error.message);
    const entry = list.worktrees.find((w) => canonicalPath(w.path) === wt.path);
    expect(entry).toMatchObject({ branch: wt.ref, head: fx.base, locked: 'orchestra run run1 task api' });
  });

  it("leaves the user's checkout alone", async () => {
    const fx = f.make();
    fx.repo.write('notes.txt', 'unsaved\n');
    const statusBefore = fx.repo.git('status', '--porcelain');
    await create(fx);
    expect(fx.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(fx.repo.git('rev-parse', 'main')).toBe(fx.base);
    expect(fx.repo.git('status', '--porcelain')).toBe(statusBefore);
  });

  it('starts a task from another commit, such as the integration tip', async () => {
    const fx = f.make();
    fx.repo.git('checkout', '-q', '-b', 'side');
    fx.repo.write('merged/dep.ts', 'dep\n');
    const tip = fx.repo.commitAll('dependency work');
    fx.repo.git('checkout', '-q', 'main');
    const wt = await create(fx, 'web', 'run1', tip);
    expect(existsSync(join(wt.path, 'merged/dep.ts'))).toBe(true);
    expect(fx.repo.git('rev-parse', wt.ref)).toBe(tip);
  });

  it('gives the same task id in two runs its own folder and admin folder', async () => {
    const fx = f.make();
    const first = await create(fx, 'api', 'run1');
    const second = await create(fx, 'api', 'run2');
    expect(first.path).not.toBe(second.path);
    expect(first.adminDir).not.toBe(second.adminDir);
    expect(checkWorktreeLinks(second, fx.ctx.commonDir, fx.ctx.caseInsensitivePaths)).toEqual([]);
  });

  it('handles spaces and non-ASCII characters in folder and file names', async () => {
    const fx = f.make({ homeName: 'Orchestra Hôme ü', files: { 'docs/café/ünï.md': 'x\n' } });
    const wt = await create(fx);
    expect(wt.path).toContain('Orchestra Hôme ü');
    expect(existsSync(join(wt.path, 'docs/café/ünï.md'))).toBe(true);
    expect(checkWorktreeLinks(wt, fx.ctx.commonDir, fx.ctx.caseInsensitivePaths)).toEqual([]);
  });

  it("does not run the repository's hooks by default", async () => {
    const fx = f.make();
    const marker = join(fx.home, 'hooks-ran.txt');
    installHook(fx, 'post-checkout', marker);
    installHook(fx, 'reference-transaction', marker);
    await create(fx);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs them when the user allows hooks', async () => {
    const fx = f.make({ hooks: 'on' });
    const marker = join(fx.home, 'hooks-ran.txt');
    installHook(fx, 'post-checkout', marker);
    await create(fx);
    expect(readFileSync(marker, 'utf8')).toContain('post-checkout');
  });

  it('cleans up when git fails part-way', async () => {
    const fx = f.make({ hooks: 'on' });
    // A failing post-checkout hook makes `git worktree add` fail after it created the branch and folder.
    const hook = join(fx.ctx.commonDir, 'hooks', 'post-checkout');
    mkdirSync(join(fx.ctx.commonDir, 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
    expect(result.ok ? 'ok' : result.error.code).toBe('git-failed');
    expect(existsSync(join(fx.home, 'wt', 'run1', 'api'))).toBe(false);
    expect(fx.repo.git('branch', '--list', 'orchestra/*')).toBe('');
    const list = await listWorktrees(fx.ctx);
    expect(list.ok && list.worktrees.length).toBe(1);
  });

  it('refuses run and task ids that are not safe names', async () => {
    const fx = f.make();
    expect(await errorCode(fx, { runId: 'Run1' })).toBe('bad-name');
    expect(await errorCode(fx, { runId: 'a/b' })).toBe('bad-name');
    expect(await errorCode(fx, { runId: '' })).toBe('bad-name');
    expect(await errorCode(fx, { taskId: 'con' })).toBe('bad-name');
    expect(await errorCode(fx, { taskId: 'integration' })).toBe('bad-name');
    expect(await errorCode(fx, { taskId: 'API' })).toBe('bad-name');
  });

  it('refuses a start commit that is abbreviated or not in the repository', async () => {
    const fx = f.make();
    expect(await errorCode(fx, { startSha: fx.base.slice(0, 12) })).toBe('bad-start');
    expect(await errorCode(fx, { startSha: 'f'.repeat(40) })).toBe('bad-start');
    const tree = fx.repo.git('rev-parse', 'HEAD^{tree}');
    expect(await errorCode(fx, { startSha: tree })).toBe('bad-start');
  });

  it('refuses a folder that already exists, and never reuses it', async () => {
    const fx = f.make();
    mkdirSync(join(fx.home, 'wt', 'run1', 'api'), { recursive: true });
    expect(await errorCode(fx, {})).toBe('path-exists');
  });

  it('refuses a branch that already exists', async () => {
    const fx = f.make();
    fx.repo.git('branch', 'orchestra/run1/api');
    expect(await errorCode(fx, {})).toBe('branch-exists');
    expect(existsSync(join(fx.home, 'wt', 'run1', 'api'))).toBe(false);
  });

  it("refuses an Orchestra folder inside the user's repository", async () => {
    const fx = f.make();
    const inside = { ...fx.ctx, home: join(fx.ctx.repoRoot, '.orchestra') };
    const result = await createTaskWorktree(inside, { runId: 'run1', taskId: 'api', startSha: fx.base });
    expect(result.ok ? 'ok' : result.error.code).toBe('home-overlaps-repo');
  });
});

describe('a worker that tampers with its .git file', () => {
  it("can't redirect the conductor's git to another repository", async () => {
    const fx = f.make();
    const wt = await create(fx);
    const decoy = makeRepo();
    try {
      decoy.git('checkout', '-q', '-b', 'decoy');
      writeFileSync(join(wt.path, '.git'), `gitdir: ${join(decoy.dir, '.git')}\n`);

      const head = await worktreeGit(fx.ctx, wt, ['symbolic-ref', 'HEAD']);
      expect(head.stdout.trim()).toBe(wt.ref);
      expect(checkWorktreeLinks(wt, fx.ctx.commonDir, fx.ctx.caseInsensitivePaths).map((p) => p.code)).toEqual([
        'git-pointer',
      ]);
      expect(decoy.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('decoy');
    } finally {
      decoy.cleanup();
    }
  });
});

describe('removeTaskWorktree', () => {
  it("removes the folder, git's record of it and the branch", async () => {
    const fx = f.make();
    const wt = await create(fx);
    const result = await removeTaskWorktree(fx.ctx, wt, { deleteBranchAt: wt.startSha });
    expect(result).toEqual({ ok: true, folderRemoved: true, branchDeleted: true, problems: [] });
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(join(fx.home, 'wt', 'run1'))).toBe(false);
    expect(existsSync(wt.adminDir)).toBe(false);
    expect(fx.repo.git('branch', '--list', 'orchestra/*')).toBe('');
    expect(fx.repo.git('rev-parse', 'main')).toBe(fx.base);
  });

  it('keeps the branch when it no longer points where the caller expects', async () => {
    const fx = f.make();
    const wt = await create(fx);
    writeFileSync(join(wt.path, 'new.txt'), 'x\n');
    fx.repo.git('-C', wt.path, 'add', 'new.txt');
    fx.repo.git('-C', wt.path, 'commit', '-q', '-m', 'worker commit');
    const result = await removeTaskWorktree(fx.ctx, wt, { deleteBranchAt: wt.startSha });
    expect(result.folderRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('Kept branch orchestra/run1/api');
    expect(fx.repo.git('branch', '--list', 'orchestra/run1/api')).not.toBe('');
  });

  it('keeps the branch unless asked to delete it', async () => {
    const fx = f.make();
    const wt = await create(fx);
    const result = await removeTaskWorktree(fx.ctx, wt);
    expect(result).toMatchObject({ ok: true, folderRemoved: true, branchDeleted: false });
    expect(fx.repo.git('rev-parse', wt.ref)).toBe(fx.base);
  });

  it('removes a worktree whose .git file a worker rewrote', async () => {
    const fx = f.make();
    const wt = await create(fx);
    writeFileSync(join(wt.path, '.git'), 'gitdir: /nowhere\n');
    const result = await removeTaskWorktree(fx.ctx, wt, { deleteBranchAt: wt.startSha, retries: 0 });
    expect(result).toMatchObject({ ok: true, folderRemoved: true, branchDeleted: true });
    expect(existsSync(wt.adminDir)).toBe(false);
  });

  it('cleans up when the folder is already gone', async () => {
    const fx = f.make();
    const wt = await create(fx);
    rmSync(wt.path, { recursive: true, force: true });
    const result = await removeTaskWorktree(fx.ctx, wt, { deleteBranchAt: wt.startSha });
    expect(result).toMatchObject({ ok: true, folderRemoved: true, branchDeleted: true });
    expect(existsSync(wt.adminDir)).toBe(false);
    const list = await listWorktrees(fx.ctx);
    expect(list.ok && list.worktrees.length).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('deletes a symlink put in place of the folder, not what it points to', async () => {
    const fx = f.make();
    const wt = await create(fx);
    const victim = join(fx.home, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep\n');
    rmSync(wt.path, { recursive: true, force: true });
    symlinkSync(victim, wt.path, 'dir');
    const result = await removeTaskWorktree(fx.ctx, wt, { deleteBranchAt: wt.startSha, retries: 0 });
    expect(result.folderRemoved).toBe(true);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a folder it could not delete',
    async () => {
      const fx = f.make();
      const wt = await create(fx);
      const runDir = join(wt.path, '..');
      chmodSync(runDir, 0o555);
      try {
        const result = await removeTaskWorktree(fx.ctx, wt, { deleteBranchAt: wt.startSha, retries: 0 });
        expect(result.ok).toBe(false);
        expect(result.folderRemoved).toBe(false);
        expect(result.problems.join(' ')).toContain('Could not delete');
      } finally {
        chmodSync(runDir, 0o755);
      }
    },
  );

  it('leaves the run folder while other tasks still use it', async () => {
    const fx = f.make();
    const api = await create(fx, 'api');
    const web = await create(fx, 'web');
    await removeTaskWorktree(fx.ctx, api, { deleteBranchAt: api.startSha });
    expect(existsSync(web.path)).toBe(true);
    expect(checkWorktreeLinks(web, fx.ctx.commonDir, fx.ctx.caseInsensitivePaths)).toEqual([]);
  });

  it('refuses anything Orchestra did not create', async () => {
    const fx = f.make();
    const wt = await create(fx);
    const notOurs: TaskWorktree[] = [
      { ...wt, path: fx.ctx.repoRoot },
      { ...wt, branch: 'main', ref: 'refs/heads/main' },
      { ...wt, taskId: 'web' },
      { ...wt, adminDir: join(fx.home, 'admin') },
    ];
    for (const handle of notOurs) {
      const result = await removeTaskWorktree(fx.ctx, handle, { deleteBranchAt: fx.base });
      expect(result.ok).toBe(false);
      expect(result.folderRemoved).toBe(false);
    }
    expect(existsSync(join(fx.ctx.repoRoot, 'README.md'))).toBe(true);
    expect(fx.repo.git('rev-parse', 'main')).toBe(fx.base);
    expect(existsSync(wt.path)).toBe(true);
  });
});

describe('parseWorktreeList', () => {
  it('reads every kind of entry', () => {
    const z = (...records: string[][]): string => records.map((r) => `${r.join('\u0000')}\u0000\u0000`).join('');
    const output = z(
      ['worktree /repo', 'HEAD aaa', 'branch refs/heads/main'],
      ['worktree /wt/a', 'HEAD bbb', 'branch refs/heads/orchestra/r/a', 'locked orchestra run r task a'],
      ['worktree /wt/b', 'HEAD ccc', 'detached', 'locked'],
      ['worktree /gone', 'HEAD ddd', 'detached', 'prunable gitdir file points to non-existent location'],
      ['worktree /bare.git', 'bare'],
    );
    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'refs/heads/main', locked: null, prunable: false, bare: false, detached: false },
      {
        path: '/wt/a',
        head: 'bbb',
        branch: 'refs/heads/orchestra/r/a',
        locked: 'orchestra run r task a',
        prunable: false,
        bare: false,
        detached: false,
      },
      { path: '/wt/b', head: 'ccc', branch: null, locked: '', prunable: false, bare: false, detached: true },
      { path: '/gone', head: 'ddd', branch: null, locked: null, prunable: true, bare: false, detached: true },
      { path: '/bare.git', head: null, branch: null, locked: null, prunable: false, bare: true, detached: false },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('startCommitFor', () => {
  it('uses the base commit for a task without dependencies', () => {
    expect(startCommitFor({ id: 'a', dependsOn: [] }, 'base', 'tip')).toBe('base');
  });

  it('uses the integration tip for a task with dependencies', () => {
    expect(startCommitFor({ id: 'b', dependsOn: ['a'] }, 'base', 'tip')).toBe('tip');
  });

  it('refuses a dependent task before anything is merged', () => {
    expect(() => startCommitFor({ id: 'b', dependsOn: ['a'] }, 'base')).toThrow(/merge those first/);
  });
});
