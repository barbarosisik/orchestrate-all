/**
 * The worktree manager (step 3). Each task gets its own checkout of the project, outside the user's
 * repository, on its own branch:
 *
 *   folder: <ORCHESTRA_HOME>/wt/<runId>/<taskId>
 *   branch: orchestra/<runId>/<taskId>, created at the task's start commit
 *
 * A run also gets check worktrees on its own branches (`<home>/wt/<runId>/integration` on
 * `orchestra/<runId>/integration`, and `.../finalize`), where the combined result is tested (step 8).
 *
 * The worktree is created locked (so `git worktree prune` and other tools leave it alone) and stays locked
 * until Orchestra removes it. Removal only ever touches folders under `<home>/wt` and branches under
 * `orchestra/`, and deletes a branch only if it still points where the caller expects.
 *
 * `<home>/wt` and the run folder must be real folders, never links: a link put there by a worker would send
 * a new checkout, or a removal, somewhere else (into the user's repository, or onto files to delete).
 *
 * Sparse checkouts are refused for now: a new worktree copies the main checkout's sparse settings, and the
 * scope check expects every file of the commit to be in the worktree.
 */

import { lstatSync, mkdirSync } from 'node:fs';
import { lstat, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homeLayout } from '../config/home.js';
import { repoGit, worktreeGit, type RepoContext } from '../git/context.js';
import { describeGitFailure, LONG_GIT_TIMEOUT_MS } from '../git/run.js';
import { fingerprintPath } from '../integrity/fingerprint.js';
import { canonicalPath, isInsidePath, samePath } from '../repo/canonical.js';
import { branchRef, isRunBranchName, isValidRunId, isValidTaskId, taskBranch, type RunBranchName } from '../run/names.js';
import { adminTarget, checkWorktreeLinks, findAdminDir, sameLocation } from './links.js';

export interface TaskWorktree {
  readonly runId: string;
  /** The task's id; for a check worktree, the run branch's name ("integration" or "finalize"). */
  readonly taskId: string;
  /** Canonical folder of the checkout: `<home>/wt/<runId>/<taskId>`. */
  readonly path: string;
  /** `orchestra/<runId>/<taskId>` */
  readonly branch: string;
  /** `refs/heads/orchestra/<runId>/<taskId>` */
  readonly ref: string;
  /** The commit the branch was created at (or, for a check worktree, pointed at when it was checked out). */
  readonly startSha: string;
  /** Git's admin folder for this worktree, `<commonDir>/worktrees/<name>`, found and checked at creation. */
  readonly adminDir: string;
  /** The lock reason git keeps while Orchestra owns the worktree. */
  readonly lockReason: string;
  /**
   * Fingerprint of the worktree's own config file (`<adminDir>/config.worktree`) at creation: "missing", or
   * the copy git makes of the main checkout's file when the repository uses per-worktree config. Any later
   * change is tampering.
   */
  readonly worktreeConfig: string;
}

export type WorktreeErrorCode =
  | 'bad-name'
  | 'bad-start'
  | 'home-overlaps-repo'
  | 'path-exists'
  | 'branch-exists'
  | 'bad-branch'
  | 'git-failed'
  | 'bad-layout'
  | 'unsupported';

export interface WorktreeError {
  readonly code: WorktreeErrorCode;
  readonly message: string;
}

export type CreateResult = { ok: true; worktree: TaskWorktree } | { ok: false; error: WorktreeError };

export interface CreateInput {
  readonly runId: string;
  readonly taskId: string;
  /** Full commit id: the plan's base commit, or the integration tip for a task with dependencies. */
  readonly startSha: string;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(code: WorktreeErrorCode, message: string): CreateResult {
  return { ok: false, error: { code, message } };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True for a real folder; false for a link (or Windows junction), a file, or nothing. */
function isRealFolder(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The commit a task starts from: the plan's base commit, or for a task with dependencies the integration
 * branch tip, which by then holds its dependencies' merged work.
 */
export function startCommitFor(
  task: { readonly id: string; readonly dependsOn: readonly string[] },
  baseSha: string,
  integrationTip?: string,
): string {
  if (task.dependsOn.length === 0) return baseSha;
  if (integrationTip === undefined) {
    throw new Error(`Task "${task.id}" depends on ${task.dependsOn.join(', ')}; merge those first.`);
  }
  return integrationTip;
}

/**
 * `<home>/wt` as a canonical path, created if needed. The home folder itself may be a link (the user's
 * choice); `wt` must be a real folder. Null if it isn't.
 */
function worktreeRoot(ctx: RepoContext): string | null {
  mkdirSync(ctx.home, { recursive: true });
  const home = canonicalPath(ctx.home);
  if (home === null) return null;
  const root = homeLayout(home).worktrees;
  mkdirSync(root, { recursive: true });
  return isRealFolder(root) ? root : null;
}

/** Problems with the run folder Orchestra is about to use, or null. */
function runFolderProblem(runDir: string): string | null {
  try {
    lstatSync(runDir);
  } catch {
    return null;
  }
  return isRealFolder(runDir) ? null : `${runDir} is not a real folder (a link or a file was put there).`;
}

function overlapsRepo(ctx: RepoContext, folder: string): boolean {
  const ci = ctx.caseInsensitivePaths;
  return (
    isInsidePath(folder, ctx.repoRoot, ci) ||
    isInsidePath(ctx.repoRoot, folder, ci) ||
    isInsidePath(folder, ctx.commonDir, ci)
  );
}

/** A worktree for one of the run's own branches, which already exists and must point at `tip`. */
export interface CheckWorktreeInput {
  readonly runId: string;
  readonly name: RunBranchName;
  readonly tip: string;
}

interface AddInput {
  readonly runId: string;
  /** Folder and branch name: a task id, or a run branch name. */
  readonly name: string;
  readonly startSha: string;
  /** "new": create the branch at startSha; "existing": check out the run's branch, which must point at startSha. */
  readonly branch: 'new' | 'existing';
  readonly lockReason: string;
}

/**
 * Creates the task's worktree and branch at its start commit. Refuses an existing folder or branch: Orchestra
 * never reuses either.
 */
export function createTaskWorktree(ctx: RepoContext, input: CreateInput): Promise<CreateResult> {
  const { runId, taskId, startSha } = input;
  if (!isValidTaskId(taskId)) return Promise.resolve(fail('bad-name', `"${taskId}" is not a valid task id.`));
  return addWorktree(ctx, { runId, name: taskId, startSha, branch: 'new', lockReason: `orchestra run ${runId} task ${taskId}` });
}

/**
 * Checks out one of the run's own branches (`orchestra/<runId>/integration` or `.../finalize`) in a locked
 * worktree of its own, `<home>/wt/<runId>/<name>`, so the run's combined result can be tested there. The
 * branch must already exist and point at `tip`; removing the worktree later leaves the branch alone unless
 * asked otherwise.
 */
export function createCheckWorktree(ctx: RepoContext, input: CheckWorktreeInput): Promise<CreateResult> {
  const { runId, name, tip } = input;
  if (!isRunBranchName(name)) return Promise.resolve(fail('bad-name', `"${String(name)}" is not one of the run's branches.`));
  return addWorktree(ctx, { runId, name, startSha: tip, branch: 'existing', lockReason: `orchestra run ${runId} ${name}` });
}

export interface ReopenInput {
  readonly runId: string;
  readonly taskId: string;
  /** Where the task branch must point: its latest commit, as the run recorded it. */
  readonly tip: string;
}

/**
 * Checks the task's existing branch out again, at `tip`, in a fresh locked worktree at its usual folder (step 12):
 * for each revision round, and after a crash, so nothing a worker or an acceptance command left in the old folder
 * (a planted `.claude/settings.json`, say) is there for the next worker. The old folder must be gone (removed with
 * removeTaskWorktree, keeping the branch). The returned handle's `startSha` is `tip`.
 */
export function reopenTaskWorktree(ctx: RepoContext, input: ReopenInput): Promise<CreateResult> {
  const { runId, taskId, tip } = input;
  if (!isValidTaskId(taskId)) return Promise.resolve(fail('bad-name', `"${taskId}" is not a valid task id.`));
  return addWorktree(ctx, { runId, name: taskId, startSha: tip, branch: 'existing', lockReason: `orchestra run ${runId} task ${taskId}` });
}

/** Why the run's existing branch can't be checked out at `tip`, or null. */
async function existingBranchProblem(ctx: RepoContext, ref: string, branch: string, tip: string): Promise<string | null> {
  const link = await repoGit(ctx, ['symbolic-ref', '--quiet', ref]);
  if (link.code === 0) return `Branch ${branch} is a link to ${link.stdout.trim()}, not a plain branch.`;
  const at = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (at.code !== 0) return `Branch ${branch} does not exist.`;
  if (at.stdout.trim() !== tip) return `Branch ${branch} is at ${at.stdout.trim().slice(0, 12)}, not at ${tip.slice(0, 12)}.`;
  return null;
}

async function addWorktree(ctx: RepoContext, input: AddInput): Promise<CreateResult> {
  const { runId, name, startSha, lockReason } = input;
  if (!isValidRunId(runId)) return fail('bad-name', `"${runId}" is not a valid run id.`);
  if (!FULL_SHA.test(startSha)) return fail('bad-start', `"${startSha}" is not a full commit id.`);

  const root = worktreeRoot(ctx);
  if (root === null) return fail('bad-layout', `${homeLayout(ctx.home).worktrees} is not a real folder.`);
  if (overlapsRepo(ctx, root)) {
    return fail(
      'home-overlaps-repo',
      `Orchestra's folder (${ctx.home}) overlaps the repository (${ctx.repoRoot}). ` +
        'Set ORCHESTRA_HOME to a folder outside the project.',
    );
  }
  const runDir = join(root, runId);
  const runProblem = runFolderProblem(runDir);
  if (runProblem !== null) return fail('bad-layout', runProblem);
  const path = join(runDir, name);
  if (pathExists(path)) return fail('path-exists', `${path} already exists. Orchestra never reuses a folder.`);

  const branch = taskBranch(runId, name);
  const ref = branchRef(branch);
  const start = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', `${startSha}^{commit}`]);
  if (start.code !== 0 || start.stdout.trim() !== startSha) {
    return fail('bad-start', `Commit ${startSha} is not in this repository.`);
  }
  if (input.branch === 'new') {
    const existing = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
    if (existing.code === 0) return fail('branch-exists', `Branch ${branch} already exists.`);
  } else {
    const problem = await existingBranchProblem(ctx, ref, branch, startSha);
    if (problem !== null) return fail('bad-branch', problem);
  }

  mkdirSync(runDir, { recursive: true });
  const add = await repoGit(
    ctx,
    [
      // Absolute links, which the checks below and in the integrity step expect.
      '-c',
      'worktree.useRelativePaths=false',
      // Parallel checkout has been reported to race on Windows.
      '-c',
      'checkout.workers=1',
      'worktree',
      'add',
      '--quiet',
      '--lock',
      '--reason',
      lockReason,
      ...(input.branch === 'new' ? ['-b', branch, path, startSha] : [path, branch]),
    ],
    { timeoutMs: LONG_GIT_TIMEOUT_MS },
  );

  const guessAdmin = join(ctx.commonDir, 'worktrees', name);
  const partial: TaskWorktree = {
    runId,
    taskId: name,
    path,
    branch,
    ref,
    startSha,
    adminDir: guessAdmin,
    lockReason,
    worktreeConfig: 'missing',
  };
  // Cleanup after a failure goes through removeTaskWorktree, which refuses anything not laid out as expected.
  // A branch this call didn't create is never deleted.
  const undo = async (handle: TaskWorktree, message: string, code: WorktreeErrorCode): Promise<CreateResult> => {
    const removed = await removeTaskWorktree(ctx, handle, {
      ...(input.branch === 'new' ? { deleteBranchAt: startSha } : {}),
      retries: 0,
    });
    const leftover = removed.ok ? '' : ` Cleanup was incomplete: ${removed.problems.join(' ')}`;
    return fail(code, `${message}${leftover}`);
  };
  if (add.code !== 0) return undo(partial, `git worktree add failed: ${describeGitFailure(add)}`, 'git-failed');

  // The checkout must have landed exactly here, not through a link swapped in while git ran.
  const real = canonicalPath(path);
  if (real === null || !samePath(real, path, ctx.caseInsensitivePaths)) {
    return undo(partial, `git created the worktree somewhere other than ${path}.`, 'bad-layout');
  }
  const adminDir = findAdminDir(ctx.commonDir, path, ctx.caseInsensitivePaths);
  const problems =
    adminDir === null
      ? ['git did not record the new worktree under the repository’s worktrees folder.']
      : checkWorktreeLinks({ path, adminDir }, ctx.commonDir, ctx.caseInsensitivePaths).map((p) => p.message);
  if (adminDir === null || problems.length > 0) {
    const handle = { ...partial, adminDir: adminDir ?? guessAdmin };
    return undo(handle, `The new worktree is not linked as expected: ${problems.join(' ')}`, 'bad-layout');
  }

  const worktree: TaskWorktree = {
    ...partial,
    adminDir,
    worktreeConfig: await fingerprintPath(join(adminDir, 'config.worktree')),
  };
  // The branch it checked out, where it was expected (an existing branch may have moved meanwhile).
  const listed = await listWorktrees(ctx);
  const own = listed.ok ? listed.worktrees.find((e) => sameLocation(e.path, path, ctx.caseInsensitivePaths)) : undefined;
  if (own === undefined || own.branch !== ref || own.head !== startSha) {
    const found = own === undefined ? 'nothing git lists' : (own.branch ?? `a detached HEAD`) + ` at ${(own.head ?? '').slice(0, 12)}`;
    return undo(worktree, `The new worktree has ${found} checked out instead of ${branch} at ${startSha.slice(0, 12)}.`, 'bad-branch');
  }
  const sparse = await worktreeGit(ctx, worktree, ['config', '--type=bool', '--get', 'core.sparseCheckout']);
  if (sparse.code === 0 && sparse.stdout.trim() === 'true') {
    return undo(
      worktree,
      'This repository uses a sparse checkout, which Orchestra does not support yet. Tasks need a full checkout.',
      'unsupported',
    );
  }
  return { ok: true, worktree };
}

export interface RemoveOptions {
  /** Also delete the task branch, but only while it still points at this commit. */
  readonly deleteBranchAt?: string;
  /** Extra attempts when git can't remove the folder yet (on Windows a closing process may still hold files). */
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

export interface RemoveResult {
  /** Everything asked for was done. */
  readonly ok: boolean;
  readonly folderRemoved: boolean;
  /** The branch no longer exists (only reported when deletion was asked for). */
  readonly branchDeleted: boolean;
  readonly problems: readonly string[];
}

/** Why this handle is not something Orchestra created, or null. Removal refuses anything else. */
function ownershipProblem(ctx: RepoContext, wt: TaskWorktree): string | null {
  const ci = ctx.caseInsensitivePaths;
  if (!isValidRunId(wt.runId) || !(isValidTaskId(wt.taskId) || isRunBranchName(wt.taskId))) {
    return 'The run or task id is not valid.';
  }
  if (wt.branch !== taskBranch(wt.runId, wt.taskId) || wt.ref !== branchRef(wt.branch)) {
    return `"${wt.branch}" is not the Orchestra branch for this task.`;
  }
  const home = canonicalPath(ctx.home);
  const root = home === null ? null : homeLayout(home).worktrees;
  if (root === null || !samePath(wt.path, join(root, wt.runId, wt.taskId), ci) || overlapsRepo(ctx, wt.path)) {
    return `${wt.path} is not an Orchestra worktree folder.`;
  }
  // Nothing is deleted through a link: a worker could point one at the user's files.
  if (!isRealFolder(root)) return `${root} is not a real folder; Orchestra deletes nothing through a link.`;
  const runProblem = runFolderProblem(dirname(wt.path));
  if (runProblem !== null) return `${runProblem} Orchestra deletes nothing through a link.`;
  if (!samePath(dirname(wt.adminDir), join(ctx.commonDir, 'worktrees'), ci)) {
    return `${wt.adminDir} is not inside the repository's worktrees folder.`;
  }
  return null;
}

/** Deletes a folder without following links: a symlink put in its place is removed, not its target. */
async function deleteFolder(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) await unlink(path);
  else await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function removeTaskWorktree(
  ctx: RepoContext,
  wt: TaskWorktree,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const refusal = ownershipProblem(ctx, wt);
  if (refusal !== null) return { ok: false, folderRemoved: false, branchDeleted: false, problems: [refusal] };

  const problems: string[] = [];
  const retries = opts.retries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 500;

  // Fails harmlessly when the worktree is not locked or git has lost track of it.
  await repoGit(ctx, ['worktree', 'unlock', wt.path]);
  let gitFailure = '';
  // A symlink in place of the folder is never handed to git; it is simply unlinked below.
  for (let attempt = 0; attempt <= retries && pathExists(wt.path) && !isSymlink(wt.path); attempt++) {
    const result = await repoGit(ctx, ['worktree', 'remove', '--force', wt.path], { timeoutMs: LONG_GIT_TIMEOUT_MS });
    if (result.code === 0) {
      gitFailure = '';
      break;
    }
    gitFailure = describeGitFailure(result);
    if (attempt < retries) await delay(retryDelayMs * (attempt + 1));
  }

  // Git refuses a worktree whose links a worker broke; the folder is Orchestra's own, so delete it directly.
  if (pathExists(wt.path)) {
    try {
      await deleteFolder(wt.path);
    } catch (error) {
      problems.push(`Could not delete ${wt.path}: ${errorText(error)}${gitFailure ? ` (git: ${gitFailure})` : ''}`);
    }
  }
  const folderRemoved = !pathExists(wt.path);

  // Git's record of the worktree, if git didn't remove it: only a folder that points back at this worktree.
  const ci = ctx.caseInsensitivePaths;
  const gitFile = join(wt.path, '.git');
  const recorded = adminTarget(wt.adminDir);
  const adminDir =
    findAdminDir(ctx.commonDir, wt.path, ci) ??
    (recorded !== null && sameLocation(recorded, gitFile, ci) ? wt.adminDir : null);
  if (folderRemoved && adminDir !== null) {
    try {
      await rm(adminDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      // On Windows a git process may still hold a file there; git prunes the record later.
      problems.push(`Could not remove git's record of the worktree (${adminDir}): ${errorText(error)}`);
    }
  }

  let branchDeleted = false;
  if (opts.deleteBranchAt !== undefined) {
    const link = await repoGit(ctx, ['symbolic-ref', '--quiet', wt.ref]);
    const exists = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', wt.ref]);
    if (link.code === 0) {
      // The branch was turned into a link to another ref: remove the link itself, never what it points to.
      const unlinked = await repoGit(ctx, ['update-ref', '--no-deref', '-d', wt.ref]);
      branchDeleted = unlinked.code === 0;
      problems.push(
        `Branch ${wt.branch} had been turned into a link to ${link.stdout.trim()}; ` +
          (branchDeleted ? 'removed the link and left its target alone.' : `the link could not be removed (${describeGitFailure(unlinked)}).`),
      );
    } else if (exists.code !== 0) {
      branchDeleted = true;
    } else {
      const deleted = await repoGit(ctx, ['update-ref', '--no-deref', '-d', wt.ref, opts.deleteBranchAt]);
      branchDeleted = deleted.code === 0;
      if (!branchDeleted) {
        problems.push(
          `Kept branch ${wt.branch}: it no longer points at ${opts.deleteBranchAt.slice(0, 12)} ` +
            `(${describeGitFailure(deleted)}).`,
        );
      }
    }
  }

  // The run folder goes once its last worktree is gone (rmdir only removes an empty folder).
  if (folderRemoved) await rmdir(dirname(wt.path)).catch(() => undefined);
  return { ok: folderRemoved && problems.length === 0, folderRemoved, branchDeleted, problems };
}

/**
 * Removes a check worktree an earlier, interrupted check left behind, found by its folder. The run's branch
 * is kept. Returns null when there is nothing to remove.
 */
export async function removeLeftoverCheckWorktree(
  ctx: RepoContext,
  runId: string,
  name: RunBranchName,
): Promise<RemoveResult | null> {
  if (!isValidRunId(runId) || !isRunBranchName(name)) {
    return { ok: false, folderRemoved: false, branchDeleted: false, problems: ['The run id or branch name is not valid.'] };
  }
  const home = canonicalPath(ctx.home) ?? ctx.home;
  const path = join(homeLayout(home).worktrees, runId, name);
  if (!pathExists(path)) return null;
  const branch = taskBranch(runId, name);
  const handle: TaskWorktree = {
    runId,
    taskId: name,
    path,
    branch,
    ref: branchRef(branch),
    startSha: '',
    adminDir: findAdminDir(ctx.commonDir, path, ctx.caseInsensitivePaths) ?? join(ctx.commonDir, 'worktrees', name),
    lockReason: '',
    worktreeConfig: 'missing',
  };
  return removeTaskWorktree(ctx, handle);
}

/**
 * Removes a task's worktree folder when its handle was lost (after a crash), found by its usual folder, and with
 * `deleteBranchAt` also its branch, only while the branch still points there. Null when there is nothing to do.
 */
export async function removeLeftoverTaskWorktree(
  ctx: RepoContext,
  runId: string,
  taskId: string,
  opts: Pick<RemoveOptions, 'deleteBranchAt'> = {},
): Promise<RemoveResult | null> {
  if (!isValidRunId(runId) || !isValidTaskId(taskId)) {
    return { ok: false, folderRemoved: false, branchDeleted: false, problems: ['The run or task id is not valid.'] };
  }
  const home = canonicalPath(ctx.home) ?? ctx.home;
  const path = join(homeLayout(home).worktrees, runId, taskId);
  if (!pathExists(path) && opts.deleteBranchAt === undefined) return null;
  const branch = taskBranch(runId, taskId);
  const handle: TaskWorktree = {
    runId,
    taskId,
    path,
    branch,
    ref: branchRef(branch),
    startSha: '',
    adminDir: findAdminDir(ctx.commonDir, path, ctx.caseInsensitivePaths) ?? join(ctx.commonDir, 'worktrees', taskId),
    lockReason: '',
    worktreeConfig: 'missing',
  };
  return removeTaskWorktree(ctx, handle, opts);
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  /** Full ref name, e.g. "refs/heads/main"; null when detached or bare. */
  readonly branch: string | null;
  /** Lock reason ("" when locked without one), or null when not locked. */
  readonly locked: string | null;
  readonly prunable: boolean;
  readonly bare: boolean;
  readonly detached: boolean;
}

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  type Draft = { -readonly [K in keyof WorktreeEntry]: WorktreeEntry[K] };
  const entries: WorktreeEntry[] = [];
  let current: Draft | null = null;
  for (const token of output.split('\u0000')) {
    if (token.length === 0) {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    const space = token.indexOf(' ');
    const key = space === -1 ? token : token.slice(0, space);
    const value = space === -1 ? '' : token.slice(space + 1);
    if (key === 'worktree') {
      if (current !== null) entries.push(current);
      current = { path: value, head: null, branch: null, locked: null, prunable: false, bare: false, detached: false };
    } else if (current !== null) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'locked') current.locked = value;
      else if (key === 'prunable') current.prunable = true;
      else if (key === 'bare') current.bare = true;
      else if (key === 'detached') current.detached = true;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

export type ListResult = { ok: true; worktrees: WorktreeEntry[] } | { ok: false; error: WorktreeError };

/** All worktrees git knows for this repository, including the main checkout and the user's own. */
export async function listWorktrees(ctx: RepoContext): Promise<ListResult> {
  const result = await repoGit(ctx, ['worktree', 'list', '--porcelain', '-z']);
  if (result.code !== 0) {
    return { ok: false, error: { code: 'git-failed', message: `git worktree list failed: ${describeGitFailure(result)}` } };
  }
  return { ok: true, worktrees: parseWorktreeList(result.stdout) };
}
