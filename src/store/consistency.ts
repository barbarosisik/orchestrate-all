/**
 * Whether a stored run makes sense (step 9), beyond its shape. The store checks this before every write and
 * after every read: a restarted conductor (step 12) rebuilds the finalize input and each task's review state
 * from these files, so they must hold exactly what the run's own steps could have produced.
 *
 * - plan.json: the plan's hash and the setup hash (the whole record: repository, hooks, case rule, review
 *   settings) match, its task ids are valid and distinct, and it belongs to this run.
 * - state.json, against the plan:
 *   - same run, plan hash, setup hash, target branch and base commit; one task state per plan task, in order;
 *   - each review state uses the run's review settings and the task's own criteria, and replays through the
 *     real review transitions (review/state.ts) to exactly what is stored: a review can't be marked accepted
 *     without a passing gate and an accepting review that meets the run's threshold;
 *   - a task's status fits its record: a waiting task has no start commit, commit or review; a working task
 *     has a start commit; a task in review, accepted, merged or rejected has the matching review state;
 *   - a task without dependencies starts from the base commit; a task with dependencies starts only once they
 *     are merged;
 *   - merged tasks are exactly those in the merge order, each accepted, with a start commit and a commit,
 *     merged after the tasks it depends on; only merged tasks have a merge commit, and no two share one;
 *   - the integration tip is the last merge commit, or the base commit when nothing changed yet;
 *   - a finalized run has merged tasks, an integration tip and its final commit; only a finalized run has one.
 *
 * Not covered: a worker that rewrites both files consistently (the hashes are not secrets). Until workers are
 * sandboxed (step 10), the run folder is only as safe as the user's account; every later git step checks the
 * repository again for itself.
 */

import { canonicalJson, sha256Of } from '../plan/hash.js';
import { newTaskReview, recordGate, recordReview, startRevision, type TaskReview, type Transition } from '../review/state.js';
import { isValidTaskId } from '../run/names.js';
import type { PlanRecord, RunState, TaskState } from './schema.js';
import { setupHashOf } from './state.js';

type PlanTask = PlanRecord['plan']['tasks'][number];

const MAX_PROBLEMS = 10;

export function planRecordProblems(record: PlanRecord, runId: string): string[] {
  const problems: string[] = [];
  if (record.runId !== runId) problems.push(`It belongs to run "${record.runId}", not "${runId}".`);
  if (sha256Of(record.plan) !== record.planHash) problems.push('The plan does not match its hash: it was changed after approval.');
  if (setupHashOf(record) !== record.setupHash) {
    problems.push('The run setup (repository, hooks, letter case or review settings) does not match its hash: it was changed.');
  }
  const ids = record.plan.tasks.map((t) => t.id);
  const invalid = ids.filter((id) => !isValidTaskId(id));
  if (invalid.length > 0) problems.push(`Not valid task ids: ${invalid.join(', ')}.`);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0) problems.push(`Task ids used more than once: ${[...new Set(repeated)].join(', ')}.`);
  return problems;
}

/** Why a stored review state is not what the review transitions produce, or null. */
export function reviewProblem(stored: TaskReview): string | null {
  let state: TaskReview;
  try {
    state = newTaskReview({ id: stored.taskId, acceptance: { criteria: stored.criteria } }, {
      maxRevisionRounds: stored.maxRevisionRounds,
      threshold: stored.threshold,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const apply = (step: Transition, what: string): string | null => {
    if (!step.ok) return `${what} was refused: ${step.error.message}`;
    state = step.state;
    return null;
  };
  for (const [index, attempt] of stored.attempts.entries()) {
    const failed =
      (index > 0 ? apply(startRevision(state), `Revision ${index}`) : null) ??
      (attempt.gate !== null ? apply(recordGate(state, attempt.gate), `The gate of round ${index}`) : null) ??
      (attempt.review !== null ? apply(recordReview(state, attempt.review), `The review of round ${index}`) : null);
    if (failed !== null) return failed;
  }
  return canonicalJson(state) === canonicalJson(stored) ? null : 'It is not what its gates and reviews lead to.';
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** The review states a task's status allows (null: no review yet). */
const REVIEW_FOR_STATUS: Partial<Record<TaskState['status'], ReadonlyArray<string | null>>> = {
  waiting: [null],
  working: [null, 'working'],
  reviewing: ['awaiting-review', 'gate-failed', 'needs-revision'],
  accepted: ['accepted'],
  merged: ['accepted'],
  rejected: ['rejected'],
};

function taskProblems(record: PlanRecord, task: TaskState, plan: PlanTask, baseSha: string, merged: boolean): string[] {
  const problems: string[] = [];
  const name = `Task "${task.id}"`;
  if (plan.dependsOn.length === 0 && task.startSha !== null && task.startSha !== baseSha) {
    problems.push(`${name} has no dependencies but did not start from the base commit.`);
  }
  if (task.review !== null) {
    if (task.review.taskId !== task.id) problems.push(`${name} holds the review state of "${task.review.taskId}".`);
    if (!sameList(task.review.criteria, plan.acceptance.criteria)) {
      problems.push(`${name}'s review grades other criteria than the plan's.`);
    }
    if (task.review.maxRevisionRounds !== record.review.maxRevisionRounds || canonicalJson(task.review.threshold) !== canonicalJson(record.review.threshold)) {
      problems.push(`${name}'s review state uses other review settings than the run's.`);
    }
    const replay = reviewProblem(task.review);
    if (replay !== null) problems.push(`${name}'s review state does not follow the review rules: ${replay}`);
  }
  const allowed = REVIEW_FOR_STATUS[task.status];
  if (allowed !== undefined && !allowed.includes(task.review?.status ?? null)) {
    problems.push(`${name} is ${task.status}, but its review state is ${task.review?.status ?? 'missing'}.`);
  }
  if (task.status === 'waiting' && (task.startSha !== null || task.commit !== null)) problems.push(`${name} is waiting but has already started.`);
  if (['working', 'merged'].includes(task.status) && task.startSha === null) problems.push(`${name} is ${task.status} without a start commit.`);
  const needsAcceptance = task.status === 'accepted' || task.status === 'merged';
  if (needsAcceptance && (task.review?.status !== 'accepted' || task.commit === null)) {
    problems.push(`${name} is ${task.status} without an accepted review of a commit.`);
  }
  if ((task.status === 'merged') !== merged) {
    problems.push(merged ? `${name} is in the merge order but is ${task.status}.` : `${name} is merged but not in the merge order.`);
  }
  if (task.mergeCommit !== null && task.status !== 'merged') problems.push(`${name} has a merge commit but is ${task.status}.`);
  return problems;
}

/** Everything wrong with `state` as the state of the run planned in `record`; empty when it is sound. */
export function stateProblems(record: PlanRecord, state: RunState): string[] {
  const problems: string[] = [];
  const { plan } = record;
  if (state.runId !== record.runId) problems.push(`It belongs to run "${state.runId}", not "${record.runId}".`);
  if (state.planHash !== record.planHash) problems.push('It was written for a different plan.');
  if (state.targetBranch !== plan.targetBranch) problems.push(`Its target branch is "${state.targetBranch}", not "${plan.targetBranch}".`);
  if (state.baseSha !== plan.baseSha) problems.push('Its base commit is not the plan’s.');
  const planIds = plan.tasks.map((t) => t.id);
  if (!sameList(state.tasks.map((t) => t.id), planIds)) {
    problems.push(`Its tasks (${state.tasks.map((t) => t.id).join(', ')}) are not the plan's (${planIds.join(', ')}).`);
    return problems;
  }

  const order = state.mergeOrder;
  const position = new Map(order.map((id, i) => [id, i]));
  if (position.size !== order.length) problems.push('A task appears more than once in the merge order.');
  const unknown = order.filter((id) => !planIds.includes(id));
  if (unknown.length > 0) problems.push(`The merge order names tasks not in the plan: ${unknown.join(', ')}.`);

  if (state.setupHash !== record.setupHash) problems.push('It was written for a different run setup.');
  plan.tasks.forEach((planTask, i) => {
    const task = state.tasks[i] as TaskState;
    problems.push(...taskProblems(record, task, planTask, state.baseSha, position.has(task.id)));
    if (task.startSha !== null) {
      const unmerged = planTask.dependsOn.filter((dep) => !position.has(dep));
      if (unmerged.length > 0) problems.push(`Task "${task.id}" started before ${unmerged.join(', ')} (which it depends on) was merged.`);
    }
    const at = position.get(task.id);
    if (at === undefined) return;
    for (const dep of planTask.dependsOn) {
      const depAt = position.get(dep);
      if (depAt === undefined || depAt > at) problems.push(`Task "${task.id}" was merged before "${dep}", which it depends on.`);
    }
  });

  const mergeCommits = state.tasks.flatMap((t) => (t.mergeCommit === null ? [] : [t.mergeCommit]));
  if (new Set(mergeCommits).size !== mergeCommits.length) problems.push('Two tasks have the same merge commit.');
  if (order.length > 0 && state.integrationTip === null) problems.push('Tasks were merged, but there is no integration tip.');
  if (state.integrationTip !== null) {
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    const lastMerge = [...order].reverse().map((id) => byId.get(id)?.mergeCommit ?? null).find((c) => c !== null);
    const expected = lastMerge ?? state.baseSha;
    if (state.integrationTip !== expected) {
      problems.push(`The integration tip ${state.integrationTip.slice(0, 12)} is not the last merge (${expected.slice(0, 12)}).`);
    }
  }
  if (state.status === 'finalized' && (order.length === 0 || state.integrationTip === null)) {
    problems.push('The run is finalized, but nothing was merged.');
  }
  if ((state.status === 'finalized') !== (state.finalCommit !== null)) {
    problems.push(state.status === 'finalized' ? 'The run is finalized without a final commit.' : `The run is ${state.status} but has a final commit.`);
  }
  return problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `... and ${problems.length - MAX_PROBLEMS} more.`] : problems;
}
