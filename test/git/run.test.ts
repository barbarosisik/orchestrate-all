import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeGitFailure, findGitProgram, gitEnv, runGit, runGitRaw } from '../../src/git/run.js';
import { makeRepo } from '../helpers/tmprepo.js';

const WINDOWS = process.platform === 'win32';
const GIT_NAME = WINDOWS ? 'git.exe' : 'git';
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-path-'));
  scratch.push(dir);
  return dir;
}

/** A program named git that is not git: a shell script, or on Windows a copy of node.exe. */
function plantFakeGit(dir: string): string {
  const file = join(dir, GIT_NAME);
  if (WINDOWS) copyFileSync(process.execPath, file);
  else {
    writeFileSync(file, '#!/bin/sh\necho planted\n');
    chmodSync(file, 0o755);
  }
  return file;
}

/** The environment with PATH replaced (keeping Windows' own spelling of the variable). */
function withPath(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = path;
  return env;
}

const realGit = findGitProgram();

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

  it('rejects when PATH has no git', async () => {
    await expect(runGit(['--version'], { cwd: tmpdir(), env: withPath(tempDir()) })).rejects.toThrow(/not found in PATH/);
  });

  it('never runs a git program put in the folder it runs in, even when PATH lists "."', async () => {
    const dir = tempDir();
    plantFakeGit(dir);
    const env = withPath(['.', '', dirname(realGit ?? '')].join(delimiter));
    const result = await runGit(['--version'], { cwd: dir, env });
    expect(result.stdout).toMatch(/^git version/);
  });

  it('ignores replacement objects (refs/replace)', async () => {
    const r = makeRepo({ 'a.txt': 'real\n', 'b.txt': 'fake\n' });
    try {
      const real = r.git('rev-parse', 'HEAD:a.txt');
      r.git('replace', real, r.git('rev-parse', 'HEAD:b.txt'));
      expect(r.git('cat-file', '-p', real)).toBe('fake');
      const result = await runGit(['cat-file', '-p', real], { cwd: r.dir });
      expect(result.stdout).toBe('real\n');
    } finally {
      r.cleanup();
    }
  });
});

describe('findGitProgram', () => {
  it('finds git in PATH', () => {
    expect(realGit).not.toBeNull();
    expect(findGitProgram(withPath(dirname(realGit ?? '')))).toBe(realGit);
  });

  it('skips empty, relative and "." entries, and accepts a quoted folder', () => {
    const base = tempDir();
    const relative = join(base, 'rel');
    mkdirSync(relative);
    plantFakeGit(relative);
    const quoted = join(base, 'with space');
    mkdirSync(quoted);
    const wanted = plantFakeGit(quoted);
    const saved = process.cwd();
    process.chdir(base);
    try {
      expect(findGitProgram(withPath(['', '.', 'rel', `"${quoted}"`].join(delimiter)))).toBe(wanted);
      expect(findGitProgram(withPath(['', '.', 'rel'].join(delimiter)))).toBeNull();
    } finally {
      process.chdir(saved);
    }
  });

  it('skips a folder named git', () => {
    const base = tempDir();
    mkdirSync(join(base, GIT_NAME));
    expect(findGitProgram(withPath(base))).toBeNull();
  });

  it.skipIf(WINDOWS)('skips a git file that is not executable', () => {
    const base = tempDir();
    writeFileSync(join(base, 'git'), '#!/bin/sh\n');
    chmodSync(join(base, 'git'), 0o644);
    expect(findGitProgram(withPath(base))).toBeNull();
  });

  it('reads PATH whatever its spelling', () => {
    expect(findGitProgram({ Path: dirname(realGit ?? '') })).toBe(realGit);
    expect(findGitProgram({})).toBeNull();
  });
});

describe('runGitRaw', () => {
  it('returns stdout as bytes, unchanged', async () => {
    const r = makeRepo({ 'bin.dat': 'x' });
    try {
      const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x0a]);
      writeFileSync(join(r.dir, 'bin.dat'), bytes);
      const blob = r.git('hash-object', '-w', 'bin.dat');
      const result = await runGitRaw(['cat-file', 'blob', blob], { cwd: r.dir });
      expect(Buffer.compare(result.stdout, bytes)).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});

describe('runGit with a private index', () => {
  it('stages into the given index file and leaves the repository index alone', async () => {
    const r = makeRepo({ 'a.txt': 'a\n' });
    const dir = mkdtempSync(join(tmpdir(), 'orch-index-'));
    try {
      const indexFile = join(dir, 'index');
      const head = r.git('rev-parse', 'HEAD');
      expect((await runGit(['read-tree', head], { cwd: r.dir, indexFile })).code).toBe(0);
      r.write('b.txt', 'b\n');
      expect((await runGit(['add', '-A'], { cwd: r.dir, indexFile })).code).toBe(0);
      const staged = await runGit(['diff', '--cached', '--name-only', head], { cwd: r.dir, indexFile });
      expect(staged.stdout.trim()).toBe('b.txt');
      expect(existsSync(indexFile)).toBe(true);
      expect(r.git('diff', '--cached', '--name-only')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      r.cleanup();
    }
  });
});

describe('describeGitFailure', () => {
  it('prefers a timeout, then the first stderr line, then the exit code', () => {
    expect(describeGitFailure({ code: null, stdout: '', stderr: 'x', timedOut: true })).toBe('timed out');
    expect(describeGitFailure({ code: 128, stdout: '', stderr: 'fatal: bad\nmore\n', timedOut: false })).toBe('fatal: bad');
    expect(describeGitFailure({ code: 1, stdout: '', stderr: '', timedOut: false })).toBe('exit code 1');
  });
});
