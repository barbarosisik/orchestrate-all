/**
 * A throwaway repository plus a throwaway ORCHESTRA_HOME, both in the OS temp folder, and the RepoContext
 * that ties them together. Tests never touch a real project or the real ~/.orchestra.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoContext, type HookPolicy, type RepoContext } from '../../src/git/context.js';
import { canonicalPath } from '../../src/repo/canonical.js';
import { makeRepo, type TmpRepo } from './tmprepo.js';

export interface Fixture {
  readonly repo: TmpRepo;
  readonly home: string;
  readonly ctx: RepoContext;
  /** The commit `main` points at when the fixture is made. */
  readonly base: string;
  cleanup(): void;
}

export interface FixtureOptions {
  readonly files?: Record<string, string>;
  readonly hooks?: HookPolicy;
  /** A sub-folder name for the home, e.g. to test spaces or non-ASCII characters. */
  readonly homeName?: string;
  /** Extra `git init` arguments for the repository. */
  readonly initArgs?: readonly string[];
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
  const repo = makeRepo(opts.files, { initArgs: opts.initArgs ?? [] });
  // The test helper's git ignores system config, Orchestra's git doesn't (Git for Windows sets
  // core.autocrlf=true there). Pin it in the repository so both see the same line endings; the
  // autocrlf=true case has its own test.
  repo.git('config', 'core.autocrlf', 'false');
  const homeParent = mkdtempSync(join(tmpdir(), 'orch-home-'));
  const home = join(homeParent, opts.homeName ?? 'home');
  mkdirSync(home, { recursive: true });
  const ctx = repoContext(
    { repoRoot: canonicalPath(repo.dir) ?? repo.dir, gitCommonDir: canonicalPath(join(repo.dir, '.git')) ?? '' },
    { home, hooks: opts.hooks ?? 'off' },
  );
  return {
    repo,
    home,
    ctx,
    base: repo.git('rev-parse', 'HEAD'),
    cleanup: () => {
      repo.cleanup();
      rmSync(homeParent, { recursive: true, force: true });
    },
  };
}

/**
 * Replaces a file's content as a worker could. Git for Windows marks a worktree's `.git` file hidden, and
 * Windows refuses to overwrite a hidden file in place, so the file is deleted first.
 */
export function rewriteFile(path: string, content: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, content);
}

/** Shell-friendly form of a path for a hook script (Git for Windows' sh understands C:/...). */
function shPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Installs a repository hook that appends its name to `marker` whenever it runs. */
export function installHook(fixture: Fixture, name: string, marker: string): void {
  const hooksDir = join(fixture.ctx.commonDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const file = join(hooksDir, name);
  writeFileSync(file, `#!/bin/sh\necho ${name} >> "${shPath(marker)}"\n`);
  chmodSync(file, 0o755);
}

/** True when the installed git accepts these `git init` arguments (newer formats need a newer git). */
export function gitSupports(initArgs: readonly string[]): boolean {
  try {
    makeRepo({ 'a.txt': 'a\n' }, { initArgs }).cleanup();
    return true;
  } catch {
    return false;
  }
}

/** Runs a fixture-owned list of cleanups after each test. */
export function fixtures(): { make(opts?: FixtureOptions): Fixture; cleanupAll(): void } {
  const made: Fixture[] = [];
  return {
    make(opts?: FixtureOptions): Fixture {
      const f = makeFixture(opts);
      made.push(f);
      return f;
    },
    cleanupAll(): void {
      while (made.length > 0) made.pop()?.cleanup();
    },
  };
}
