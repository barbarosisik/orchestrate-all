/**
 * Acceptance on the combined result (step 8). Tasks that pass alone can still break together (research §6.1:
 * 97% of constructed cases), so every merged task's acceptance commands run again on the run's combined
 * result, in a check worktree of the run (`<home>/wt/<runId>/<name>`, locked, on the run's own branch):
 *
 * - "integration": the integration tip, for example after each merge, to find the merge that broke things;
 * - "finalize": what the user's branch would hold after approving (finalize/check.ts).
 *
 * The worktree is new each time, as task worktrees are, so nothing left over from an earlier check (build
 * output) can hide a problem. A command several tasks list runs once. The commands run through the step 6
 * gate: first the worktree's own integrity check, then the commands, then the integrity check again and the
 * scope check (a command that changed a tracked file fails: it would have tested something else). The
 * worktree is removed afterwards; the run's branch is left as it was.
 */

import type { GateOptions, GateResult } from '../accept/gate.js';
import { runAcceptanceGate } from '../accept/gate.js';
import type { CommandResult } from '../accept/run.js';
import type { RepoContext } from '../git/context.js';
import { checkIntegrity, takeBaseline } from '../integrity/check.js';
import type { Task } from '../plan/schema.js';
import type { RunBranchName } from '../run/names.js';
import { createCheckWorktree, removeTaskWorktree } from '../worktree/manager.js';

export type CombinedTask = Pick<Task, 'id' | 'acceptance'>;

export interface CombinedInput {
  readonly runId: string;
  /** The run branch to check out: "integration" or "finalize". */
  readonly name: RunBranchName;
  /** Where that branch must point. */
  readonly tip: string;
  /** The tasks whose commands to run, in merge order. */
  readonly tasks: readonly CombinedTask[];
}

export interface TaskAcceptance {
  readonly id: string;
  /** Every one of the task's commands passed (true when it has none). */
  readonly passed: boolean;
  /** The task's commands in its own order; a command several tasks list ran once and appears in each. */
  readonly commands: readonly CommandResult[];
}

export interface CombinedResult {
  /** The checks ran and everything passed. */
  readonly passed: boolean;
  readonly tip: string;
  readonly tasks: readonly TaskAcceptance[];
  /** The gate's full result, or null when the checks could not run. */
  readonly gate: GateResult | null;
  /** Why the checks could not run (the worktree could not be made, or failed its integrity check), or null. */
  readonly problem: string | null;
  /** Problems removing the check worktree afterwards. They don't change the result. */
  readonly cleanup: readonly string[];
}

function commandKey(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

/** Every distinct command, in the order first listed. */
export function distinctCommands(tasks: readonly CombinedTask[]): string[][] {
  const seen = new Set<string>();
  const commands: string[][] = [];
  for (const task of tasks) {
    for (const argv of task.acceptance.commands) {
      const key = commandKey(argv);
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push([...argv]);
    }
  }
  return commands;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs every task's acceptance commands on the run branch's tip, in a new check worktree. */
export async function checkCombined(ctx: RepoContext, input: CombinedInput, opts: GateOptions = {}): Promise<CombinedResult> {
  const { runId, name, tip, tasks } = input;
  const notRun = (problem: string, cleanup: readonly string[] = []): CombinedResult => ({
    passed: false,
    tip,
    tasks: [],
    gate: null,
    problem,
    cleanup,
  });

  const created = await createCheckWorktree(ctx, { runId, name, tip });
  if (!created.ok) return notRun(`The check worktree could not be made: ${created.error.message}`);
  const wt = created.worktree;

  let result: Omit<CombinedResult, 'cleanup'>;
  try {
    const before = await checkIntegrity(ctx, wt, await takeBaseline(ctx, opts.integrity), tip, opts.integrity);
    if (!before.ok) {
      result = notRun(`The new check worktree failed its integrity check: ${before.violations.map((v) => v.message).join(' ')}`);
    } else {
      const commands = distinctCommands(tasks);
      const gate = await runAcceptanceGate(
        ctx,
        wt,
        { id: wt.taskId, kind: 'work', mode: 'readonly', owns: [], acceptance: { commands, criteria: [] } },
        { baseline: before.baseline, commit: tip },
        opts,
      );
      const byKey = new Map(gate.acceptance.commands.map((c) => [commandKey(c.argv), c]));
      const perTask = tasks.map((task) => {
        const results = task.acceptance.commands.map((argv) => byKey.get(commandKey(argv)) as CommandResult);
        return { id: task.id, passed: results.every((r) => r.status === 'passed'), commands: results };
      });
      result = { passed: gate.passed, tip, tasks: perTask, gate, problem: null };
    }
  } catch (error) {
    result = notRun(`The checks stopped: ${errorText(error)}`);
  }

  const removed = await removeTaskWorktree(ctx, wt);
  return { ...result, cleanup: removed.ok ? [] : removed.problems };
}
