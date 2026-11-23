/**
 * Building and reading the run's records (step 9), as pure functions over plain data. A new run starts from
 * the approved ReadyPlan; after a crash (step 12) the same records give back everything the conductor needs
 * to carry on: the ReadyPlan, the RepoContext, each task's review state and the finalize input.
 */

import { DEFAULT_LIMITS } from '../config/defaults.js';
import type { FinalizeInput } from '../finalize/check.js';
import { repoContext, type HookPolicy, type RepoContext } from '../git/context.js';
import { sha256Of } from '../plan/hash.js';
import type { ReadyPlan } from '../repo/checks.js';
import { DEFAULT_REVIEW_THRESHOLD, type NewReviewOptions, type ReviewThreshold, type TaskReview } from '../review/state.js';
import { STORE_SCHEMA_VERSION, type PlanRecord, type ReviewSettings, type RunState, type TaskState } from './schema.js';

export interface NewRunInput {
  readonly runId: string;
  /** The approved plan, from preparePlan. */
  readonly ready: ReadyPlan;
  readonly hooks: HookPolicy;
  readonly caseInsensitivePaths: boolean;
  /** The review settings for every task; by default DEFAULT_LIMITS.maxRevisionRounds and DEFAULT_REVIEW_THRESHOLD. */
  readonly review?: { readonly maxRevisionRounds?: number; readonly threshold?: ReviewThreshold };
}

/** The hash of a plan record without its own `setupHash`: the plan, the repository, hooks, case rule, review settings. */
export function setupHashOf(record: Omit<PlanRecord, 'setupHash'> & { setupHash?: string }): string {
  const { setupHash: _ignored, ...setup } = record;
  return sha256Of(setup);
}

export function newPlanRecord(input: NewRunInput, now: Date): PlanRecord {
  const threshold = input.review?.threshold ?? DEFAULT_REVIEW_THRESHOLD;
  const setup: Omit<PlanRecord, 'setupHash'> = {
    schemaVersion: STORE_SCHEMA_VERSION,
    runId: input.runId,
    planHash: input.ready.planHash,
    plan: input.ready.plan,
    repoRoot: input.ready.repoRoot,
    gitCommonDir: input.ready.gitCommonDir,
    hooks: input.hooks,
    caseInsensitivePaths: input.caseInsensitivePaths,
    review: {
      maxRevisionRounds: input.review?.maxRevisionRounds ?? DEFAULT_LIMITS.maxRevisionRounds,
      threshold: { blockingSeverities: [...threshold.blockingSeverities], unknownBlocks: threshold.unknownBlocks },
    },
    createdAt: now.toISOString(),
  };
  return { ...setup, setupHash: setupHashOf(setup) };
}

/** The options for newTaskReview: every task of the run uses the run's own review settings. */
export function reviewSettingsOf(record: PlanRecord): NewReviewOptions & ReviewSettings {
  return record.review;
}

export function newRunState(record: PlanRecord, now: Date): RunState {
  const time = now.toISOString();
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    runId: record.runId,
    planHash: record.planHash,
    setupHash: record.setupHash,
    status: 'running',
    targetBranch: record.plan.targetBranch,
    baseSha: record.plan.baseSha,
    integrationTip: null,
    mergeOrder: [],
    finalCommit: null,
    tasks: record.plan.tasks.map((task) => ({
      id: task.id,
      status: 'waiting',
      reason: null,
      startSha: null,
      commit: null,
      review: null,
      mergeCommit: null,
      workers: [],
    })),
    createdAt: time,
    updatedAt: time,
  };
}

export type TaskChange = Partial<Omit<TaskState, 'id'>>;

/** The state with one task changed. Throws for a task the run doesn't have (a bug in the caller). */
export function withTask(state: RunState, taskId: string, change: TaskChange): RunState {
  if (!state.tasks.some((t) => t.id === taskId)) throw new Error(`Run ${state.runId} has no task "${taskId}".`);
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, ...change } : t)) };
}

export function taskState(state: RunState, taskId: string): TaskState | null {
  return state.tasks.find((t) => t.id === taskId) ?? null;
}

/** The approved plan as preparePlan returned it. */
export function readyPlanOf(record: PlanRecord): ReadyPlan {
  return { plan: record.plan, planHash: record.planHash, repoRoot: record.repoRoot, gitCommonDir: record.gitCommonDir };
}

/** The RepoContext the run used, for Orchestra's home `home`. */
export function contextOf(record: PlanRecord, home: string): RepoContext {
  return repoContext(readyPlanOf(record), { home, hooks: record.hooks, caseInsensitivePaths: record.caseInsensitivePaths });
}

/**
 * A review state as the task's state holds it. The shapes are the same (schema.ts checks both ways at compile time);
 * only the arrays' readonly marks differ, so this copies rather than casts.
 */
export function storedReview(review: TaskReview): NonNullable<TaskState['review']> {
  return {
    ...review,
    criteria: [...review.criteria],
    threshold: { ...review.threshold, blockingSeverities: [...review.threshold.blockingSeverities] },
    attempts: review.attempts.map((a) => ({
      round: a.round,
      gate: a.gate === null ? null : { passed: a.gate.passed, summary: a.gate.summary },
      review: a.review === null ? null : structuredClone(a.review),
    })),
  };
}

/** A task's review state, or null when its review hasn't started. */
export function taskReviewOf(state: RunState, taskId: string): TaskReview | null {
  return taskState(state, taskId)?.review ?? null;
}

/**
 * The input for finalizeChecks: every merged task in merge order, with its plan entry, commit and merge commit.
 * Null until the integration branch exists. Call it on a state that passed the consistency checks.
 */
export function finalizeInputOf(record: PlanRecord, state: RunState): FinalizeInput | null {
  if (state.integrationTip === null) return null;
  const merged = state.mergeOrder.map((id) => {
    const task = record.plan.tasks.find((t) => t.id === id);
    const stored = taskState(state, id);
    if (task === undefined || stored?.commit == null) throw new Error(`Merged task "${id}" is missing from the run's records.`);
    return {
      task: { id: task.id, title: task.title, engine: task.engine, model: task.model, acceptance: task.acceptance },
      commit: stored.commit,
      mergeCommit: stored.mergeCommit,
    };
  });
  return {
    runId: state.runId,
    targetBranch: state.targetBranch,
    baseSha: state.baseSha,
    integrationTip: state.integrationTip,
    merged,
  };
}
