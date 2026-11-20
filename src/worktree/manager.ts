/**
 * The worktree manager (step 3). Each task gets its own checkout of the project, outside the user's
 * repository, on its own branch:
 *
 *   folder: <ORCHESTRA_HOME>/wt/<runId>/<taskId>
 *   branch: orchestra/<runId>/<taskId>, created at the task's start commit
 *
 * The worktree is created locked (so `git worktree prune` and other tools leave it alone) and stays locked
 * until Orchestra removes it. Removal only ever touches folders under `<home>/wt` and branches under
 * `orchestra/`, and deletes a branch only if it still points where the caller expects.
 */

import { lstatSync, mkdirSync } from 'node:fs';
import { lstat, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homeLayout } from '../config/home.js';
import { repoGit, type RepoContext } from '../git/context.js';
import { describeGitFailure } from '../git/run.js';
import { canonicalPath, isInsidePath, samePath } from '../repo/canonical.js';
import { branchRef, isValidRunId, isValidTaskId, taskBranch } from '../run/names.js';
import { adminTarget, checkWorktreeLinks, findAdminDir, sameLocation } from './links.js';

export interface TaskWorktree {
  readonly runId: string;
  readonly taskId: string;
  /** Canonical folder of the checkout: `<home>/wt/<runId>/<taskId>`. */
  readonly path: string;
  /** `orchestra/<runId>/<taskId>` */
  readonly branch: string;
  /** `refs/heads/orchestra/<runId>/<taskId>` */
  readonly ref: string;
  /** The commit the branch was created at. */
  readonly startSha: string;
  /** Git's admin folder for this worktree, `<commonDir>/worktrees/<name>`, found and checked at creation. */
  readonly adminDir: string;
  /** The lock reason git keeps while Orchestra owns the worktree. */
  readonly lockReason: string;
}

export type WorktreeErrorCode =
  | 'bad-name'
  | 'bad-start'
  | 'home-overlaps-repo'
  | 'path-exists'
  | 'branch-exists'
  | 'git-failed'
  | 'bad-layout';

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

/** Checking out or deleting a big tree can take a while; other git calls use the default timeout. */
export const LONG_GIT_TIMEOUT_MS = 10 * 60_000;
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

/** Creates `<home>/wt` and returns its canonical path. */
function worktreeRoot(ctx: RepoContext): string {
  const root = homeLayout(ctx.home).worktrees;
  mkdirSync(root, { recursive: true });
  return canonicalPath(root) ?? root;
}

function overlapsRepo(ctx: RepoContext, folder: string): boolean {
  const ci = ctx.caseInsensitivePaths;
  return (
    isInsidePath(folder, ctx.repoRoot, ci) ||
    isInsidePath(ctx.repoRoot, folder, ci) ||
    isInsidePath(folder, ctx.commonDir, ci)
  );
}

export async function createTaskWorktree(ctx: RepoContext, input: CreateInput): Promise<CreateResult> {
  const { runId, taskId, startSha } = input;
  if (!isValidRunId(runId)) return fail('bad-name', `"${runId}" is not a valid run id.`);
  if (!isValidTaskId(taskId)) return fail('bad-name', `"${taskId}" is not a valid task id.`);
  if (!FULL_SHA.test(startSha)) return fail('bad-start', `"${startSha}" is not a full commit id.`);

  const root = worktreeRoot(ctx);
  if (overlapsRepo(ctx, root)) {
    return fail(
      'home-overlaps-repo',
      `Orchestra's folder (${ctx.home}) overlaps the repository (${ctx.repoRoot}). ` +
        'Set ORCHESTRA_HOME to a folder outside the project.',
    );
  }
  const runDir = join(root, runId);
  const path = join(runDir, taskId);
  if (pathExists(path)) return fail('path-exists', `${path} already exists. Orchestra never reuses a folder.`);

  const branch = taskBranch(runId, taskId);
  const ref = branchRef(branch);
  const start = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', `${startSha}^{commit}`]);
  if (start.code !== 0 || start.stdout.trim() !== startSha) {
    return fail('bad-start', `Commit ${startSha} is not in this repository.`);
  }
  const existing = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (existing.code === 0) return fail('branch-exists', `Branch ${branch} already exists.`);

  mkdirSync(runDir, { recursive: true });
  const lockReason = `orchestra run ${runId} task ${taskId}`;
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
      '-b',
      branch,
      path,
      startSha,
    ],
    { timeoutMs: LONG_GIT_TIMEOUT_MS },
  );

  const canonical = canonicalPath(path) ?? path;
  const guessAdmin = join(ctx.commonDir, 'worktrees', taskId);
  const partial = { runId, taskId, path: canonical, branch, ref, startSha, adminDir: guessAdmin, lockReason };
  if (add.code !== 0) {
    await removeTaskWorktree(ctx, partial, { deleteBranchAt: startSha, retries: 0 });
    return fail('git-failed', `git worktree add failed: ${describeGitFailure(add)}`);
  }

  const adminDir = findAdminDir(ctx.commonDir, canonical, ctx.caseInsensitivePaths);
  const problems =
    adminDir === null
      ? ['git did not record the new worktree under the repository’s worktrees folder.']
      : checkWorktreeLinks({ path: canonical, adminDir }, ctx.commonDir, ctx.caseInsensitivePaths).map(
          (p) => p.message,
        );
  if (adminDir === null || problems.length > 0) {
    const handle = { ...partial, adminDir: adminDir ?? guessAdmin };
    await removeTaskWorktree(ctx, handle, { deleteBranchAt: startSha, retries: 0 });
    return fail('bad-layout', `The new worktree is not linked as expected: ${problems.join(' ')}`);
  }
  return { ok: true, worktree: { ...partial, adminDir } };
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
  if (!isValidRunId(wt.runId) || !isValidTaskId(wt.taskId)) return 'The run or task id is not valid.';
  if (wt.branch !== taskBranch(wt.runId, wt.taskId) || wt.ref !== branchRef(wt.branch)) {
    return `"${wt.branch}" is not the Orchestra branch for this task.`;
  }
  const root = canonicalPath(homeLayout(ctx.home).worktrees);
  if (root === null || !samePath(wt.path, join(root, wt.runId, wt.taskId), ci) || overlapsRepo(ctx, wt.path)) {
    return `${wt.path} is not an Orchestra worktree folder.`;
  }
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
    await rm(adminDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  let branchDeleted = false;
  if (opts.deleteBranchAt !== undefined) {
    const exists = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', wt.ref]);
    if (exists.code !== 0) {
      branchDeleted = true;
    } else {
      const deleted = await repoGit(ctx, ['update-ref', '-d', wt.ref, opts.deleteBranchAt]);
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
