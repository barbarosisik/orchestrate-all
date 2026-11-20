/**
 * Integrity checks (step 4, safeguard 2). Before a worker starts, take a baseline; after it stops (and again
 * after the acceptance commands), check that it changed nothing but the files in its own worktree:
 *
 * - the worktree still links to its own admin folder, which still links back and to the repository;
 * - its HEAD is still the task branch, the branch is where the conductor expects, the worktree is still
 *   locked, and no per-worktree config file appeared;
 * - no nested repository or git folder appeared inside the worktree;
 * - the user's refs, the main checkout's HEAD, the user's own linked worktrees, the repository's config,
 *   hooks and info files, and the user's global git config are unchanged.
 *
 * Worktree files are read directly, before any git runs; git only runs against the repository's shared
 * folder. Orchestra's own branches (orchestra/*) and other Orchestra worktrees are left out of the
 * repository-wide comparison: the conductor moves those itself, always with compare-and-swap, and each task
 * checks its own. Remote-tracking refs are left out too, so an editor's background fetch is not reported as
 * tampering.
 *
 * Note for the run manager: take baselines and checks while no Orchestra worktree is being created or
 * removed, so a half-made admin folder is never mistaken for one of the user's worktrees.
 */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { homeLayout } from '../config/home.js';
import { repoGit, type RepoContext } from '../git/context.js';
import { describeGitFailure } from '../git/run.js';
import { canonicalPath, isInsidePath } from '../repo/canonical.js';
import { ORCHESTRA_REF_PREFIX } from '../run/names.js';
import { adminTarget, checkWorktreeLinks, readControlFile, readControlLine } from '../worktree/links.js';
import type { TaskWorktree } from '../worktree/manager.js';
import { diffRecords, fingerprintFolder, fingerprintPath, isEmptyDiff } from './fingerprint.js';
import { DEFAULT_MAX_SCAN_ENTRIES, scanForNestedGit } from './nested.js';

export interface IntegrityBaseline {
  /** Refs outside orchestra/ and refs/remotes/, each with the object it points at. */
  readonly refs: Readonly<Record<string, string>>;
  /** The repository's own control files: config, HEAD, hooks/, info/ and a few more. */
  readonly repoFiles: Readonly<Record<string, string>>;
  /** Control files of the user's own linked worktrees, keyed "<admin folder name>/<file>". */
  readonly userWorktrees: Readonly<Record<string, string>>;
  /** The user's global git config files. */
  readonly globalFiles: Readonly<Record<string, string>>;
}

export type IntegrityViolationCode =
  | 'git-pointer'
  | 'worktree-admin'
  | 'worktree-head'
  | 'worktree-config'
  | 'worktree-unlocked'
  | 'task-branch'
  | 'nested-git'
  | 'scan-incomplete'
  | 'user-refs'
  | 'repo-files'
  | 'user-worktrees'
  | 'global-git-config'
  | 'git-failed';

export interface IntegrityViolation {
  readonly code: IntegrityViolationCode;
  readonly message: string;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly violations: readonly IntegrityViolation[];
  /** The state found now: the baseline for the next phase (for example the acceptance commands). */
  readonly baseline: IntegrityBaseline;
}

export interface IntegrityOptions {
  /** Global git config files to watch. Defaults to ~/.gitconfig and $XDG_CONFIG_HOME/git/config. */
  readonly globalGitFiles?: readonly string[];
  /** Upper bound on entries visited when scanning a worktree for nested git metadata. */
  readonly maxScanEntries?: number;
}

/** Single files in the repository's shared folder whose change would alter how git behaves. */
const REPO_FILES = ['config', 'config.worktree', 'HEAD', 'shallow', 'objects/info/alternates'] as const;
/** Folders in the shared folder whose whole content is watched. */
const REPO_FOLDERS = ['hooks', 'info'] as const;
/** Control files of a linked worktree's admin folder. */
const WORKTREE_FILES = ['HEAD', 'gitdir', 'commondir', 'config.worktree', 'locked'] as const;
const MAX_LISTED = 8;

export function defaultGlobalGitFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return [join(homedir(), '.gitconfig'), join(configHome, 'git', 'config')];
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

async function repoFiles(ctx: RepoContext): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of REPO_FILES) result[file] = await fingerprintPath(join(ctx.commonDir, file));
  for (const folder of REPO_FOLDERS) Object.assign(result, await fingerprintFolder(join(ctx.commonDir, folder), folder));
  return result;
}

/** The user's own linked worktrees: every admin folder whose back-link points outside Orchestra's folder. */
async function userWorktrees(ctx: RepoContext): Promise<Record<string, string>> {
  const parent = join(ctx.commonDir, 'worktrees');
  const names = await readdir(parent).catch(() => [] as string[]);
  const orchestraRoot = canonicalPath(homeLayout(ctx.home).worktrees) ?? homeLayout(ctx.home).worktrees;
  const result: Record<string, string> = {};
  for (const name of names.sort()) {
    const adminDir = join(parent, name);
    const target = adminTarget(adminDir);
    if (target !== null && isInsidePath(target, orchestraRoot, ctx.caseInsensitivePaths)) continue;
    for (const file of WORKTREE_FILES) result[`${name}/${file}`] = await fingerprintPath(join(adminDir, file));
  }
  return result;
}

async function globalFiles(opts: IntegrityOptions): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of opts.globalGitFiles ?? defaultGlobalGitFiles()) result[file] = await fingerprintPath(file);
  return result;
}

type RefsResult = { ok: true; refs: Map<string, string> } | { ok: false; message: string };

async function allRefs(ctx: RepoContext): Promise<RefsResult> {
  const result = await repoGit(ctx, ['for-each-ref', '--format=%(objectname) %(refname)']);
  if (result.code !== 0) return { ok: false, message: `git for-each-ref failed: ${describeGitFailure(result)}` };
  const refs = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) refs.set(line.slice(space + 1), line.slice(0, space));
  }
  return { ok: true, refs };
}

function userRefs(refs: ReadonlyMap<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, sha] of [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name.startsWith(ORCHESTRA_REF_PREFIX) || name.startsWith('refs/remotes/')) continue;
    result[name] = sha;
  }
  return result;
}

/** Records the repository-wide state a worker must not change. Throws if git can't list the refs. */
export async function takeBaseline(ctx: RepoContext, opts: IntegrityOptions = {}): Promise<IntegrityBaseline> {
  const refs = await allRefs(ctx);
  if (!refs.ok) throw new Error(refs.message);
  return {
    refs: userRefs(refs.refs),
    repoFiles: await repoFiles(ctx),
    userWorktrees: await userWorktrees(ctx),
    globalFiles: await globalFiles(opts),
  };
}

/** Problems with the task's own worktree, found by reading its control files (no git). */
function worktreeProblems(ctx: RepoContext, wt: TaskWorktree): IntegrityViolation[] {
  const problems: IntegrityViolation[] = checkWorktreeLinks(wt, ctx.commonDir, ctx.caseInsensitivePaths).map(
    (p) => ({ code: p.code, message: p.message }),
  );
  const head = readControlLine(join(wt.adminDir, 'HEAD'));
  if (head !== `ref: ${wt.ref}`) {
    problems.push({
      code: 'worktree-head',
      message: `The worktree's HEAD is "${head ?? 'missing'}" instead of the task branch ${wt.branch}.`,
    });
  }
  if (readControlFile(join(wt.adminDir, 'config.worktree')) !== null) {
    problems.push({
      code: 'worktree-config',
      message: `A per-worktree config file appeared (${join(wt.adminDir, 'config.worktree')}). Git would read settings from it.`,
    });
  }
  if (readControlFile(join(wt.adminDir, 'locked')) === null) {
    problems.push({ code: 'worktree-unlocked', message: 'The worktree is no longer locked.' });
  }
  return problems;
}

function describeDiff(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string | null {
  const diff = diffRecords(before, after);
  if (isEmptyDiff(diff)) return null;
  const parts: string[] = [];
  if (diff.changed.length > 0) parts.push(`changed: ${listed(diff.changed)}`);
  if (diff.added.length > 0) parts.push(`added: ${listed(diff.added)}`);
  if (diff.removed.length > 0) parts.push(`removed: ${listed(diff.removed)}`);
  return parts.join('; ');
}

/**
 * Compares the current state with a baseline, and checks the task's worktree and branch. `expectedTip` is
 * where the task branch should point: its start commit, or the commit the conductor made for it.
 */
export async function checkIntegrity(
  ctx: RepoContext,
  wt: TaskWorktree,
  baseline: IntegrityBaseline,
  expectedTip: string,
  opts: IntegrityOptions = {},
): Promise<IntegrityReport> {
  const violations = worktreeProblems(ctx, wt);

  const scan = await scanForNestedGit(wt.path, opts.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES);
  for (const finding of scan.findings) {
    const what = finding.kind === 'git-entry' ? 'a nested .git' : 'a folder laid out like a git repository';
    violations.push({ code: 'nested-git', message: `${finding.path} is ${what}. Git commands run there would use it.` });
  }
  if (!scan.complete) {
    violations.push({
      code: 'scan-incomplete',
      message: 'The worktree could not be fully scanned for nested git folders (too many files, or a folder could not be read).',
    });
  }

  const refs = await allRefs(ctx);
  let currentRefs = baseline.refs;
  if (!refs.ok) {
    violations.push({ code: 'git-failed', message: refs.message });
  } else {
    currentRefs = userRefs(refs.refs);
    const tip = refs.refs.get(wt.ref);
    if (tip !== expectedTip) {
      violations.push({
        code: 'task-branch',
        message:
          tip === undefined
            ? `The task branch ${wt.branch} was deleted.`
            : `The task branch ${wt.branch} moved to ${tip.slice(0, 12)}; expected ${expectedTip.slice(0, 12)}.`,
      });
    }
  }

  const current: IntegrityBaseline = {
    refs: currentRefs,
    repoFiles: await repoFiles(ctx),
    userWorktrees: await userWorktrees(ctx),
    globalFiles: await globalFiles(opts),
  };
  const comparisons: Array<[IntegrityViolationCode, string, keyof IntegrityBaseline]> = [
    ['user-refs', 'Your refs changed', 'refs'],
    ['repo-files', "The repository's git files changed", 'repoFiles'],
    ['user-worktrees', 'Your other worktrees changed', 'userWorktrees'],
    ['global-git-config', 'Your global git config changed', 'globalFiles'],
  ];
  for (const [code, what, key] of comparisons) {
    const description = describeDiff(baseline[key], current[key]);
    if (description !== null) violations.push({ code, message: `${what} since the last check (${description}).` });
  }

  return { ok: violations.length === 0, violations, baseline: current };
}
