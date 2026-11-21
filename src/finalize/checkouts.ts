/**
 * The user's checkouts at finalize time (step 8): nothing of theirs may be overwritten.
 *
 * Finalizing moves the user's branch, and where that branch is checked out (the main checkout or one of the
 * user's own linked worktrees) its files are updated too. So, in every checkout that has the branch:
 * - no unsaved work (uncommitted changes, staged changes, conflicts, new files, ignored files) may sit on or
 *   under a path the finalize changes, nor be a folder or file in the way of one (step 2's check, run again);
 * - no index entry hidden from `git status` (assume-unchanged, skip-worktree) may sit on or under such a path:
 *   git would not see the user's edits there and could overwrite them;
 * - no merge, cherry-pick, revert or rebase may be half-done: finishing it would build on the old tip.
 * A rebase of the branch is also caught where the branch is not checked out (git detaches HEAD while
 * rebasing), since finishing it would move the branch back past the finalize.
 *
 * Staged changes elsewhere are allowed: the finalize (step 13) carries them over, as `git checkout` does.
 * Branch names are compared ignoring case where the file system does (`Main` and `main` are the same branch
 * file there), so a checkout of the branch spelled differently is not missed.
 *
 * Read-only: git runs with optional locks off, so the user's index is never written.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { worktreeGit, type RepoContext } from '../git/context.js';
import { describeGitFailure } from '../git/run.js';
import { isOrchestraCheckout } from '../integrity/check.js';
import { overlapping } from '../merge/integration.js';
import { canonicalPath } from '../repo/canonical.js';
import { parseStatusZ, type DirtyPath, type DirtyState } from '../repo/status.js';
import { branchRef } from '../run/names.js';
import { findAdminDir, readControlLine } from '../worktree/links.js';
import { listWorktrees } from '../worktree/manager.js';

export const CHECKOUT_PROBLEM_CODES = ['unsaved-work', 'operation-in-progress', 'git-failed'] as const;
export type CheckoutProblemCode = (typeof CHECKOUT_PROBLEM_CODES)[number];

export interface CheckoutProblem {
  readonly code: CheckoutProblemCode;
  readonly message: string;
  /** The checkout's folder. */
  readonly checkout: string;
  /** The user's paths at risk (for unsaved work). */
  readonly paths: readonly string[];
}

export interface CheckoutsReport {
  /** Folders where the branch is checked out: finalizing will update their files. */
  readonly checkouts: readonly string[];
  readonly problems: readonly CheckoutProblem[];
}

type RiskState = DirtyState | 'hidden';

const STATE_TEXT: Record<RiskState, string> = {
  changed: 'uncommitted change',
  conflicted: 'unresolved conflict',
  untracked: 'new file, not committed',
  ignored: 'ignored by git',
  hidden: 'marked assume-unchanged or skip-worktree, so git does not show its changes',
};

/** Files git keeps while an operation waits to be finished. */
const PENDING: ReadonlyArray<readonly [string, string]> = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase or git am'],
];
const MAX_LISTED = 8;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

/** True when anything (file or folder) is at `path`. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The branch a rebase in this git folder is rebasing, or null. */
function rebasing(gitDir: string): string | null {
  for (const folder of ['rebase-merge', 'rebase-apply']) {
    const head = readControlLine(join(gitDir, folder, 'head-name'));
    if (head !== null) return head;
  }
  return null;
}

/** Index entries `git status` doesn't report changes for: skip-worktree ("S") or assume-unchanged (lower case). */
function hiddenPaths(lsFilesOutput: string): string[] {
  const paths: string[] = [];
  for (const record of lsFilesOutput.split('\u0000')) {
    const tag = record[0];
    if (tag === undefined || record[1] !== ' ') continue;
    if (tag === 'S' || tag !== tag.toUpperCase()) paths.push(record.slice(2));
  }
  return paths;
}

/** Dirty paths that are on or under a path the finalize changes, or in its way (a file where it needs a folder). */
function atRisk<T extends { readonly path: string }>(dirty: readonly T[], changed: readonly string[]): T[] {
  const plain = dirty.map((d) => (d.path.endsWith('/') ? d.path.slice(0, -1) : d.path));
  const hits = new Set(overlapping(plain, changed));
  return dirty.filter((_, i) => hits.has(plain[i] as string));
}

/**
 * Checks every checkout of the user's branch before finalizing. `changedPaths` are the paths finalizing
 * changes (`TargetPreview.changes`).
 */
export async function checkTargetCheckouts(
  ctx: RepoContext,
  targetBranch: string,
  changedPaths: readonly string[],
): Promise<CheckoutsReport> {
  const ref = branchRef(targetBranch);
  const isTarget = (name: string | null): boolean =>
    name !== null && (ctx.caseInsensitivePaths ? name.toLowerCase() === ref.toLowerCase() : name === ref);
  const problems: CheckoutProblem[] = [];
  const checkouts: string[] = [];
  const list = await listWorktrees(ctx);
  if (!list.ok) {
    return { checkouts, problems: [{ code: 'git-failed', message: list.error.message, checkout: ctx.repoRoot, paths: [] }] };
  }

  for (const [index, entry] of list.worktrees.entries()) {
    // A checkout whose folder the user deleted (git calls it prunable) has no files left to overwrite.
    if (entry.bare || isOrchestraCheckout(ctx, entry) || (entry.prunable && !exists(entry.path))) continue;
    const folder = canonicalPath(entry.path) ?? entry.path;
    // Git lists the main checkout first; its git folder is the shared one. (The repository may have been
    // opened from a linked worktree, so ctx.repoRoot is not necessarily the main checkout.)
    const gitDir = index === 0 ? ctx.commonDir : findAdminDir(ctx.commonDir, folder, ctx.caseInsensitivePaths);
    if (gitDir === null) {
      problems.push({ code: 'git-failed', message: `Could not find git's folder for the checkout ${folder}.`, checkout: folder, paths: [] });
      continue;
    }

    const rebased = rebasing(gitDir);
    if (!isTarget(entry.branch)) {
      if (isTarget(rebased)) {
        problems.push({
          code: 'operation-in-progress',
          message: `A rebase of ${targetBranch} is in progress in ${folder}. Finish or abort it first.`,
          checkout: folder,
          paths: [],
        });
      }
      continue;
    }

    checkouts.push(folder);
    const pending = PENDING.filter(([name]) => exists(join(gitDir, name))).map(([, what]) => what);
    if (pending.length > 0) {
      problems.push({
        code: 'operation-in-progress',
        message: `${pending[0]} is in progress in ${folder}, which has ${targetBranch} checked out. Finish or abort it first.`,
        checkout: folder,
        paths: [],
      });
    }

    const location = { path: folder, adminDir: gitDir };
    const status = await worktreeGit(ctx, location, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--no-renames',
    ]);
    if (status.code !== 0) {
      problems.push({ code: 'git-failed', message: `git status failed in ${folder}: ${describeGitFailure(status)}`, checkout: folder, paths: [] });
      continue;
    }
    const hidden = await worktreeGit(ctx, location, ['ls-files', '-t', '-v', '-z']);
    if (hidden.code !== 0) {
      problems.push({ code: 'git-failed', message: `git ls-files failed in ${folder}: ${describeGitFailure(hidden)}`, checkout: folder, paths: [] });
      continue;
    }
    const dirty: Array<{ readonly path: string; readonly state: RiskState }> = [
      ...parseStatusZ(status.stdout),
      ...hiddenPaths(hidden.stdout).map((path) => ({ path, state: 'hidden' as const })),
    ];
    const risky = atRisk(dirty, changedPaths);
    if (risky.length > 0) {
      problems.push({
        code: 'unsaved-work',
        message:
          `${folder} has ${targetBranch} checked out, with unsaved work where finalizing would write: ` +
          `${listed(risky.map((d) => `${d.path} (${STATE_TEXT[d.state]})`))}. Commit, stash or move it first.`,
        checkout: folder,
        paths: risky.map((d) => d.path),
      });
    }
  }
  return { checkouts, problems };
}
