/**
 * What the run manager shows about a run (step 12): its state from the store, summed up per task, and where the run
 * is ("phase"), worked out from the state, never stored. The background service (12b) serves these summaries and
 * streams them as they change; they hold no worker output and no secrets.
 */

import type { ReviewStatus } from '../review/state.js';
import type { PlanRecord, RunState, RunStatus, TaskStatus } from '../store/schema.js';

export const RUN_PHASES = [
  'working',
  'waiting-for-review',
  'checking',
  'ready-to-finalize',
  'finalize-problems',
  'nothing-merged',
  'paused',
  'finalized',
  'discarded',
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly engine: string;
  readonly model: string;
  readonly dependsOn: readonly string[];
  readonly status: TaskStatus;
  readonly reason: string | null;
  /** The current review round (0 for the first attempt). */
  readonly round: number;
  readonly review: ReviewStatus | null;
  /** The last gate's pass/fail and summary, as the review sees it. */
  readonly gate: { readonly passed: boolean; readonly summary: string } | null;
  readonly startSha: string | null;
  readonly commit: string | null;
  readonly mergeCommit: string | null;
  readonly workers: number;
  /** Input and output tokens over all its worker runs, where the engine reported them. */
  readonly tokens: { readonly input: number; readonly output: number };
}

export interface FinalizeSummary {
  readonly ready: boolean;
  readonly integrationTip: string;
  /** Your branch's tip the checks ran against, or null when it couldn't be previewed. */
  readonly targetTip: string | null;
  readonly problems: readonly string[];
}

export interface RunSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly phase: RunPhase;
  readonly planHash: string;
  readonly goal: string;
  readonly repoRoot: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  readonly integrationTip: string | null;
  readonly mergeOrder: readonly string[];
  readonly tasks: readonly TaskSummary[];
  readonly finalize: FinalizeSummary | null;
  /** Why the run can't go on by itself (it is paused until they are sorted out). */
  readonly problems: readonly string[];
  /** Worth knowing, not blocking. */
  readonly notes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

const UNFINISHED: ReadonlySet<TaskStatus> = new Set(['waiting', 'working', 'reviewing', 'accepted']);

export function isUnfinished(status: TaskStatus): boolean {
  return UNFINISHED.has(status);
}

export function phaseOf(state: RunState, finalize: FinalizeSummary | null, problems: readonly string[]): RunPhase {
  if (state.status === 'finalized') return 'finalized';
  if (state.status === 'discarded') return 'discarded';
  if (problems.length > 0) return 'paused';
  const open = state.tasks.filter((t) => isUnfinished(t.status));
  if (open.length > 0) return open.every((t) => t.status === 'reviewing') ? 'waiting-for-review' : 'working';
  if (state.mergeOrder.length === 0) return 'nothing-merged';
  if (finalize === null || finalize.integrationTip !== state.integrationTip) return 'checking';
  return finalize.ready ? 'ready-to-finalize' : 'finalize-problems';
}

export function summarize(
  record: PlanRecord,
  state: RunState,
  extra: { readonly finalize: FinalizeSummary | null; readonly problems: readonly string[]; readonly notes: readonly string[] },
): RunSummary {
  const tasks = record.plan.tasks.map((task, i) => {
    const t = state.tasks[i];
    const attempt = t?.review?.attempts.at(-1) ?? null;
    const workers = t?.workers ?? [];
    return {
      id: task.id,
      title: task.title,
      engine: task.engine,
      model: task.model,
      dependsOn: task.dependsOn,
      status: t?.status ?? 'waiting',
      reason: t?.reason ?? null,
      round: attempt?.round ?? 0,
      review: t?.review?.status ?? null,
      gate: [...(t?.review?.attempts ?? [])].reverse().find((a) => a.gate !== null)?.gate ?? null,
      startSha: t?.startSha ?? null,
      commit: t?.commit ?? null,
      mergeCommit: t?.mergeCommit ?? null,
      workers: workers.length,
      tokens: {
        input: workers.reduce((sum, w) => sum + (w.tokens?.input ?? 0), 0),
        output: workers.reduce((sum, w) => sum + (w.tokens?.output ?? 0), 0),
      },
    } satisfies TaskSummary;
  });
  return {
    runId: state.runId,
    status: state.status,
    phase: phaseOf(state, extra.finalize, extra.problems),
    planHash: record.planHash,
    goal: record.plan.goal,
    repoRoot: record.repoRoot,
    targetBranch: state.targetBranch,
    baseSha: state.baseSha,
    integrationTip: state.integrationTip,
    mergeOrder: state.mergeOrder,
    tasks,
    finalize: extra.finalize,
    problems: extra.problems,
    notes: extra.notes,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}
