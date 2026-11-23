/**
 * Finalize checks (step 8): everything that must hold before the run's work may go into the user's branch.
 * The merge itself, with the user's identity and hooks, comes with their approval (step 13); this only
 * checks and reports, and leaves nothing behind.
 *
 * 1. The integration branch holds exactly the merges the conductor recorded (history.ts).
 * 2. The user's branch: still containing the run's base commit, and the merge of its current tip with the
 *    run's work is clean and is exactly its tip plus the run's changes (target.ts).
 * 3. Nothing of the user's would be overwritten: no unsaved work where finalizing writes, nothing half-done
 *    in a checkout of the branch (checkouts.ts).
 * 4. Every merged task's acceptance commands pass on exactly what the branch would hold: Orchestra builds
 *    that commit (its tree from the preview, the branch's tip and the integration tip as parents) on a
 *    temporary branch `orchestra/<runId>/finalize`, tests it in a check worktree (combined.ts), then removes
 *    both. The real finalize must produce the same tree (`target.tree`). Afterwards the integration branch must
 *    still be where it was checked: the commands run the workers' code, and Orchestra's own branches are left
 *    out of the tamper checks (the user's branches are not: the gate reports any change to them).
 *
 * The report lists the tasks, their commits and files, the files the branch would get, the test results and
 * every problem. `ready` is true only when there are no problems.
 */

import { NOT_EXCLUSIVE, type GateOptions } from '../accept/gate.js';
import { ORCHESTRA_GIT_IDENTITY } from '../config/defaults.js';
import { repoGit, type RepoContext } from '../git/context.js';
import { identityArgs } from '../git/identity.js';
import { describeGitFailure } from '../git/run.js';
import type { Task } from '../plan/schema.js';
import { branchRef, isValidRunId, RUN_BRANCH_NAMES, runBranch } from '../run/names.js';
import type { TreeChange } from '../scope/diff.js';
import { removeLeftoverCheckWorktree } from '../worktree/manager.js';
import { checkTargetCheckouts, type CheckoutProblemCode } from './checkouts.js';
import { checkCombined, type CombinedResult, type TaskAcceptance } from './combined.js';
import { checkIntegrationHistory, integrationRefProblem } from './history.js';
import { previewFinalize, type TargetPreview, type TargetProblemCode } from './target.js';

export type FinalizeTask = Pick<Task, 'id' | 'title' | 'engine' | 'model' | 'acceptance'>;

export interface MergedTask {
  readonly task: FinalizeTask;
  /** The task's accepted commit. */
  readonly commit: string;
  /** The merge commit `mergeTask` made, or null when the task changed nothing and nothing was merged. */
  readonly mergeCommit: string | null;
}

export interface FinalizeInput {
  readonly runId: string;
  /** The user's branch: the plan's target branch. */
  readonly targetBranch: string;
  /** The plan's base commit. */
  readonly baseSha: string;
  /** Where the integration branch points: the last merge. */
  readonly integrationTip: string;
  /** Every accepted task, in the order merged. */
  readonly merged: readonly MergedTask[];
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly engine: string;
  readonly model: string;
  readonly commit: string;
  readonly mergeCommit: string | null;
  /** What the task's merge changed. */
  readonly changes: readonly TreeChange[];
  /** Its acceptance commands on the combined result, or null when they didn't run. */
  readonly acceptance: TaskAcceptance | null;
}

/** Codes only the finalize checks themselves report; the rest come from target.ts and checkouts.ts. */
export const OWN_FINALIZE_PROBLEM_CODES = ['bad-input', 'leftover', 'history', 'nothing-to-finalize', 'checks-not-run', 'acceptance'] as const;
export type FinalizeProblemCode = (typeof OWN_FINALIZE_PROBLEM_CODES)[number] | TargetProblemCode | CheckoutProblemCode;

export interface FinalizeProblem {
  readonly code: FinalizeProblemCode;
  readonly message: string;
  readonly paths: readonly string[];
}

export interface FinalizeReport {
  /** Every check passed: the user may approve. */
  readonly ready: boolean;
  readonly runId: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  readonly integrationTip: string;
  /** The user's branch and what finalizing would do to it, or null when it couldn't be previewed. */
  readonly target: TargetPreview | null;
  readonly tasks: readonly TaskSummary[];
  /** Folders where the user's branch is checked out: finalizing will update their files. */
  readonly checkouts: readonly string[];
  /** Acceptance on what the branch would hold, or null when it didn't run. */
  readonly acceptance: CombinedResult | null;
  readonly problems: readonly FinalizeProblem[];
  /** Worth knowing, but not blocking. */
  readonly notes: readonly string[];
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function inputProblems(input: FinalizeInput): string[] {
  const problems: string[] = [];
  if (!isValidRunId(input.runId)) problems.push(`"${input.runId}" is not a valid run id.`);
  for (const [what, id] of [
    ['base commit', input.baseSha],
    ['integration tip', input.integrationTip],
    ...input.merged.flatMap((m) => [
      [`commit of task "${m.task.id}"`, m.commit],
      ...(m.mergeCommit === null ? [] : [[`merge commit of task "${m.task.id}"`, m.mergeCommit]]),
    ]),
  ] as Array<[string, string]>) {
    if (!FULL_SHA.test(id)) problems.push(`The ${what} "${id}" is not a full commit id.`);
  }
  const ids = input.merged.map((m) => m.task.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0) problems.push(`Tasks listed more than once: ${[...new Set(repeated)].join(', ')}.`);
  return problems;
}

/** Removes the temporary finalize branch and its check worktree, if an earlier check left them. */
export async function clearFinalizeCheck(ctx: RepoContext, runId: string): Promise<string[]> {
  const problems: string[] = [];
  const removed = await removeLeftoverCheckWorktree(ctx, runId, RUN_BRANCH_NAMES.finalize);
  if (removed !== null && !removed.ok) problems.push(...removed.problems);
  const ref = branchRef(runBranch(runId, RUN_BRANCH_NAMES.finalize));
  const link = await repoGit(ctx, ['symbolic-ref', '--quiet', ref]);
  const at = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (link.code === 0 || at.code === 0) {
    // --no-deref: a link put in its place is removed itself, never what it points to.
    const args = link.code === 0 ? ['update-ref', '--no-deref', '-d', ref] : ['update-ref', '--no-deref', '-d', ref, at.stdout.trim()];
    const deleted = await repoGit(ctx, args);
    if (deleted.code !== 0) problems.push(`Could not delete ${runBranch(runId, RUN_BRANCH_NAMES.finalize)}: ${describeGitFailure(deleted)}`);
  }
  return problems;
}

/** The commit finalizing would make, as Orchestra (the real one is made with the user's identity). */
export function finalizeCheckMessage(runId: string): string {
  return `Finalize check for Orchestra run ${runId}\n\nOrchestra-Run: ${runId}\n`;
}

async function buildCandidate(
  ctx: RepoContext,
  runId: string,
  preview: TargetPreview,
  integrationTip: string,
): Promise<{ ok: true; commit: string } | { ok: false; message: string }> {
  const made = await repoGit(
    ctx,
    [...identityArgs(ORCHESTRA_GIT_IDENTITY), 'commit-tree', '--no-gpg-sign', preview.tree, '-p', preview.tip, '-p', integrationTip],
    { input: finalizeCheckMessage(runId) },
  );
  if (made.code !== 0) return { ok: false, message: `git commit-tree failed: ${describeGitFailure(made)}` };
  const commit = made.stdout.trim();
  const ref = branchRef(runBranch(runId, RUN_BRANCH_NAMES.finalize));
  // An all-zero old value means "only if it doesn't exist yet".
  const created = await repoGit(ctx, ['update-ref', '--no-deref', '-m', 'orchestra: finalize check', ref, commit, '0'.repeat(commit.length)]);
  if (created.code !== 0) return { ok: false, message: `Could not create ${runBranch(runId, RUN_BRANCH_NAMES.finalize)}: ${describeGitFailure(created)}` };
  return { ok: true, commit };
}

function acceptanceProblem(result: CombinedResult): FinalizeProblem | null {
  if (result.problem !== null) return { code: 'checks-not-run', message: result.problem, paths: [] };
  if (result.passed) return null;
  const failing = result.tasks.filter((t) => !t.passed).map((t) => t.id);
  const which = failing.length > 0 ? ` Tasks whose commands failed: ${failing.join(', ')}.` : '';
  return {
    code: 'acceptance',
    message: `The acceptance checks failed on what your branch would hold (${result.gate?.summary ?? 'no result'}).${which}`,
    paths: result.gate?.trackedChanged ?? [],
  };
}

/** Runs every finalize check and reports. Leaves the user's branch, checkouts and files untouched. */
export async function finalizeChecks(ctx: RepoContext, input: FinalizeInput, opts: GateOptions = {}): Promise<FinalizeReport> {
  const problems: FinalizeProblem[] = [];
  const notes: string[] = [];
  let target: TargetPreview | null = null;
  let checkouts: readonly string[] = [];
  let acceptance: CombinedResult | null = null;
  let changesById = new Map<string, readonly TreeChange[]>();

  const report = (): FinalizeReport => ({
    ready: problems.length === 0,
    runId: input.runId,
    targetBranch: input.targetBranch,
    baseSha: input.baseSha,
    integrationTip: input.integrationTip,
    target,
    tasks: input.merged.map((m) => ({
      id: m.task.id,
      title: m.task.title,
      engine: m.task.engine,
      model: m.task.model,
      commit: m.commit,
      mergeCommit: m.mergeCommit,
      changes: changesById.get(m.task.id) ?? [],
      acceptance: acceptance?.tasks.find((t) => t.id === m.task.id) ?? null,
    })),
    checkouts,
    acceptance,
    problems,
    notes,
  });

  const bad = inputProblems(input);
  if (bad.length > 0) {
    problems.push({ code: 'bad-input', message: bad.join(' '), paths: [] });
    return report();
  }

  const exclusive = opts.exclusive ?? NOT_EXCLUSIVE;
  const leftover = await exclusive(() => clearFinalizeCheck(ctx, input.runId));
  if (leftover.length > 0) {
    problems.push({ code: 'leftover', message: `An earlier finalize check left things behind: ${leftover.join(' ')}`, paths: [] });
    return report();
  }

  // 1. The integration branch is what was recorded.
  const history = await checkIntegrationHistory(
    ctx,
    input.runId,
    input.baseSha,
    input.integrationTip,
    input.merged.map((m) => ({ taskId: m.task.id, commit: m.commit, mergeCommit: m.mergeCommit })),
  );
  if (!history.ok) {
    problems.push({ code: 'history', message: history.message, paths: [] });
    return report();
  }
  changesById = new Map(history.tasks.map((t) => [t.taskId, t.changes]));

  // 2. The user's branch.
  const previewed = await previewFinalize(ctx, input);
  if (!previewed.ok) {
    problems.push(previewed.problem);
    return report();
  }
  target = previewed.preview;
  if (target.changes.length === 0) {
    problems.push({
      code: 'nothing-to-finalize',
      message: `Finalizing would not change ${input.targetBranch}: the run's work is already there, or the run changed nothing.`,
      paths: [],
    });
    return report();
  }
  if (target.overlap.length > 0) {
    notes.push(
      `Changed both on ${input.targetBranch} since the run started and by the run (git merged them without a conflict): ` +
        `${target.overlap.join(', ')}.`,
    );
  }

  // 3. The user's checkouts.
  const found = await checkTargetCheckouts(
    ctx,
    input.targetBranch,
    target.changes.map((c) => c.path),
  );
  checkouts = found.checkouts;
  problems.push(...found.problems.map((p) => ({ code: p.code, message: p.message, paths: p.paths })));

  // 4. Acceptance on exactly what the branch would hold. The temporary branch goes, whatever happens.
  try {
    const candidate = await buildCandidate(ctx, input.runId, target, input.integrationTip);
    if (!candidate.ok) {
      problems.push({ code: 'checks-not-run', message: candidate.message, paths: [] });
    } else {
      acceptance = await checkCombined(
        ctx,
        { runId: input.runId, name: RUN_BRANCH_NAMES.finalize, tip: candidate.commit, tasks: input.merged.map((m) => m.task) },
        opts,
      );
      const failed = acceptanceProblem(acceptance);
      if (failed !== null) problems.push(failed);
      notes.push(...acceptance.cleanup.map((c) => `Cleanup: ${c}`));
    }
  } finally {
    const cleared = await exclusive(() => clearFinalizeCheck(ctx, input.runId));
    notes.push(...cleared.map((c) => `Cleanup: ${c}`));
  }
  const moved = await integrationRefProblem(ctx, input.runId, input.integrationTip);
  if (moved !== null) problems.push({ code: 'history', message: `After the checks: ${moved}`, paths: [] });
  return report();
}
