/**
 * The integration branch's history, checked against what the conductor recorded (step 8).
 *
 * Orchestra's own branches are left out of the tamper checks (the conductor moves them itself, always with
 * compare-and-swap), so before the user approves, the integration branch is walked back to the run's base
 * commit: every commit on its first-parent line must be one of the recorded merges, in order, each with the
 * previous one and the task's accepted commit as its parents. Every commit and tree is re-hashed
 * (git/objects.ts).
 * Anything else on the branch (a commit added or replaced behind the conductor's back) stops the finalize.
 */

import { repoGit, type RepoContext } from '../git/context.js';
import { readCommit, verifyTree } from '../git/objects.js';
import { describeGitFailure } from '../git/run.js';
import { integrationBranch } from '../merge/integration.js';
import { branchRef } from '../run/names.js';
import type { TreeChange } from '../scope/diff.js';
import { diffTrees } from '../scope/trees.js';

export interface RecordedMerge {
  readonly taskId: string;
  /** The task's accepted commit. */
  readonly commit: string;
  /** The merge commit `mergeTask` made, or null when the task changed nothing and nothing was merged. */
  readonly mergeCommit: string | null;
}

export interface MergedChanges {
  readonly taskId: string;
  /** What the task's merge changed on the integration branch; empty when nothing was merged. */
  readonly changes: readonly TreeChange[];
}

export type HistoryCheck =
  | { ok: true; tasks: readonly MergedChanges[] }
  | { ok: false; message: string };

function short(id: string): string {
  return id.slice(0, 12);
}

/** Why the integration branch is not a plain branch at `tip`, or null. */
export async function integrationRefProblem(ctx: RepoContext, runId: string, tip: string): Promise<string | null> {
  const branch = integrationBranch(runId);
  const ref = branchRef(branch);
  const link = await repoGit(ctx, ['symbolic-ref', '--quiet', ref]);
  if (link.code === 0) return `${branch} was turned into a link to ${link.stdout.trim()}.`;
  const at = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (at.code !== 0) return `${branch} does not exist.`;
  if (at.stdout.trim() !== tip) return `${branch} is at ${short(at.stdout.trim())}, not at ${short(tip)} as recorded.`;
  return null;
}

/**
 * Checks that `orchestra/<runId>/integration` points at `tip` and holds exactly the recorded merges on top of
 * `baseSha`, and returns what each merge changed.
 */
export async function checkIntegrationHistory(
  ctx: RepoContext,
  runId: string,
  baseSha: string,
  tip: string,
  merges: readonly RecordedMerge[],
): Promise<HistoryCheck> {
  const branch = integrationBranch(runId);
  const refProblem = await integrationRefProblem(ctx, runId, tip);
  if (refProblem !== null) return { ok: false, message: refProblem };

  const recorded = merges.filter((m) => m.mergeCommit !== null);
  const found: Array<{ taskId: string; parentTree: string; tree: string }> = [];
  let current = tip;
  for (let i = recorded.length - 1; i >= 0; i--) {
    const merge = recorded[i] as RecordedMerge;
    if (current !== merge.mergeCommit) {
      return {
        ok: false,
        message: `${branch} has ${short(current)} where the merge of task "${merge.taskId}" (${short(merge.mergeCommit ?? '')}) was recorded.`,
      };
    }
    const read = await readCommit(ctx, current);
    if (!read.ok) return { ok: false, message: read.problem.message };
    const previous = i === 0 ? baseSha : ((recorded[i - 1] as RecordedMerge).mergeCommit as string);
    if (read.parents.length !== 2 || read.parents[0] !== previous || read.parents[1] !== merge.commit) {
      return {
        ok: false,
        message: `The merge of task "${merge.taskId}" (${short(current)}) does not have the recorded parents.`,
      };
    }
    const parent = await readCommit(ctx, previous);
    if (!parent.ok) return { ok: false, message: parent.problem.message };
    found.unshift({ taskId: merge.taskId, parentTree: parent.tree, tree: read.tree });
    current = previous;
  }
  if (current !== baseSha) {
    return { ok: false, message: `${branch} has ${short(current)} where the run's base commit ${short(baseSha)} was expected.` };
  }

  const changesById = new Map<string, readonly TreeChange[]>();
  const verified = new Set<string>();
  for (const merge of found) {
    for (const tree of [merge.parentTree, merge.tree]) {
      const checked = await verifyTree(ctx, tree, verified);
      if (!checked.ok) return { ok: false, message: checked.problem.message };
    }
    const diff = await diffTrees(ctx, merge.parentTree, merge.tree);
    if (!diff.ok) return { ok: false, message: diff.message };
    changesById.set(merge.taskId, diff.changes);
  }
  return { ok: true, tasks: merges.map((m) => ({ taskId: m.taskId, changes: changesById.get(m.taskId) ?? [] })) };
}

/** How many commits `tip` has that `base` doesn't. */
export async function commitsSince(ctx: RepoContext, base: string, tip: string): Promise<number | string> {
  const counted = await repoGit(ctx, ['rev-list', '--count', `${base}..${tip}`]);
  if (counted.code !== 0) return `git rev-list failed: ${describeGitFailure(counted)}`;
  return Number.parseInt(counted.stdout.trim(), 10);
}
