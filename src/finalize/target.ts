/**
 * The user's branch at finalize time (step 8): what approving the run would do to it.
 *
 * The run started from the branch's tip (the plan's base commit). By the time the user approves, the branch
 * may have moved on. The preview merges the branch's current tip with the integration tip, exactly as the
 * real finalize will (the run's base commit as the merge base, no rename detection, see merge/integration.ts):
 *
 * - the branch must still contain the base commit; otherwise finalizing would bring back commits the user
 *   removed (a reset or a rebase), so it is refused;
 * - the base commit must be the branch's and the run's only common ancestor: if the user already merged part of
 *   the run by hand, the preview could not tell their later edits from the run's (it might undo a revert), so
 *   that is refused too;
 * - the merge must be clean (git's exit code decides);
 * - the result must be the branch's tip plus the run's changes: finalizing changes only paths the run
 *   changed, and every path the user didn't also change gets exactly the run's version;
 * - files added by the finalize must not clash in letter case with the user's files (Windows, macOS);
 * - paths changed both by the user (since the run started) and by the run are listed: git merged them, but
 *   the user should know.
 *
 * Every commit and tree involved is re-hashed first (git/objects.ts).
 */

import { repoGit, type RepoContext } from '../git/context.js';
import { readCommit, verifyTree, type ObjectProblem } from '../git/objects.js';
import { describeGitFailure } from '../git/run.js';
import { mergeTrees, overlapping } from '../merge/integration.js';
import { branchRef } from '../run/names.js';
import type { TreeChange } from '../scope/diff.js';
import { caseCollisions } from '../scope/rules.js';
import { diffTrees, treePaths } from '../scope/trees.js';
import { commitsSince } from './history.js';

export interface TargetInput {
  /** The user's branch, e.g. "main". */
  readonly targetBranch: string;
  /** The plan's base commit: where the branch was when the run started. */
  readonly baseSha: string;
  readonly integrationTip: string;
}

export interface TargetPreview {
  readonly branch: string;
  /** Where the branch is now. */
  readonly tip: string;
  /** The branch moved since the run started. */
  readonly moved: boolean;
  /** Commits on the branch since the run started. */
  readonly newCommits: number;
  /** The tree the branch would hold after finalizing. */
  readonly tree: string;
  /** What finalizing changes on the branch (its tip's tree to `tree`). */
  readonly changes: readonly TreeChange[];
  /** Paths changed both on the branch since the run started and by the run (merged cleanly by git). */
  readonly overlap: readonly string[];
}

export type TargetProblemCode =
  | 'bad-input'
  | 'bad-object'
  | 'target-missing'
  | 'target-link'
  | 'target-rewritten'
  | 'target-has-run-work'
  | 'target-conflict'
  | 'case-clash'
  | 'unexpected-result'
  | 'git-failed';

export interface TargetProblem {
  readonly code: TargetProblemCode;
  readonly message: string;
  readonly paths: readonly string[];
}

export type TargetCheck = { ok: true; preview: TargetPreview } | { ok: false; problem: TargetProblem };

function refuse(code: TargetProblemCode, message: string, paths: readonly string[] = []): TargetCheck {
  return { ok: false, problem: { code, message, paths } };
}

function objectRefusal(problem: ObjectProblem): TargetCheck {
  if (problem.code === 'git-failed') return refuse('git-failed', problem.message);
  return refuse(problem.code === 'altered' ? 'bad-object' : 'bad-input', problem.message);
}

function changeKey(c: TreeChange): string {
  return `${c.path}\u0000${c.newMode}\u0000${c.newId}`;
}

function short(id: string): string {
  return id.slice(0, 12);
}

/** Previews finalizing the run into the user's branch. Changes nothing. */
export async function previewFinalize(ctx: RepoContext, input: TargetInput): Promise<TargetCheck> {
  const { targetBranch, baseSha, integrationTip } = input;
  const valid = await repoGit(ctx, ['check-ref-format', '--branch', targetBranch]);
  if (valid.code !== 0) return refuse('bad-input', `"${targetBranch}" is not a valid branch name.`);
  const ref = branchRef(targetBranch);
  const link = await repoGit(ctx, ['symbolic-ref', '--quiet', ref]);
  if (link.code === 0) {
    return refuse('target-link', `Your branch ${targetBranch} is now a link to ${link.stdout.trim()}; Orchestra won't finalize into it.`);
  }
  const at = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (at.code !== 0) return refuse('target-missing', `Your branch ${targetBranch} no longer exists.`);
  const tip = at.stdout.trim();

  // 1. Everything the preview relies on, re-hashed.
  const commits = await Promise.all([readCommit(ctx, tip), readCommit(ctx, baseSha), readCommit(ctx, integrationTip)]);
  for (const read of commits) if (!read.ok) return objectRefusal(read.problem);
  const [tipTree, baseTree, runTree] = commits.map((c) => (c.ok ? c.tree : '')) as [string, string, string];
  const verified = new Set<string>();
  for (const tree of [tipTree, baseTree, runTree]) {
    const checked = await verifyTree(ctx, tree, verified);
    if (!checked.ok) return objectRefusal(checked.problem);
  }

  // 2. The branch still holds the run's starting point.
  const contains = await repoGit(ctx, ['merge-base', '--is-ancestor', baseSha, tip]);
  if (contains.code === 1) {
    return refuse(
      'target-rewritten',
      `Your branch ${targetBranch} no longer contains ${short(baseSha)}, the commit the run started from (it was reset or ` +
        'rebased). Finalizing would bring back commits you removed, so Orchestra stops.',
    );
  }
  if (contains.code !== 0) return refuse('git-failed', `git merge-base failed: ${describeGitFailure(contains)}`);
  const common = await repoGit(ctx, ['merge-base', '--all', tip, integrationTip]);
  if (common.code !== 0) return refuse('git-failed', `git merge-base failed: ${describeGitFailure(common)}`);
  const bases = common.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (bases.length !== 1 || bases[0] !== baseSha) {
    return refuse(
      'target-has-run-work',
      `Your branch ${targetBranch} already contains part of this run's work (merged in by hand, at ` +
        `${bases.map(short).join(', ')}). Orchestra can't tell your later changes from the run's, so it stops. ` +
        'Undo that merge on your branch, or discard the run.',
    );
  }
  const newCommits = tip === baseSha ? 0 : await commitsSince(ctx, baseSha, tip);
  if (typeof newCommits === 'string') return refuse('git-failed', newCommits);

  // 3. The merge, as the real finalize will do it.
  const merged = await mergeTrees(ctx, baseSha, tip, integrationTip);
  if (merged.status === 'conflict') {
    return refuse(
      'target-conflict',
      `Your branch ${targetBranch} moved since the run started, and the run's work conflicts with it in ` +
        `${merged.paths.join(', ') || 'some paths'}.`,
      merged.paths,
    );
  }
  if (merged.status === 'failed') return refuse('git-failed', merged.message);
  const resultChecked = await verifyTree(ctx, merged.tree, verified);
  if (!resultChecked.ok) return objectRefusal(resultChecked.problem);

  // 4. Exactly the branch's tip plus the run's changes.
  const diffs = await Promise.all([diffTrees(ctx, baseTree, runTree), diffTrees(ctx, baseTree, tipTree), diffTrees(ctx, tipTree, merged.tree)]);
  for (const diff of diffs) if (!diff.ok) return refuse('git-failed', diff.message);
  const [runChanges, userChanges, changes] = diffs.map((d) => (d.ok ? d.changes : [])) as [TreeChange[], TreeChange[], TreeChange[]];
  const overlap = overlapping(
    runChanges.map((c) => c.path),
    userChanges.map((c) => c.path),
  );
  const runPaths = new Set(runChanges.map((c) => c.path));
  const shared = new Set(overlap);
  const finalKeys = new Set(changes.map(changeKey));
  const strays = changes.filter((c) => !runPaths.has(c.path)).map((c) => c.path);
  const missing = runChanges.filter((c) => !shared.has(c.path) && !finalKeys.has(changeKey(c))).map((c) => c.path);
  if (strays.length > 0 || missing.length > 0) {
    return refuse(
      'unexpected-result',
      'The previewed merge is not your branch plus the run’s changes.',
      [...strays, ...missing],
    );
  }

  // 5. New files must not clash in letter case with the branch's files.
  const added = changes.filter((c) => c.status === 'A').map((c) => c.path);
  if (added.length > 0) {
    const listed = await treePaths(ctx, merged.tree);
    if (!listed.ok) return refuse('git-failed', listed.message);
    const clashes = caseCollisions(added, listed.paths);
    if (clashes.size > 0) {
      const described = [...clashes].map(([path, spellings]) => `"${path}" (${spellings.join(' / ')})`);
      return refuse(
        'case-clash',
        `Files the run adds clash with files on your branch when letter case is ignored (Windows, macOS): ${described.join(', ')}.`,
        [...clashes.keys()],
      );
    }
  }

  return {
    ok: true,
    preview: { branch: targetBranch, tip, moved: tip !== baseSha, newCommits, tree: merged.tree, changes, overlap },
  };
}
