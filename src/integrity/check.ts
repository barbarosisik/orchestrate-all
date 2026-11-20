/**
 * Integrity checks (step 4, safeguard 2). Before a worker starts, take a baseline; after it stops (and again
 * after the acceptance commands), check that it changed nothing but the files in its own worktree:
 *
 * - the worktree folder is still a real folder where Orchestra made it, still linked to its own admin
 *   folder, which still links back and to the repository;
 * - its HEAD is still the task branch, the branch is a plain branch (not a link to another branch) where the
 *   conductor expects, the worktree is still locked, and its per-worktree config file is as created;
 * - no nested repository or git folder appeared inside the worktree;
 * - the user's refs (and which of them are links), what each of the user's checkouts has checked out, index
 *   entries hidden from `git status` (skip-worktree, assume-unchanged), the user's own linked worktrees, the
 *   repository's config, hooks and info files (and each submodule's), and every git config or attributes
 *   file git reads from outside the repository (global, system, included) are unchanged.
 *
 * Worktree control files are read directly; git only runs against the repository's shared folder (or, to
 * read an index, a user worktree's admin folder). HEADs are read through git, so repositories that keep
 * refs in a reftable (where HEAD files are placeholders) work too. Orchestra's own branches (orchestra/*) and
 * other Orchestra worktrees are left out of the repository-wide comparison: the conductor moves those itself,
 * always with compare-and-swap, and each task checks its own. Remote-tracking refs are left out too, so an
 * editor's background fetch is not reported as tampering.
 *
 * Not covered: the object store. A worker that can write there can damage it; the scope check re-hashes
 * every tree it relies on, so this can't hide an out-of-scope change (git/objects.ts).
 *
 * Note for the run manager: take baselines and checks while no Orchestra worktree is being created or
 * removed, so a half-made admin folder is never mistaken for one of the user's worktrees.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homeLayout } from '../config/home.js';
import { adminGit, repoGit, type RepoContext } from '../git/context.js';
import { describeGitFailure, type GitResult } from '../git/run.js';
import { canonicalPath, isInsidePath, samePath } from '../repo/canonical.js';
import { ORCHESTRA_REF_PREFIX } from '../run/names.js';
import { adminTarget, checkWorktreeLinks, sameLocation } from '../worktree/links.js';
import { listWorktrees, type TaskWorktree, type WorktreeEntry } from '../worktree/manager.js';
import { defaultGlobalGitFiles, gitConfigFiles } from './config-files.js';
import { diffRecords, fingerprintFolder, fingerprintPath, isEmptyDiff } from './fingerprint.js';
import { DEFAULT_MAX_SCAN_ENTRIES, scanForNestedGit } from './nested.js';

export { defaultGlobalGitFiles } from './config-files.js';

export interface IntegrityBaseline {
  /** Refs outside orchestra/ and refs/remotes/: the object each points at, and "-> <ref>" for a link. */
  readonly refs: Readonly<Record<string, string>>;
  /** What each of the user's checkouts (main and linked) has checked out, keyed by folder. */
  readonly checkouts: Readonly<Record<string, string>>;
  /** Index entries hidden from `git status` in the user's checkouts, keyed "<checkout>:<path>". */
  readonly hiddenIndex: Readonly<Record<string, string>>;
  /** The repository's own control files: config, HEAD, hooks/, info/, each submodule's config/hooks/info. */
  readonly repoFiles: Readonly<Record<string, string>>;
  /** Control files of the user's own linked worktrees, keyed "<admin folder name>/<file>". */
  readonly userWorktrees: Readonly<Record<string, string>>;
  /** Git config and attributes files outside the repository: global, system, included. */
  readonly configFiles: Readonly<Record<string, string>>;
}

export type IntegrityViolationCode =
  | 'worktree-folder'
  | 'git-pointer'
  | 'worktree-admin'
  | 'worktree-head'
  | 'worktree-config'
  | 'worktree-unlocked'
  | 'task-branch'
  | 'nested-git'
  | 'scan-incomplete'
  | 'user-refs'
  | 'user-checkouts'
  | 'hidden-index'
  | 'repo-files'
  | 'user-worktrees'
  | 'git-config-files'
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
  /**
   * Global git config and attributes files to watch even before they exist. Defaults to ~/.gitconfig and the
   * XDG config and attributes files. Files git actually reads (system, global, included) are always added.
   */
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
/** How deep to look for submodule git folders under `modules/` (submodule names may contain "/"). */
const MAX_MODULE_DEPTH = 8;
const MAX_LISTED = 8;

type Gathered<T> = { ok: true; value: T } | { ok: false; message: string };

function gitFailure<T>(what: string, result: GitResult): Gathered<T> {
  return { ok: false, message: `git ${what} failed: ${describeGitFailure(result)}` };
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

function byKey<T>(entries: Iterable<[string, T]>): Array<[string, T]> {
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function orchestraRoot(ctx: RepoContext): string {
  const root = homeLayout(ctx.home).worktrees;
  return canonicalPath(root) ?? root;
}

/** The git folders of submodules under `<commonDir>/modules`, as paths relative to the shared folder. */
async function submoduleGitFolders(commonDir: string): Promise<string[]> {
  const found: string[] = [];
  const pending: Array<{ rel: string; depth: number }> = [{ rel: 'modules', depth: 0 }];
  while (pending.length > 0) {
    const { rel, depth } = pending.pop() as { rel: string; depth: number };
    const entries = await readdir(join(commonDir, rel), { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.map((e) => e.name));
    if (rel !== 'modules' && names.has('HEAD') && (names.has('objects') || names.has('commondir'))) {
      found.push(rel);
      pending.push({ rel: `${rel}/modules`, depth: depth + 1 });
      continue;
    }
    if (depth >= MAX_MODULE_DEPTH) continue;
    for (const entry of entries) if (entry.isDirectory()) pending.push({ rel: `${rel}/${entry.name}`, depth: depth + 1 });
  }
  return found.sort();
}

async function repoFiles(ctx: RepoContext): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of REPO_FILES) result[file] = await fingerprintPath(join(ctx.commonDir, file));
  for (const folder of REPO_FOLDERS) Object.assign(result, await fingerprintFolder(join(ctx.commonDir, folder), folder));
  for (const module of await submoduleGitFolders(ctx.commonDir)) {
    result[`${module}/config`] = await fingerprintPath(join(ctx.commonDir, module, 'config'));
    for (const folder of REPO_FOLDERS) {
      Object.assign(result, await fingerprintFolder(join(ctx.commonDir, module, folder), `${module}/${folder}`));
    }
  }
  return result;
}

/** The user's own linked worktrees: every admin folder whose back-link points outside Orchestra's folder. */
async function userAdminFolders(ctx: RepoContext): Promise<Array<{ name: string; adminDir: string }>> {
  const parent = join(ctx.commonDir, 'worktrees');
  const names = await readdir(parent).catch(() => [] as string[]);
  const root = orchestraRoot(ctx);
  const result: Array<{ name: string; adminDir: string }> = [];
  for (const name of names.sort()) {
    const adminDir = join(parent, name);
    const target = adminTarget(adminDir);
    if (target !== null && isInsidePath(target, root, ctx.caseInsensitivePaths)) continue;
    result.push({ name, adminDir });
  }
  return result;
}

async function userWorktrees(ctx: RepoContext): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const { name, adminDir } of await userAdminFolders(ctx)) {
    for (const file of WORKTREE_FILES) result[`${name}/${file}`] = await fingerprintPath(join(adminDir, file));
  }
  return result;
}

interface RefInfo {
  readonly sha: string;
  /** The ref a symbolic ref points to; "" for a plain ref. */
  readonly symref: string;
}

async function allRefs(ctx: RepoContext): Promise<Gathered<Map<string, RefInfo>>> {
  const result = await repoGit(ctx, ['for-each-ref', '--format=%(objectname) %(symref) %(refname)']);
  if (result.code !== 0) return gitFailure('for-each-ref', result);
  const refs = new Map<string, RefInfo>();
  // Ref names can't contain spaces, so the three fields split cleanly.
  for (const line of result.stdout.split('\n')) {
    const [sha, symref, name] = line.split(' ');
    if (sha !== undefined && sha.length > 0 && name !== undefined && name.length > 0) {
      refs.set(name, { sha, symref: symref ?? '' });
    }
  }
  return { ok: true, value: refs };
}

function userRefs(refs: ReadonlyMap<string, RefInfo>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, info] of byKey(refs)) {
    if (name.startsWith(ORCHESTRA_REF_PREFIX) || name.startsWith('refs/remotes/')) continue;
    result[name] = info.symref === '' ? info.sha : `${info.sha} -> ${info.symref}`;
  }
  return result;
}

/** An Orchestra worktree, by the path git recorded or by where that path really leads. */
function isOrchestraCheckout(ctx: RepoContext, entry: WorktreeEntry): boolean {
  const root = orchestraRoot(ctx);
  const ci = ctx.caseInsensitivePaths;
  return isInsidePath(entry.path, root, ci) || isInsidePath(canonicalPath(entry.path) ?? entry.path, root, ci);
}

function userCheckouts(ctx: RepoContext, entries: readonly WorktreeEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (isOrchestraCheckout(ctx, entry)) continue;
    result[entry.path] = entry.bare ? 'bare' : (entry.branch ?? `detached at ${entry.head ?? 'nothing'}`);
  }
  return result;
}

/** Index entries `git status` doesn't show changes for: tag "S" (skip-worktree) or lower case (assume-unchanged). */
function hiddenEntries(label: string, output: string, into: Record<string, string>): void {
  for (const record of output.split('\u0000')) {
    const tab = record.indexOf('\t');
    if (tab === -1 || record.startsWith('H ')) continue;
    into[`${label}:${record.slice(tab + 1)}`] = record.slice(0, tab);
  }
}

async function hiddenIndex(ctx: RepoContext): Promise<Gathered<Record<string, string>>> {
  const args = ['ls-files', '--stage', '-t', '-v', '-z'];
  const result: Record<string, string> = {};
  const main = await repoGit(ctx, args);
  if (main.code !== 0) return gitFailure('ls-files', main);
  hiddenEntries('main', main.stdout, result);
  for (const { name, adminDir } of await userAdminFolders(ctx)) {
    const own = await adminGit(ctx, adminDir, args);
    if (own.code !== 0) return gitFailure('ls-files', own);
    hiddenEntries(`worktrees/${name}`, own.stdout, result);
  }
  return { ok: true, value: result };
}

async function configFiles(ctx: RepoContext, opts: IntegrityOptions): Promise<Gathered<Record<string, string>>> {
  const found = await gitConfigFiles(ctx, opts.globalGitFiles ?? defaultGlobalGitFiles());
  if (!found.ok) return found;
  const result: Record<string, string> = {};
  for (const file of found.files) result[file] = await fingerprintPath(file);
  return { ok: true, value: result };
}

interface State {
  readonly baseline: IntegrityBaseline;
  readonly refs: ReadonlyMap<string, RefInfo> | null;
  readonly worktrees: readonly WorktreeEntry[] | null;
  readonly failures: readonly string[];
}

/** Reads the current state. Parts git couldn't read are taken from `fallback` and listed in `failures`. */
async function readState(ctx: RepoContext, opts: IntegrityOptions, fallback: IntegrityBaseline | null): Promise<State> {
  const failures: string[] = [];
  const pick = <T, R>(gathered: Gathered<T>, use: (value: T) => R, otherwise: R): R => {
    if (gathered.ok) return use(gathered.value);
    failures.push(gathered.message);
    return otherwise;
  };
  const refs = await allRefs(ctx);
  const list = await listWorktrees(ctx);
  const worktrees: Gathered<WorktreeEntry[]> = list.ok
    ? { ok: true, value: list.worktrees }
    : { ok: false, message: list.error.message };
  const same = <T>(value: T): T => value;
  const baseline: IntegrityBaseline = {
    refs: pick(refs, userRefs, fallback?.refs ?? {}),
    checkouts: pick(worktrees, (entries) => userCheckouts(ctx, entries), fallback?.checkouts ?? {}),
    hiddenIndex: pick(await hiddenIndex(ctx), same, fallback?.hiddenIndex ?? {}),
    repoFiles: await repoFiles(ctx),
    userWorktrees: await userWorktrees(ctx),
    configFiles: pick(await configFiles(ctx, opts), same, fallback?.configFiles ?? {}),
  };
  return {
    baseline,
    refs: refs.ok ? refs.value : null,
    worktrees: worktrees.ok ? worktrees.value : null,
    failures,
  };
}

/** Records the repository-wide state a worker must not change. Throws if git can't read part of it. */
export async function takeBaseline(ctx: RepoContext, opts: IntegrityOptions = {}): Promise<IntegrityBaseline> {
  const state = await readState(ctx, opts, null);
  if (state.failures.length > 0) throw new Error(state.failures.join(' '));
  return state.baseline;
}

/** Problems with the task's own worktree folder and links, found by reading its control files (no git). */
async function worktreeProblems(ctx: RepoContext, wt: TaskWorktree): Promise<IntegrityViolation[]> {
  const real = canonicalPath(wt.path);
  if (real === null || !samePath(real, wt.path, ctx.caseInsensitivePaths)) {
    return [{ code: 'worktree-folder', message: `The worktree folder ${wt.path} is gone or was replaced by a link.` }];
  }
  const problems: IntegrityViolation[] = checkWorktreeLinks(wt, ctx.commonDir, ctx.caseInsensitivePaths).map(
    (p) => ({ code: p.code, message: p.message }),
  );
  if ((await fingerprintPath(join(wt.adminDir, 'config.worktree'))) !== wt.worktreeConfig) {
    problems.push({
      code: 'worktree-config',
      message: `The worktree's own config file (${join(wt.adminDir, 'config.worktree')}) changed. Git would read settings from it.`,
    });
  }
  return problems;
}

/** The task's checkout as git lists it: still on the task branch, still locked. */
function checkoutProblems(ctx: RepoContext, wt: TaskWorktree, entries: readonly WorktreeEntry[]): IntegrityViolation[] {
  const own = entries.find((e) => sameLocation(e.path, wt.path, ctx.caseInsensitivePaths));
  if (own === undefined) return [{ code: 'worktree-head', message: `Git no longer lists the worktree ${wt.path}.` }];
  const problems: IntegrityViolation[] = [];
  if (own.branch !== wt.ref) {
    problems.push({
      code: 'worktree-head',
      message: `The worktree's HEAD is ${own.branch ?? `detached at ${own.head ?? 'nothing'}`} instead of the task branch ${wt.branch}.`,
    });
  }
  if (own.locked === null) problems.push({ code: 'worktree-unlocked', message: 'The worktree is no longer locked.' });
  return problems;
}

function branchProblem(wt: TaskWorktree, refs: ReadonlyMap<string, RefInfo>, expectedTip: string): IntegrityViolation | null {
  const tip = refs.get(wt.ref);
  if (tip === undefined) return { code: 'task-branch', message: `The task branch ${wt.branch} was deleted.` };
  if (tip.symref !== '') {
    return { code: 'task-branch', message: `The task branch ${wt.branch} was turned into a link to ${tip.symref}.` };
  }
  if (tip.sha !== expectedTip) {
    return {
      code: 'task-branch',
      message: `The task branch ${wt.branch} moved to ${tip.sha.slice(0, 12)}; expected ${expectedTip.slice(0, 12)}.`,
    };
  }
  return null;
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
  const violations = await worktreeProblems(ctx, wt);

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

  const state = await readState(ctx, opts, baseline);
  for (const message of state.failures) violations.push({ code: 'git-failed', message });
  if (state.worktrees !== null) violations.push(...checkoutProblems(ctx, wt, state.worktrees));
  if (state.refs !== null) {
    const problem = branchProblem(wt, state.refs, expectedTip);
    if (problem !== null) violations.push(problem);
  }

  const current = state.baseline;
  const comparisons: Array<[IntegrityViolationCode, string, keyof IntegrityBaseline]> = [
    ['user-refs', 'Your refs changed', 'refs'],
    ['user-checkouts', 'What your checkouts have checked out changed', 'checkouts'],
    ['hidden-index', 'Index entries hidden from git status changed', 'hiddenIndex'],
    ['repo-files', "The repository's git files changed", 'repoFiles'],
    ['user-worktrees', 'Your other worktrees changed', 'userWorktrees'],
    ['git-config-files', 'Git config or attributes files outside the repository changed', 'configFiles'],
  ];
  for (const [code, what, key] of comparisons) {
    const description = describeDiff(baseline[key], current[key]);
    if (description !== null) violations.push({ code, message: `${what} since the last check (${description}).` });
  }

  return { ok: violations.length === 0, violations, baseline: current };
}
