/**
 * Where the conductor's git calls point.
 *
 * Every call names its git folder explicitly: `--git-dir=<commonDir>` for repository-wide work, or
 * `--git-dir=<commonDir>/worktrees/<name> --work-tree=<path>` for a task's worktree. Git never looks for a
 * `.git` file or folder, so nothing a worker writes into its worktree (a rewritten `.git` file, a nested
 * repository) can point the conductor's git at another repository and its config.
 *
 * Unless the user allows hooks, every call also sets core.hooksPath to an empty folder, so no repository hook
 * runs on Orchestra's internal steps (`worktree add` runs post-checkout, `update-ref` runs
 * reference-transaction).
 */

import { mkdirSync, readdirSync } from 'node:fs';
import { DEFAULT_HOOK_POLICY } from '../config/defaults.js';
import { homeLayout, orchestraHome } from '../config/home.js';
import { DEFAULT_CASE_INSENSITIVE } from '../repo/canonical.js';
import { runGit, type GitOptions, type GitResult } from './run.js';

export type HookPolicy = 'off' | 'on';

export interface RepoContext {
  /** Canonical top folder of the user's checkout. */
  readonly repoRoot: string;
  /** Git's shared folder (objects, refs, config, worktrees/). */
  readonly commonDir: string;
  /** Orchestra's data folder. */
  readonly home: string;
  readonly hooks: HookPolicy;
  readonly caseInsensitivePaths: boolean;
}

export interface RepoContextOptions {
  readonly home?: string;
  readonly hooks?: HookPolicy;
  readonly caseInsensitivePaths?: boolean;
}

/** Builds the context from the result of the repository checks (`ReadyPlan` has both fields). */
export function repoContext(
  repo: { readonly repoRoot: string; readonly gitCommonDir: string },
  opts: RepoContextOptions = {},
): RepoContext {
  return {
    repoRoot: repo.repoRoot,
    commonDir: repo.gitCommonDir,
    home: opts.home ?? orchestraHome(),
    hooks: opts.hooks ?? DEFAULT_HOOK_POLICY,
    caseInsensitivePaths: opts.caseInsensitivePaths ?? DEFAULT_CASE_INSENSITIVE,
  };
}

/** A task worktree's folder and its admin folder inside the repository (`<commonDir>/worktrees/<name>`). */
export interface WorktreeLocation {
  readonly path: string;
  readonly adminDir: string;
}

export type ExtraGitOptions = Omit<GitOptions, 'cwd'>;

/**
 * The `-c core.hooksPath=<empty folder>` arguments, or nothing when hooks are allowed. Refuses to continue if
 * the folder isn't empty: a file there would run as a hook.
 */
export function hookArgs(ctx: RepoContext): string[] {
  if (ctx.hooks === 'on') return [];
  const dir = homeLayout(ctx.home).emptyHooks;
  mkdirSync(dir, { recursive: true });
  const found = readdirSync(dir);
  if (found.length > 0) {
    throw new Error(
      `Orchestra's empty hooks folder "${dir}" contains ${found.slice(0, 3).join(', ')}. ` +
        'Files there would run as git hooks, so Orchestra stops. Check where they came from, then delete them.',
    );
  }
  return ['-c', `core.hooksPath=${dir}`];
}

/** Runs git against the repository's shared folder. */
export async function repoGit(ctx: RepoContext, args: readonly string[], opts: ExtraGitOptions = {}): Promise<GitResult> {
  return runGit([`--git-dir=${ctx.commonDir}`, ...hookArgs(ctx), ...args], { ...opts, cwd: ctx.commonDir });
}

/** Runs git inside a task's worktree, with its admin folder and work tree named explicitly. */
export async function worktreeGit(
  ctx: RepoContext,
  wt: WorktreeLocation,
  args: readonly string[],
  opts: ExtraGitOptions = {},
): Promise<GitResult> {
  return runGit([`--git-dir=${wt.adminDir}`, `--work-tree=${wt.path}`, ...hookArgs(ctx), ...args], {
    ...opts,
    cwd: wt.path,
  });
}
