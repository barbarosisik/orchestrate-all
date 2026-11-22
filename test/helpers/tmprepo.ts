/** Throwaway git repositories for tests. Never touches anything outside the OS temp folder. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

export interface TmpRepo {
  readonly dir: string;
  git(...args: string[]): string;
  /** Runs git with `input` on stdin (hash-object --stdin, mktree). */
  gitInput(input: string, ...args: string[]): string;
  write(relPath: string, content?: string): void;
  commitAll(message?: string): string;
  cleanup(): void;
}

export interface MakeRepoOptions {
  /** Extra `git init` arguments, e.g. ["--ref-format=reftable"] or ["--object-format=sha256"]. */
  readonly initArgs?: readonly string[];
}

export function makeRepo(files: Record<string, string> = { 'README.md': 'hello\n' }, opts: MakeRepoOptions = {}): TmpRepo {
  const dir = mkdtempSync(join(tmpdir(), 'orch-repo-'));
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  const gitInput = (input: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8', input }).trim();
  const write = (relPath: string, content = 'x\n'): void => {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const commitAll = (message = 'commit'): string => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  try {
    git('init', '-q', '-b', 'main', ...(opts.initArgs ?? []));
    for (const [p, c] of Object.entries(files)) write(p, c);
    commitAll('initial');
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return { dir, git, gitInput, write, commitAll, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
