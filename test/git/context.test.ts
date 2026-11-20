import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adminGit, hookArgs, repoContext, repoGit, repoGitRaw, userHooksFolder } from '../../src/git/context.js';
import { fixtures, installHook, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

describe('repoContext', () => {
  it('defaults to hooks off and ORCHESTRA_HOME', () => {
    const saved = process.env.ORCHESTRA_HOME;
    process.env.ORCHESTRA_HOME = join(homedir(), 'orch-test-home-not-created');
    try {
      const ctx = repoContext({ repoRoot: '/repo', gitCommonDir: '/repo/.git' });
      expect(ctx).toMatchObject({ repoRoot: '/repo', commonDir: '/repo/.git', hooks: 'off' });
      expect(ctx.home).toBe(process.env.ORCHESTRA_HOME);
    } finally {
      if (saved === undefined) delete process.env.ORCHESTRA_HOME;
      else process.env.ORCHESTRA_HOME = saved;
    }
  });
});

/** Writes an executable hook that appends `name` to `marker` when it runs. */
function writeHook(dir: string, name: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> "${marker.replace(/\\/g, '/')}"\n`);
  chmodSync(join(dir, name), 0o755);
}

describe('hookArgs with hooks off', () => {
  it('points core.hooksPath at an empty folder in the Orchestra home', async () => {
    const fx = f.make();
    expect(await hookArgs(fx.ctx)).toEqual(['-c', `core.hooksPath=${join(fx.home, 'empty-hooks')}`]);
    expect(existsSync(join(fx.home, 'empty-hooks'))).toBe(true);
  });

  it('stops when something git could run as a hook was put in the empty hooks folder', async () => {
    for (const name of ['pre-commit', 'Post-Checkout', 'reference-transaction.exe']) {
      const fx = f.make();
      await hookArgs(fx.ctx);
      writeFileSync(join(fx.home, 'empty-hooks', name), '#!/bin/sh\n');
      await expect(hookArgs(fx.ctx)).rejects.toThrow(name);
    }
  });

  it('ignores files git never runs, such as .DS_Store or desktop.ini', async () => {
    const fx = f.make();
    await hookArgs(fx.ctx);
    for (const name of ['.DS_Store', 'desktop.ini', 'Thumbs.db', 'pre-commit.sample']) {
      writeFileSync(join(fx.home, 'empty-hooks', name), 'x');
    }
    expect(await hookArgs(fx.ctx)).toEqual(['-c', `core.hooksPath=${join(fx.home, 'empty-hooks')}`]);
  });
});

describe('hookArgs with hooks on', () => {
  async function folder(fx: Fixture): Promise<string> {
    const args = await hookArgs(fx.ctx);
    expect(args[0]).toBe('-c');
    return (args[1] ?? '').replace(/^core\.hooksPath=/, '');
  }

  it("names the repository's own hooks folder by default", async () => {
    const fx = f.make({ hooks: 'on' });
    expect(await folder(fx)).toBe(join(fx.ctx.commonDir, 'hooks'));
  });

  it('reads a relative core.hooksPath (husky) from the top of the user\'s checkout', async () => {
    const fx = f.make({ hooks: 'on' });
    fx.repo.git('config', 'core.hooksPath', '.husky/_');
    expect(await folder(fx)).toBe(join(fx.ctx.repoRoot, '.husky', '_'));
  });

  it('keeps an absolute core.hooksPath and expands "~/"', async () => {
    const fx = f.make({ hooks: 'on' });
    const absolute = join(fx.home, 'my-hooks');
    fx.repo.git('config', 'core.hooksPath', absolute);
    expect(await folder(fx)).toBe(absolute);
    const other = f.make({ hooks: 'on' });
    other.repo.git('config', 'core.hooksPath', '~/my-hooks');
    expect(await folder(other)).toBe(join(homedir(), 'my-hooks'));
  });

  it('resolves the folder once per context', async () => {
    const fx = f.make({ hooks: 'on' });
    const first = await userHooksFolder(fx.ctx);
    fx.repo.git('config', 'core.hooksPath', '/somewhere/else');
    expect(await userHooksFolder(fx.ctx)).toBe(first);
  });

  it("fails when git can't read the config, and tries again next time", async () => {
    const fx = f.make({ hooks: 'on' });
    const broken = { ...fx.ctx, repoRoot: join(fx.home, 'missing') };
    await expect(userHooksFolder(broken)).rejects.toThrow();
    await expect(userHooksFolder(broken)).rejects.toThrow();
  });

  it("runs the user's own husky hook, and never one planted under the .git folder", async () => {
    const fx = f.make({ hooks: 'on' });
    fx.repo.git('config', 'core.hooksPath', '.husky/_');
    const marker = join(fx.home, 'hooks-ran.txt');
    writeHook(join(fx.ctx.repoRoot, '.husky', '_'), 'reference-transaction', marker);
    const planted = join(fx.home, 'planted-ran.txt');
    writeHook(join(fx.ctx.commonDir, '.husky', '_'), 'reference-transaction', planted);
    expect((await repoGit(fx.ctx, ['update-ref', 'refs/heads/orchestra/r/t', fx.base])).code).toBe(0);
    expect(readFileSync(marker, 'utf8')).toContain('reference-transaction');
    expect(existsSync(planted)).toBe(false);
  });
});

describe('repoGit', () => {
  it('runs against the shared git folder, whatever GIT_DIR says', async () => {
    const fx = f.make();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/definitely/not/a/repo';
    try {
      const result = await repoGit(fx.ctx, ['rev-parse', 'main']);
      expect(result.stdout.trim()).toBe(fx.base);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it('does not run the reference-transaction hook when hooks are off', async () => {
    const fx = f.make();
    const marker = join(fx.home, 'hooks-ran.txt');
    installHook(fx, 'reference-transaction', marker);
    const result = await repoGit(fx.ctx, ['update-ref', 'refs/heads/orchestra/r/t', fx.base]);
    expect(result.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs it when hooks are allowed', async () => {
    const fx = f.make({ hooks: 'on' });
    const marker = join(fx.home, 'hooks-ran.txt');
    installHook(fx, 'reference-transaction', marker);
    await repoGit(fx.ctx, ['update-ref', 'refs/heads/orchestra/r/t', fx.base]);
    expect(readFileSync(marker, 'utf8')).toContain('reference-transaction');
  });

  it('returns raw bytes with repoGitRaw', async () => {
    const fx = f.make();
    const result = await repoGitRaw(fx.ctx, ['cat-file', 'commit', fx.base]);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result.stdout.toString('utf8')).toMatch(/^tree [0-9a-f]+\n/);
  });
});

describe('adminGit', () => {
  it("reads a linked worktree's own index", async () => {
    const fx = f.make({ files: { 'a.txt': 'a\n' } });
    const path = join(fx.home, 'user-wt');
    fx.repo.git('worktree', 'add', '-q', '-b', 'mine', path);
    writeFileSync(join(path, 'b.txt'), 'b\n');
    fx.repo.git('-C', path, 'add', 'b.txt');
    const result = await adminGit(fx.ctx, join(fx.ctx.commonDir, 'worktrees', 'user-wt'), ['ls-files']);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['a.txt', 'b.txt']);
  });
});
