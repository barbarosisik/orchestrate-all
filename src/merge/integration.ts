/**
 * Merging (step 7, safeguard 4). Accepted tasks go into the run's integration branch
 * `orchestra/<runId>/integration`, one at a time and in dependency order. The user's branch is untouched
 * until they approve the finalize (checked in step 8, finalize/check.ts; done with their approval in step 13).
 *
 * Each merge is plain plumbing against the repository, never inside a worktree:
 * 1. the integration tip, the task's start commit and its commit are read and re-hashed (git/objects.ts);
 * 2. the task's own changes (start -> commit) go through the scope rules again;
 * 3. paths the integration branch changed since the task started must not be paths the task changed:
 *    Orchestra never merges two tasks' edits of the same file (ownership makes this impossible unless
 *    something is wrong);
 * 4. `git merge-tree --write-tree` with the task's start commit as the explicit merge base and no rename
 *    detection; its exit code decides between clean and conflicted (git's docs: an empty conflict list
 *    doesn't mean a clean merge);
 * 5. the result must be exactly the integration tip plus the task's changes, with the task's case clashes
 *    checked against the merged tree;
 * 6. `commit-tree` (Orchestra's identity, both parents, never signed, no hooks), then compare-and-swap
 *    `update-ref --no-deref`, then the new commit is read back and checked; if that fails, the branch is moved
 *    back.
 */

import { ORCHESTRA_GIT_IDENTITY } from '../config/defaults.js';
import { repoGit, type RepoContext } from '../git/context.js';
import { identityArgs, type CommitIdentity } from '../git/identity.js';
import { readCommit, verifyTree, type ObjectProblem } from '../git/objects.js';
import { describeGitFailure } from '../git/run.js';
import { toKey } from '../plan/paths.js';
import type { Task } from '../plan/schema.js';
import { branchRef, isValidRunId, RUN_BRANCH_NAMES, runBranch } from '../run/names.js';
import type { TreeChange } from '../scope/diff.js';
import { DEFAULT_SCOPE_RULES, evaluateScope, type ScopeRules } from '../scope/rules.js';
import { diffTrees, treePaths } from '../scope/trees.js';

/** The integration branch's last name part. No task may use it as its id (plan/validate.ts). */
export const INTEGRATION_NAME = RUN_BRANCH_NAMES.integration;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Merges never detect renames: a folder one side moved must not carry the other side's new files along.
 * The preview of the merge into the user's branch (step 8) uses the same settings, and so must the real one.
 */
export const NO_RENAMES: readonly string[] = ['-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false'];

export function integrationBranch(runId: string): string {
  return runBranch(runId, INTEGRATION_NAME);
}

export type TreeMerge =
  | { readonly status: 'clean'; readonly tree: string }
  | { readonly status: 'conflict'; readonly paths: readonly string[] }
  | { readonly status: 'failed'; readonly message: string };

/**
 * `git merge-tree --write-tree` of two commits with an explicit merge base and no rename detection. Its exit
 * code decides between clean and conflicted (git's docs: an empty conflict list doesn't mean a clean merge).
 */
export async function mergeTrees(ctx: RepoContext, base: string, ours: string, theirs: string): Promise<TreeMerge> {
  const merged = await repoGit(ctx, [
    ...NO_RENAMES,
    'merge-tree',
    '--write-tree',
    '-z',
    '--name-only',
    '--no-messages',
    `--merge-base=${base}`,
    ours,
    theirs,
  ]);
  const tokens = merged.stdout.split('\u0000');
  if (merged.code === 1) return { status: 'conflict', paths: tokens.slice(1).filter((t) => t.length > 0) };
  if (merged.code !== 0) return { status: 'failed', message: `git merge-tree failed: ${describeGitFailure(merged)}` };
  return { status: 'clean', tree: tokens[0] ?? '' };
}

export type MergeErrorCode =
  | 'bad-input'
  | 'bad-object'
  | 'out-of-scope'
  | 'overlap'
  | 'conflict'
  | 'unexpected-result'
  | 'branch-moved'
  | 'branch-exists'
  | 'git-failed'
  | 'recheck-failed';

export interface MergeError {
  readonly code: MergeErrorCode;
  readonly message: string;
  /** Paths involved: conflicted, overlapping or out of scope. */
  readonly paths: readonly string[];
}

function failure(code: MergeErrorCode, message: string, paths: readonly string[] = []): { ok: false; error: MergeError } {
  return { ok: false, error: { code, message, paths } };
}

function objectFailure(problem: ObjectProblem): { ok: false; error: MergeError } {
  if (problem.code === 'git-failed') return failure('git-failed', problem.message);
  return failure(problem.code === 'altered' ? 'bad-object' : 'bad-input', problem.message);
}

export type StartResult = { ok: true; branch: string; ref: string; tip: string } | { ok: false; error: MergeError };

/** Creates the run's integration branch at the base commit. Refuses if it already exists. */
export async function startIntegration(ctx: RepoContext, runId: string, baseSha: string): Promise<StartResult> {
  if (!isValidRunId(runId)) return failure('bad-input', `"${runId}" is not a valid run id.`);
  if (!FULL_SHA.test(baseSha)) return failure('bad-input', `"${baseSha}" is not a full commit id.`);
  const base = await readCommit(ctx, baseSha);
  if (!base.ok) return objectFailure(base.problem);
  const branch = integrationBranch(runId);
  const ref = branchRef(branch);
  // An all-zero old value means "only if it doesn't exist yet".
  const created = await repoGit(ctx, ['update-ref', '--no-deref', '-m', 'orchestra: start integration', ref, baseSha, '0'.repeat(baseSha.length)]);
  if (created.code !== 0) return failure('branch-exists', `Branch ${branch} already exists (${describeGitFailure(created)}).`);
  return { ok: true, branch, ref, tip: baseSha };
}

export type MergeTask = Pick<Task, 'id' | 'title' | 'kind' | 'mode' | 'owns'>;

export interface MergeInput {
  readonly runId: string;
  readonly task: MergeTask;
  /** The commit the task's worktree started from. */
  readonly start: string;
  /** The task's accepted commit. */
  readonly commit: string;
  /** Where the integration branch must point now. */
  readonly expectedTip: string;
  readonly identity?: CommitIdentity;
  readonly rules?: ScopeRules;
}

export type MergeResult =
  | { ok: true; merged: false; tip: string; changes: readonly TreeChange[] }
  | { ok: true; merged: true; tip: string; changes: readonly TreeChange[] }
  | { ok: false; error: MergeError };

/** The message for a merge commit: what was merged, then the run and task as trailers. */
export function mergeCommitMessage(runId: string, task: { readonly id: string; readonly title: string }): string {
  const title = task.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || task.id;
  return `Merge task ${task.id}: ${title}\n\nOrchestra-Run: ${runId}\nOrchestra-Task: ${task.id}\n`;
}

async function isAncestor(ctx: RepoContext, ancestor: string, descendant: string): Promise<boolean | string> {
  const result = await repoGit(ctx, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return `git merge-base failed: ${describeGitFailure(result)}`;
}

/** Comparison keys of every path and parent folder of the given paths (Windows and macOS ignore case). */
function keysWithFolders(paths: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) keys.add(toKey(parts.slice(0, depth).join('/').normalize('NFC')));
  }
  return keys;
}

/**
 * Task paths the integration branch also changed, ignoring case: the same path, a path inside it (the task's
 * file is their folder), or one of its folders (their file is the task's folder).
 */
export function overlapping(taskPaths: readonly string[], integrationPaths: readonly string[]): string[] {
  const theirFoldersAndFiles = keysWithFolders(integrationPaths);
  const theirFiles = new Set(integrationPaths.map((p) => toKey(p.normalize('NFC'))));
  return taskPaths.filter(
    (path) =>
      theirFoldersAndFiles.has(toKey(path.normalize('NFC'))) || [...keysWithFolders([path])].some((key) => theirFiles.has(key)),
  );
}

function changeKey(c: TreeChange): string {
  return `${c.path}\u0000${c.newMode}\u0000${c.newId}`;
}

/** Merges one accepted task into the integration branch. Changes nothing unless it returns merged: true. */
export async function mergeTask(ctx: RepoContext, input: MergeInput): Promise<MergeResult> {
  const { runId, task, start, commit, expectedTip } = input;
  if (!isValidRunId(runId)) return failure('bad-input', `"${runId}" is not a valid run id.`);
  for (const id of [start, commit, expectedTip]) {
    if (!FULL_SHA.test(id)) return failure('bad-input', `"${id}" is not a full commit id.`);
  }
  const ref = branchRef(integrationBranch(runId));

  // 1. Everything the merge relies on, re-hashed.
  const commits = await Promise.all([readCommit(ctx, expectedTip), readCommit(ctx, start), readCommit(ctx, commit)]);
  for (const read of commits) if (!read.ok) return objectFailure(read.problem);
  const [tipTree, startTree, taskTree] = commits.map((c) => (c.ok ? c.tree : '')) as [string, string, string];
  const verified = new Set<string>();
  for (const tree of [tipTree, startTree, taskTree]) {
    const checked = await verifyTree(ctx, tree, verified);
    if (!checked.ok) return objectFailure(checked.problem);
  }
  for (const [ancestor, descendant, what] of [
    [start, commit, 'The task commit does not descend from the task’s start commit.'],
    [start, expectedTip, 'The task did not start from this run’s integration history.'],
  ] as const) {
    const found = await isAncestor(ctx, ancestor, descendant);
    if (typeof found === 'string') return failure('git-failed', found);
    if (!found) return failure('bad-input', what);
  }

  // 2. The task's own changes, through the scope rules again.
  const taskDiff = await diffTrees(ctx, startTree, taskTree);
  if (!taskDiff.ok) return failure('git-failed', taskDiff.message);
  const changes = taskDiff.changes;
  if (changes.length === 0) return { ok: true, merged: false, tip: expectedTip, changes };
  const rules = input.rules ?? DEFAULT_SCOPE_RULES;
  const outOfScope = evaluateScope(task, changes, rules);
  if (outOfScope.length > 0) {
    return failure('out-of-scope', outOfScope.map((v) => v.message).join(' '), outOfScope.map((v) => v.path));
  }

  // 3. Nobody else changed the same paths since the task started.
  const sinceStart = await diffTrees(ctx, startTree, tipTree);
  if (!sinceStart.ok) return failure('git-failed', sinceStart.message);
  const clash = overlapping(
    changes.map((c) => c.path),
    sinceStart.changes.map((c) => c.path),
  );
  if (clash.length > 0) {
    return failure('overlap', `The integration branch also changed ${clash.map((p) => `"${p}"`).join(', ')} since this task started.`, clash);
  }

  // 4. The merge itself; its exit code decides.
  const merged = await mergeTrees(ctx, start, expectedTip, commit);
  if (merged.status === 'conflict') {
    const conflicts = merged.paths;
    return failure('conflict', `Merging task "${task.id}" conflicts in ${conflicts.join(', ') || 'some paths'}.`, conflicts);
  }
  if (merged.status === 'failed') return failure('git-failed', merged.message);
  const resultTree = merged.tree;
  const resultChecked = await verifyTree(ctx, resultTree, verified);
  if (!resultChecked.ok) return objectFailure(resultChecked.problem);

  // 5. Exactly the tip plus the task's changes; case clashes against the merged tree.
  const applied = await diffTrees(ctx, tipTree, resultTree);
  if (!applied.ok) return failure('git-failed', applied.message);
  const expected = changes.map(changeKey).sort().join('\n');
  if (applied.changes.map(changeKey).sort().join('\n') !== expected) {
    return failure('unexpected-result', 'The merge result differs from the integration tip plus the task’s own changes.');
  }
  if (changes.some((c) => c.status === 'A')) {
    const listed = await treePaths(ctx, resultTree);
    if (!listed.ok) return failure('git-failed', listed.message);
    const clashes = evaluateScope(task, changes, rules, listed.paths);
    if (clashes.length > 0) return failure('out-of-scope', clashes.map((v) => v.message).join(' '), clashes.map((v) => v.path));
  }

  // 6. Commit, compare-and-swap, read back.
  const made = await repoGit(
    ctx,
    [
      ...identityArgs(input.identity ?? ORCHESTRA_GIT_IDENTITY),
      'commit-tree',
      '--no-gpg-sign',
      resultTree,
      '-p',
      expectedTip,
      '-p',
      commit,
    ],
    { input: mergeCommitMessage(runId, task) },
  );
  if (made.code !== 0) return failure('git-failed', `git commit-tree failed: ${describeGitFailure(made)}`);
  const mergeCommit = made.stdout.trim();
  const moved = await repoGit(ctx, ['update-ref', '--no-deref', '-m', `orchestra: merge task ${task.id}`, ref, mergeCommit, expectedTip]);
  if (moved.code !== 0) {
    return failure('branch-moved', `The integration branch is no longer at ${expectedTip.slice(0, 12)}; nothing was merged.`);
  }

  const problem = await recheckMerge(ctx, ref, mergeCommit, resultTree, [expectedTip, commit]).catch(
    (error: unknown) => `The re-check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (problem !== null) {
    const undo = await repoGit(ctx, ['update-ref', '--no-deref', ref, expectedTip, mergeCommit]);
    const after = undo.code === 0 ? 'The branch was moved back.' : `Moving the branch back failed: ${describeGitFailure(undo)}`;
    return failure('recheck-failed', `${problem} ${after}`);
  }
  return { ok: true, merged: true, tip: mergeCommit, changes };
}

async function recheckMerge(
  ctx: RepoContext,
  ref: string,
  mergeCommit: string,
  tree: string,
  parents: readonly string[],
): Promise<string | null> {
  const tip = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (tip.code !== 0 || tip.stdout.trim() !== mergeCommit) return 'The integration branch does not point at the merge commit.';
  const read = await readCommit(ctx, mergeCommit);
  if (!read.ok) return read.problem.message;
  if (read.tree !== tree) return 'The merge commit does not hold the checked tree.';
  if (read.parents.join(' ') !== parents.join(' ')) return 'The merge commit does not have the expected parents.';
  return null;
}

/** Accepted tasks whose dependencies are all merged, in plan order: the ones that may merge next. */
export function readyToMerge(
  tasks: readonly { readonly id: string; readonly dependsOn: readonly string[] }[],
  accepted: ReadonlySet<string>,
  merged: ReadonlySet<string>,
): string[] {
  return tasks
    .filter((t) => accepted.has(t.id) && !merged.has(t.id) && t.dependsOn.every((d) => merged.has(d)))
    .map((t) => t.id);
}

export type RemoveResult = { ok: true } | { ok: false; error: MergeError };

/** Deletes the integration branch (discarding a run), only while it still points at `expectedTip`. */
export async function removeIntegration(ctx: RepoContext, runId: string, expectedTip: string): Promise<RemoveResult> {
  if (!isValidRunId(runId)) return failure('bad-input', `"${runId}" is not a valid run id.`);
  if (!FULL_SHA.test(expectedTip)) return failure('bad-input', `"${expectedTip}" is not a full commit id.`);
  const ref = branchRef(integrationBranch(runId));
  const deleted = await repoGit(ctx, ['update-ref', '--no-deref', '-d', ref, expectedTip]);
  if (deleted.code !== 0) {
    return failure('branch-moved', `Kept ${integrationBranch(runId)}: it no longer points at ${expectedTip.slice(0, 12)}.`);
  }
  return { ok: true };
}
