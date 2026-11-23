/**
 * What git shows about a run, for the run manager (step 12): where a run's branches point, and whether a commit or
 * merge that git has but the run's state doesn't record is exactly what the conductor would have made.
 *
 * A crash between a git step and the state write that records it leaves git one step ahead. Before carrying on, the
 * run manager records what git shows, but only after checking it as the step itself would have:
 * - a task commit: its one parent is the commit the round started from, every tree it relies on is re-hashed, and
 *   its changes pass the task's scope rules (the same checks commitTask's re-check makes);
 * - a merge: its parents are the integration tip and the accepted task's commit, the checks mergeTask makes before
 *   merging pass again (ancestry, the task's changes in scope, nothing the integration branch changed since the task
 *   started), and its tree is exactly what merging them again gives (merging is deterministic).
 */

import type { Claims } from '../store/schema.js';
import type { WorkerResult } from '../brief/result.js';
import { repoGit, type RepoContext } from '../git/context.js';
import { readCommit, verifyTree } from '../git/objects.js';
import { mergeTrees, overlapping } from '../merge/integration.js';
import type { TreeChange } from '../scope/diff.js';
import { evaluateScope, type ScopeRules, type ScopeTask } from '../scope/rules.js';
import { diffTrees, treePaths } from '../scope/trees.js';

export type RefState = { readonly state: 'missing' } | { readonly state: 'link'; readonly target: string } | { readonly state: 'at'; readonly sha: string };

/** Where `ref` points; a ref turned into a link to another ref is reported as such, never followed. */
export async function refState(ctx: RepoContext, ref: string): Promise<RefState> {
  const link = await repoGit(ctx, ['symbolic-ref', '--quiet', ref]);
  if (link.code === 0) return { state: 'link', target: link.stdout.trim() };
  const at = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  return at.code === 0 ? { state: 'at', sha: at.stdout.trim() } : { state: 'missing' };
}

type Checked<T = object> = ({ readonly ok: true } & T) | { readonly ok: false; readonly message: string };

/** Whether `candidate` is a task commit the conductor could have made on top of `from` for `task`. */
export async function verifyTaskCommit(
  ctx: RepoContext,
  task: ScopeTask,
  from: string,
  candidate: string,
  rules: ScopeRules,
): Promise<Checked<{ readonly changes: readonly TreeChange[] }>> {
  const made = await readCommit(ctx, candidate);
  if (!made.ok) return { ok: false, message: made.problem.message };
  if (made.parents.length !== 1 || made.parents[0] !== from) return { ok: false, message: `${candidate.slice(0, 12)} is not a commit on top of ${from.slice(0, 12)}.` };
  const base = await readCommit(ctx, from);
  if (!base.ok) return { ok: false, message: base.problem.message };
  const verified = new Set<string>();
  for (const tree of [base.tree, made.tree]) {
    const checked = await verifyTree(ctx, tree, verified);
    if (!checked.ok) return { ok: false, message: checked.problem.message };
  }
  const diff = await diffTrees(ctx, base.tree, made.tree);
  if (!diff.ok) return { ok: false, message: diff.message };
  const listed = diff.changes.some((c) => c.status === 'A') ? await treePaths(ctx, made.tree) : { ok: true as const, paths: [] };
  if (!listed.ok) return { ok: false, message: listed.message };
  const violations = evaluateScope(task, diff.changes, rules, listed.paths);
  if (violations.length > 0) return { ok: false, message: `Its changes fail the scope check: ${violations.map((v) => v.message).join(' ')}` };
  return { ok: true, changes: diff.changes };
}

export interface MergeToVerify {
  /** The integration tip the merge must start from. */
  readonly tip: string;
  readonly candidate: string;
  /** The task's start commit and accepted commit. */
  readonly start: string;
  readonly commit: string;
  readonly task: ScopeTask;
  readonly rules: ScopeRules;
}

async function isAncestor(ctx: RepoContext, ancestor: string, descendant: string): Promise<boolean> {
  return (await repoGit(ctx, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/** Whether `candidate` is exactly the merge mergeTask would have made of the task's commit into the integration tip. */
export async function verifyMergeCommit(ctx: RepoContext, input: MergeToVerify): Promise<Checked> {
  const { tip, candidate, start, commit } = input;
  const made = await readCommit(ctx, candidate);
  if (!made.ok) return { ok: false, message: made.problem.message };
  if (made.parents.length !== 2 || made.parents[0] !== tip || made.parents[1] !== commit) {
    return { ok: false, message: `${candidate.slice(0, 12)} is not a merge of ${commit.slice(0, 12)} into ${tip.slice(0, 12)}.` };
  }
  if (!(await isAncestor(ctx, start, commit)) || !(await isAncestor(ctx, start, tip))) {
    return { ok: false, message: 'The task did not start from this run\'s integration history.' };
  }
  const [startCommit, taskCommit, tipCommit] = await Promise.all([readCommit(ctx, start), readCommit(ctx, commit), readCommit(ctx, tip)]);
  if (!startCommit.ok || !taskCommit.ok || !tipCommit.ok) return { ok: false, message: 'A commit of the merge could not be read.' };
  const own = await diffTrees(ctx, startCommit.tree, taskCommit.tree);
  const since = await diffTrees(ctx, startCommit.tree, tipCommit.tree);
  if (!own.ok || !since.ok) return { ok: false, message: 'The merge could not be compared.' };
  const violations = evaluateScope(input.task, own.changes, input.rules);
  if (violations.length > 0) return { ok: false, message: `The task's changes fail the scope check: ${violations.map((v) => v.message).join(' ')}` };
  const clash = overlapping(own.changes.map((c) => c.path), since.changes.map((c) => c.path));
  if (clash.length > 0) return { ok: false, message: `The integration branch also changed ${clash.join(', ')} since the task started.` };
  const merged = await mergeTrees(ctx, start, tip, commit);
  if (merged.status !== 'clean') return { ok: false, message: merged.status === 'failed' ? merged.message : 'Merging again conflicts.' };
  if (merged.tree !== made.tree) return { ok: false, message: `${candidate.slice(0, 12)} does not hold what merging gives.` };
  const checked = await verifyTree(ctx, made.tree, new Set());
  return checked.ok ? { ok: true } : { ok: false, message: checked.problem.message };
}

/** Kept per list, so a result file stays well under its size limit. */
const MAX_CLAIMS = 2_000;
const MAX_CLAIM_PATH = 1_024;

function key(path: string, caseInsensitive: boolean): string {
  const nfc = path.normalize('NFC');
  return caseInsensitive ? nfc.toLowerCase() : nfc;
}

/** How a worker's own list of changed files compares with what its round really changed. */
export function claimsOf(result: WorkerResult, changed: readonly string[], caseInsensitive: boolean): Claims {
  const claimed = new Set(result.files_changed.map((f) => key(f.path.replace(/\\/g, '/'), caseInsensitive)));
  const real = new Set(changed.map((p) => key(p, caseInsensitive)));
  return {
    unclaimed: changed.filter((p) => !claimed.has(key(p, caseInsensitive))).slice(0, MAX_CLAIMS).map((p) => p.slice(0, MAX_CLAIM_PATH)),
    notChanged: result.files_changed
      .map((f) => f.path)
      .filter((p) => !real.has(key(p.replace(/\\/g, '/'), caseInsensitive)))
      .slice(0, MAX_CLAIMS)
      .map((p) => p.slice(0, MAX_CLAIM_PATH)),
  };
}
