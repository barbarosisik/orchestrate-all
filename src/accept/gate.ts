/**
 * The deterministic gate a task passes before anyone reviews it (step 6).
 *
 * Call it once the task's work is committed (`commitTask`) and `checkIntegrity` passed against that commit.
 * It runs the acceptance commands in the worktree, then checks that the commands didn't step outside it:
 *
 * 1. the integrity check again, against the baseline taken before the commands;
 * 2. only if that passed (the scope check trusts the repository's config): the scope check from the task's
 *    commit. Files the commands added (build output, reports) are listed and never committed. A tracked file
 *    they changed or deleted fails the gate: the commands would have tested something other than the commit.
 */

import type { RepoContext } from '../git/context.js';
import { checkIntegrity, type IntegrityBaseline, type IntegrityOptions, type IntegrityReport } from '../integrity/check.js';
import type { Task } from '../plan/schema.js';
import { checkScope } from '../scope/check.js';
import type { TaskWorktree } from '../worktree/manager.js';
import { runAcceptance, type AcceptanceResult, type RunOptions } from './run.js';

export type GateTask = Pick<Task, 'id' | 'kind' | 'mode' | 'owns' | 'acceptance'>;

export interface GateInput {
  /** From the integrity report that passed after the task was committed. */
  readonly baseline: IntegrityBaseline;
  /** The task's commit: where its branch points now. */
  readonly commit: string;
}

export interface GateOptions {
  readonly run?: RunOptions;
  readonly integrity?: IntegrityOptions;
}

export interface GateResult {
  readonly passed: boolean;
  readonly acceptance: AcceptanceResult;
  readonly integrity: IntegrityReport;
  /** Files the commands added. They stay in the worktree and are never committed. */
  readonly added: readonly string[];
  /** Tracked files the commands changed or deleted. */
  readonly trackedChanged: readonly string[];
  /** Why the scope check didn't run or failed, or null. */
  readonly scopeProblem: string | null;
  /** One line for the review: what passed and what didn't. */
  readonly summary: string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function summarize(result: Omit<GateResult, 'summary' | 'passed'>): string {
  const commands = result.acceptance.commands;
  const passed = commands.filter((c) => c.status === 'passed').length;
  const parts = [commands.length === 0 ? 'no acceptance commands' : `${passed}/${commands.length} commands passed`];
  parts.push(result.integrity.ok ? 'integrity ok' : `${plural(result.integrity.violations.length, 'integrity problem')}`);
  if (result.scopeProblem !== null) parts.push(`scope check: ${result.scopeProblem}`);
  if (result.trackedChanged.length > 0) parts.push(`${plural(result.trackedChanged.length, 'tracked file')} changed by the commands`);
  if (result.added.length > 0) parts.push(`${plural(result.added.length, 'file')} added by the commands (not committed)`);
  return parts.join('; ');
}

export async function runAcceptanceGate(
  ctx: RepoContext,
  wt: TaskWorktree,
  task: GateTask,
  input: GateInput,
  opts: GateOptions = {},
): Promise<GateResult> {
  const acceptance = await runAcceptance(wt.path, task.acceptance.commands, opts.run);
  const integrity = await checkIntegrity(ctx, wt, input.baseline, input.commit, opts.integrity);

  let added: string[] = [];
  let trackedChanged: string[] = [];
  let scopeProblem: string | null = null;
  if (!integrity.ok) {
    scopeProblem = 'skipped, because the integrity check failed';
  } else {
    const scope = await checkScope(ctx, wt, task, { fromCommit: input.commit });
    if (!scope.ok) {
      scopeProblem = scope.error.message;
    } else {
      added = scope.report.changes.filter((c) => c.status === 'A').map((c) => c.path);
      trackedChanged = scope.report.changes.filter((c) => c.status !== 'A').map((c) => c.path);
    }
  }

  const partial = { acceptance, integrity, added, trackedChanged, scopeProblem };
  const passed = acceptance.passed && integrity.ok && scopeProblem === null && trackedChanged.length === 0;
  return { ...partial, passed, summary: summarize(partial) };
}
