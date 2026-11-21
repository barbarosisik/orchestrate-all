/**
 * Where the conductor's git calls point.
 *
 * Every call names its git folder explicitly: `--git-dir=<commonDir>` for repository-wide work, or
 * `--git-dir=<commonDir>/worktrees/<name> --work-tree=<path>` for a task's worktree. Git never looks for a
 * `.git` file or folder, so nothing a worker writes into its worktree (a rewritten `.git` file, a nested
 * repository) can point the conductor's git at another repository and its config.
 *
 * Every call also names the hooks folder explicitly (core.hooksPath):
 * - hooks off (the default): an empty folder in Orchestra's home, so no repository hook runs on Orchestra's
 *   internal steps (`worktree add` runs post-checkout, `update-ref` runs reference-transaction);
 * - hooks on: the user's own hooks folder, resolved once to a full path the way git resolves it in the main
 *   checkout. A relative core.hooksPath (husky's `.husky/_`) would otherwise be read relative to wherever a
 *   call runs: inside the `.git` folder, or inside a task's worktree, where a worker could plant a hook.
 */

import { mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_HOOK_POLICY } from '../config/defaults.js';
import { homeLayout, orchestraHome } from '../config/home.js';
import { DEFAULT_CASE_INSENSITIVE } from '../repo/canonical.js';
import { describeGitFailure, runGit, runGitRaw, type GitOptions, type GitResult, type RawGitResult } from './run.js';

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
 * Names git could run as a hook: hook names are lower-case letters, digits and "-" (pre-commit,
 * post-checkout, ...), and Git for Windows also tries "<name>.exe". Case is ignored, as Windows and macOS
 * ignore it. Anything else (.DS_Store, desktop.ini, pre-commit.sample) is never run.
 */
const HOOK_NAME = /^[a-z0-9-]+(?:\.exe)?$/i;

/** Orchestra's empty hooks folder. Refuses to continue if it holds anything git could run as a hook. */
function emptyHooksFolder(ctx: RepoContext): string {
  const dir = homeLayout(ctx.home).emptyHooks;
  mkdirSync(dir, { recursive: true });
  const found = readdirSync(dir).filter((name) => HOOK_NAME.test(name));
  if (found.length > 0) {
    throw new Error(
      `Orchestra's empty hooks folder "${dir}" contains ${found.slice(0, 3).join(', ')}. ` +
        'Files there would run as git hooks, so Orchestra stops. Check where they came from, then delete them.',
    );
  }
  return dir;
}

const userHooks = new WeakMap<RepoContext, Promise<string>>();

/** The user's hooks folder as git uses it in the main checkout: core.hooksPath, or `<commonDir>/hooks`. */
async function resolveUserHooks(ctx: RepoContext): Promise<string> {
  const result = await runGit(
    [`--git-dir=${ctx.commonDir}`, `--work-tree=${ctx.repoRoot}`, 'config', '--type=path', '--get', 'core.hooksPath'],
    { cwd: ctx.repoRoot },
  );
  if (result.code === 1) return join(ctx.commonDir, 'hooks');
  if (result.code !== 0) throw new Error(`Could not read core.hooksPath: ${describeGitFailure(result)}`);
  const value = result.stdout.replace(/\r?\n$/, '');
  // Git reads a relative core.hooksPath from the top of the checkout it runs in: here, the user's own.
  // resolve() also gives Windows paths their usual backslashes (git reports C:/...).
  return isAbsolute(value) ? resolve(value) : resolve(ctx.repoRoot, value);
}

/** The user's hooks folder, resolved once per context. */
export function userHooksFolder(ctx: RepoContext): Promise<string> {
  let pending = userHooks.get(ctx);
  if (pending === undefined) {
    pending = resolveUserHooks(ctx);
    userHooks.set(ctx, pending);
    pending.catch(() => userHooks.delete(ctx));
  }
  return pending;
}

/** The `-c core.hooksPath=<folder>` arguments every call gets. */
export async function hookArgs(ctx: RepoContext): Promise<string[]> {
  const folder = ctx.hooks === 'on' ? await userHooksFolder(ctx) : emptyHooksFolder(ctx);
  return ['-c', `core.hooksPath=${folder}`];
}

/** Runs git against the repository's shared folder. */
export async function repoGit(ctx: RepoContext, args: readonly string[], opts: ExtraGitOptions = {}): Promise<GitResult> {
  return runGit([`--git-dir=${ctx.commonDir}`, ...(await hookArgs(ctx)), ...args], { ...opts, cwd: ctx.commonDir });
}

/** Like repoGit, with stdout as raw bytes. */
export async function repoGitRaw(ctx: RepoContext, args: readonly string[], opts: ExtraGitOptions = {}): Promise<RawGitResult> {
  return runGitRaw([`--git-dir=${ctx.commonDir}`, ...(await hookArgs(ctx)), ...args], { ...opts, cwd: ctx.commonDir });
}

/** Runs git with a linked worktree's admin folder as the git folder and no work tree (to read its index). */
export async function adminGit(
  ctx: RepoContext,
  adminDir: string,
  args: readonly string[],
  opts: ExtraGitOptions = {},
): Promise<GitResult> {
  return runGit([`--git-dir=${adminDir}`, ...(await hookArgs(ctx)), ...args], { ...opts, cwd: adminDir });
}

/** Runs git inside a task's worktree, with its admin folder and work tree named explicitly. */
export async function worktreeGit(
  ctx: RepoContext,
  wt: WorktreeLocation,
  args: readonly string[],
  opts: ExtraGitOptions = {},
): Promise<GitResult> {
  return runGit([`--git-dir=${wt.adminDir}`, `--work-tree=${wt.path}`, ...(await hookArgs(ctx)), ...args], {
    ...opts,
    cwd: wt.path,
  });
}
