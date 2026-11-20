import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  defaultGlobalGitFiles,
  takeBaseline,
  type IntegrityOptions,
  type IntegrityReport,
} from '../../src/integrity/check.js';
import { createTaskWorktree, type TaskWorktree } from '../../src/worktree/manager.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
const scratch: string[] = [];
afterEach(() => {
  f.cleanupAll();
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

interface Setup {
  readonly fx: Fixture;
  readonly wt: TaskWorktree;
  readonly opts: IntegrityOptions;
  /** The fake global git config file watched in these tests. */
  readonly globalFile: string;
  check(expectedTip?: string): Promise<IntegrityReport>;
  codes(expectedTip?: string): Promise<string[]>;
}

async function setup(prepare?: (fx: Fixture) => void): Promise<Setup> {
  const fx = f.make({ files: { 'README.md': 'hello\n', 'src/a.ts': 'a\n' } });
  prepare?.(fx);
  const created = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
  if (!created.ok) throw new Error(created.error.message);
  const wt = created.worktree;
  const globalFile = join(fx.home, 'fake-global.gitconfig');
  writeFileSync(globalFile, '[user]\n\tname = Someone\n');
  const opts: IntegrityOptions = { globalGitFiles: [globalFile] };
  const baseline = await takeBaseline(fx.ctx, opts);
  const check = (expectedTip = wt.startSha): Promise<IntegrityReport> =>
    checkIntegrity(fx.ctx, wt, baseline, expectedTip, opts);
  const codes = async (expectedTip?: string): Promise<string[]> =>
    (await check(expectedTip)).violations.map((v) => v.code);
  return { fx, wt, opts, globalFile, check, codes };
}

/** Runs git inside the worktree the way a worker would (plain discovery through its .git file). */
function workerGit(s: Setup, ...args: string[]): string {
  return s.fx.repo.git('-C', s.wt.path, ...args);
}

describe('checkIntegrity: what a worker may do', () => {
  it('passes for a fresh worktree', async () => {
    const s = await setup();
    const report = await s.check();
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('passes when the worker edits, adds and deletes files, and runs git status and git add', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.path, 'README.md'), 'changed\n');
    writeFileSync(join(s.wt.path, 'src', 'b.ts'), 'b\n');
    rmSync(join(s.wt.path, 'src', 'a.ts'));
    workerGit(s, 'status', '--porcelain');
    workerGit(s, 'add', '-A');
    expect(await s.codes()).toEqual([]);
  });

  it("ignores remote-tracking refs, which an editor's background fetch may move", async () => {
    const s = await setup();
    s.fx.repo.git('update-ref', 'refs/remotes/origin/main', s.fx.base);
    expect(await s.codes()).toEqual([]);
  });

  it("ignores other Orchestra tasks' branches and worktrees", async () => {
    const s = await setup();
    const other = await createTaskWorktree(s.fx.ctx, { runId: 'run1', taskId: 'web', startSha: s.fx.base });
    if (!other.ok) throw new Error(other.error.message);
    writeFileSync(join(other.worktree.path, 'web.txt'), 'w\n');
    s.fx.repo.git('-C', other.worktree.path, 'add', 'web.txt');
    s.fx.repo.git('-C', other.worktree.path, 'commit', '-q', '-m', 'web');
    expect(await s.codes()).toEqual([]);
  });

  it('accepts the commit the conductor made, when told to expect it', async () => {
    const s = await setup();
    const tree = s.fx.repo.git('rev-parse', 'HEAD^{tree}');
    const commit = s.fx.repo.git('commit-tree', tree, '-p', s.fx.base, '-m', 'conductor');
    s.fx.repo.git('update-ref', s.wt.ref, commit, s.fx.base);
    expect(await s.codes(commit)).toEqual([]);
    expect(await s.codes()).toEqual(['task-branch']);
  });

  it('returns the current state as the baseline for the next phase', async () => {
    const s = await setup();
    s.fx.repo.git('tag', 'v1');
    const first = await s.check();
    expect(first.violations.map((v) => v.code)).toEqual(['user-refs']);
    const second = await checkIntegrity(s.fx.ctx, s.wt, first.baseline, s.wt.startSha, s.opts);
    expect(second.violations).toEqual([]);
  });
});

describe("checkIntegrity: tampering with the task's own worktree", () => {
  it('catches a rewritten .git file', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.path, '.git'), `gitdir: ${join(tmpdir(), 'elsewhere')}\n`);
    expect(await s.codes()).toEqual(['git-pointer']);
  });

  it('catches a commit made by the worker', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.path, 'x.txt'), 'x\n');
    workerGit(s, 'add', 'x.txt');
    workerGit(s, 'commit', '-q', '-m', 'sneaky');
    const report = await s.check();
    expect(report.violations.map((v) => v.code)).toEqual(['task-branch']);
    expect(report.violations[0]?.message).toContain('moved');
  });

  it('catches a deleted task branch', async () => {
    const s = await setup();
    s.fx.repo.git('update-ref', '-d', s.wt.ref);
    const report = await s.check();
    expect(report.violations.map((v) => v.code)).toEqual(['task-branch']);
    expect(report.violations[0]?.message).toContain('deleted');
  });

  it('catches a switch to another branch', async () => {
    const s = await setup();
    workerGit(s, 'switch', '-q', '-c', 'elsewhere');
    expect(await s.codes()).toEqual(['worktree-head', 'user-refs']);
  });

  it('catches an unlocked worktree', async () => {
    const s = await setup();
    s.fx.repo.git('worktree', 'unlock', s.wt.path);
    expect(await s.codes()).toEqual(['worktree-unlocked']);
  });

  it('catches a per-worktree config file', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.adminDir, 'config.worktree'), '[core]\n\tfsmonitor = ./evil\n');
    expect(await s.codes()).toEqual(['worktree-config']);
  });

  it('catches a commondir pointing at another repository', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.adminDir, 'commondir'), `${join(tmpdir(), 'evil-repo')}\n`);
    expect(await s.codes()).toEqual(['worktree-admin']);
  });

  it('catches a nested repository inside the worktree', async () => {
    const s = await setup();
    mkdirSync(join(s.wt.path, 'src', 'inner'), { recursive: true });
    s.fx.repo.git('init', '-q', join(s.wt.path, 'src', 'inner'));
    const report = await s.check();
    expect(report.violations.map((v) => v.code)).toEqual(['nested-git']);
    expect(report.violations[0]?.message).toContain('src/inner/.git');
  });

  it('fails closed when the worktree is too big to scan', async () => {
    const s = await setup();
    const report = await checkIntegrity(s.fx.ctx, s.wt, await takeBaseline(s.fx.ctx, s.opts), s.wt.startSha, {
      ...s.opts,
      maxScanEntries: 1,
    });
    expect(report.violations.map((v) => v.code)).toEqual(['scan-incomplete']);
  });
});

describe("checkIntegrity: changes to the user's repository", () => {
  it('catches a moved branch, a new tag and a new branch', async () => {
    const s = await setup();
    s.fx.repo.write('more.txt');
    s.fx.repo.commitAll('more');
    s.fx.repo.git('tag', 'v1');
    s.fx.repo.git('branch', 'feature');
    const report = await s.check();
    expect(report.violations.map((v) => v.code)).toEqual(['user-refs']);
    expect(report.violations[0]?.message).toContain('refs/heads/main');
    expect(report.violations[0]?.message).toContain('refs/tags/v1');
    expect(report.violations[0]?.message).toContain('refs/heads/feature');
  });

  it("catches a change of the main checkout's HEAD", async () => {
    const s = await setup();
    s.fx.repo.git('checkout', '-q', '-b', 'other');
    const report = await s.check();
    expect(report.violations.map((v) => v.code)).toEqual(['user-refs', 'repo-files']);
    expect(report.violations[1]?.message).toContain('HEAD');
  });

  it('catches a planted hook, a config change and an info/exclude change', async () => {
    for (const tamper of [
      (s: Setup) => writeFileSync(join(s.fx.ctx.commonDir, 'hooks', 'pre-commit'), '#!/bin/sh\n'),
      (s: Setup) => s.fx.repo.git('config', 'core.hooksPath', '/tmp/evil-hooks'),
      (s: Setup) => writeFileSync(join(s.fx.ctx.commonDir, 'info', 'exclude'), 'secret/\n'),
      (s: Setup) => {
        mkdirSync(join(s.fx.ctx.commonDir, 'objects', 'info'), { recursive: true });
        writeFileSync(join(s.fx.ctx.commonDir, 'objects', 'info', 'alternates'), '/tmp/other/objects\n');
      },
    ]) {
      const s = await setup((fx) => mkdirSync(join(fx.ctx.commonDir, 'info'), { recursive: true }));
      tamper(s);
      expect(await s.codes()).toEqual(['repo-files']);
    }
  });

  it("catches a change to the user's own linked worktree", async () => {
    const userWt = mkdtempSync(join(tmpdir(), 'orch-user-wt-'));
    scratch.push(userWt);
    const path = join(userWt, 'mine');
    const s = await setup((fx) => fx.repo.git('worktree', 'add', '-q', '-b', 'mine', path));
    s.fx.repo.git('-C', path, 'switch', '-q', '-c', 'mine-2');
    expect(await s.codes()).toEqual(['user-refs', 'user-worktrees']);
  });

  it('catches a change to the global git config', async () => {
    const s = await setup();
    writeFileSync(s.globalFile, '[core]\n\tpager = evil\n');
    expect(await s.codes()).toEqual(['global-git-config']);
  });

  it('reports a git failure instead of passing', async () => {
    const s = await setup();
    const broken = { ...s.fx.ctx, commonDir: join(s.fx.home, 'not-a-repo') };
    mkdirSync(broken.commonDir);
    const report = await checkIntegrity(broken, s.wt, await takeBaseline(s.fx.ctx, s.opts), s.wt.startSha, s.opts);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.code)).toContain('git-failed');
  });
});

describe('takeBaseline', () => {
  it('throws when git cannot list the refs', async () => {
    const fx = f.make();
    const broken = { ...fx.ctx, commonDir: join(fx.home, 'not-a-repo') };
    mkdirSync(broken.commonDir);
    await expect(takeBaseline(broken, { globalGitFiles: [] })).rejects.toThrow(/for-each-ref/);
  });

  it('leaves Orchestra branches and remote-tracking refs out of the user refs', async () => {
    const fx = f.make();
    fx.repo.git('update-ref', 'refs/remotes/origin/main', fx.base);
    fx.repo.git('update-ref', 'refs/heads/orchestra/run1/api', fx.base);
    const baseline = await takeBaseline(fx.ctx, { globalGitFiles: [] });
    expect(Object.keys(baseline.refs)).toEqual(['refs/heads/main']);
  });
});

describe('defaultGlobalGitFiles', () => {
  it('watches ~/.gitconfig and the XDG config file', () => {
    expect(defaultGlobalGitFiles({})).toEqual([join(homedir(), '.gitconfig'), join(homedir(), '.config', 'git', 'config')]);
    const xdg = join(homedir(), 'xdg');
    expect(defaultGlobalGitFiles({ XDG_CONFIG_HOME: xdg })[1]).toBe(join(xdg, 'git', 'config'));
    expect(defaultGlobalGitFiles({ XDG_CONFIG_HOME: 'relative' })[1]).toBe(join(homedir(), '.config', 'git', 'config'));
  });
});
