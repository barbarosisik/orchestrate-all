import { describe, expect, it } from 'vitest';
import { gitEnv, runGit } from '../../src/git/run.js';
import { makeRepo } from '../helpers/tmprepo.js';

describe('gitEnv', () => {
  it('removes git variables that could redirect a command', () => {
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/evil', GIT_WORK_TREE: '/evil', GIT_INDEX_FILE: 'x', git_dir: '/evil' });
    expect(env.PATH).toBe('/bin');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.git_dir).toBeUndefined();
  });

  it('turns off prompts and optional locks', () => {
    const env = gitEnv({});
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });
});

describe('runGit', () => {
  it('returns stdout and exit code 0 on success', async () => {
    const r = makeRepo();
    try {
      const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: r.dir });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('true');
    } finally {
      r.cleanup();
    }
  });

  it('returns the exit code and stderr on failure instead of throwing', async () => {
    const r = makeRepo();
    try {
      const result = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/nope'], { cwd: r.dir });
      expect(result.code).not.toBe(0);
    } finally {
      r.cleanup();
    }
  });

  it('ignores a GIT_DIR in the parent environment', async () => {
    const r = makeRepo();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/definitely/not/a/repo';
    try {
      const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: r.dir });
      expect(result.stdout.trim()).toBe('true');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      r.cleanup();
    }
  });

  it('kills a command that runs past its timeout', async () => {
    const r = makeRepo();
    try {
      // `git hash-object --stdin` waits for input that never comes.
      const result = await runGit(['hash-object', '--stdin'], { cwd: r.dir, timeoutMs: 200, keepStdinOpen: true });
      expect(result.timedOut).toBe(true);
    } finally {
      r.cleanup();
    }
  });

  it('rejects when git cannot be started at all', async () => {
    await expect(runGit(['status'], { cwd: '/', gitBinary: 'definitely-not-git-binary' })).rejects.toThrow();
  });
});
