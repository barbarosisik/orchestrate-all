import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookArgs, repoContext, repoGit } from '../../src/git/context.js';
import { fixtures, installHook } from '../helpers/fixture.js';

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

describe('hookArgs', () => {
  it('points core.hooksPath at an empty folder in the Orchestra home', () => {
    const fx = f.make();
    const args = hookArgs(fx.ctx);
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(`core.hooksPath=${join(fx.home, 'empty-hooks')}`);
    expect(existsSync(join(fx.home, 'empty-hooks'))).toBe(true);
  });

  it('adds nothing when hooks are allowed', () => {
    const fx = f.make({ hooks: 'on' });
    expect(hookArgs(fx.ctx)).toEqual([]);
  });

  it('stops when something was put in the empty hooks folder', () => {
    const fx = f.make();
    hookArgs(fx.ctx);
    writeFileSync(join(fx.home, 'empty-hooks', 'pre-commit'), '#!/bin/sh\n');
    expect(() => hookArgs(fx.ctx)).toThrow(/pre-commit/);
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
});
