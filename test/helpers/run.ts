/**
 * Helpers that drive a run through the real steps (task worktree, scope check, the conductor's commit,
 * merging), so later steps can be tested on what earlier ones really produce.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../../src/git/run.js';
import { mergeTask, startIntegration, type MergeTask } from '../../src/merge/integration.js';
import type { Task } from '../../src/plan/schema.js';
import { checkScope, commitTask } from '../../src/scope/check.js';
import { createTaskWorktree } from '../../src/worktree/manager.js';
import type { Fixture } from './fixture.js';

export const NODE = process.execPath;

/** A command that runs a short Node.js script. */
export function node(code: string): string[] {
  return [NODE, '-e', code];
}

export type RunTask = MergeTask & Pick<Task, 'engine' | 'model' | 'acceptance'>;

export function runTask(id: string, owns: string[], commands: string[][] = []): RunTask {
  return {
    id,
    title: `Task ${id}`,
    kind: 'work',
    mode: 'write',
    owns,
    engine: 'claude',
    model: 'test-model',
    acceptance: { commands, criteria: [] },
  };
}

/** Runs a task the real way (worktree, scope check, conductor commit) and returns its commit. */
export async function taskCommit(
  fx: Fixture,
  runId: string,
  task: MergeTask,
  start: string,
  files: Record<string, string | null>,
): Promise<string> {
  const created = await createTaskWorktree(fx.ctx, { runId, taskId: task.id, startSha: start });
  if (!created.ok) throw new Error(created.error.message);
  const wt = created.worktree;
  for (const [path, content] of Object.entries(files)) {
    const full = join(wt.path, path);
    if (content === null) rmSync(full);
    else {
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
  }
  const scope = await checkScope(fx.ctx, wt, task, { fromCommit: start });
  if (!scope.ok || !scope.report.clean) throw new Error(JSON.stringify(scope));
  const made = await commitTask(fx.ctx, wt, task, scope.report, { message: `${task.title}\n` });
  if (!made.ok) throw new Error(made.error.message);
  return made.tip;
}

export interface MergedRunTask {
  readonly task: RunTask;
  readonly commit: string;
  readonly mergeCommit: string | null;
}

export interface MergedRun {
  readonly runId: string;
  readonly tip: string;
  readonly merged: MergedRunTask[];
}

/**
 * Starts the run's integration branch at the fixture's base commit, then runs and merges each task in order
 * (every task starts from the base commit).
 */
export async function mergedRun(
  fx: Fixture,
  runId: string,
  work: ReadonlyArray<{ task: RunTask; files: Record<string, string | null> }>,
): Promise<MergedRun> {
  const started = await startIntegration(fx.ctx, runId, fx.base);
  if (!started.ok) throw new Error(started.error.message);
  let tip = started.tip;
  const merged: MergedRunTask[] = [];
  for (const { task, files } of work) {
    const commit = await taskCommit(fx, runId, task, fx.base, files);
    const result = await mergeTask(fx.ctx, { runId, task, start: fx.base, commit, expectedTip: tip });
    if (!result.ok) throw new Error(result.error.message);
    merged.push({ task, commit, mergeCommit: result.merged ? result.tip : null });
    tip = result.tip;
  }
  return { runId, tip, merged };
}

/** A commit built with git plumbing, so paths are stored exactly as given whatever the file system. */
export async function plumbingCommit(fx: Fixture, parent: string, files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-index-'));
  try {
    const opts = { cwd: fx.repo.dir, indexFile: join(dir, 'index') };
    const git = async (args: string[], input?: string): Promise<string> => {
      const result = await runGit(args, input === undefined ? opts : { ...opts, input });
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await git(['read-tree', parent]);
    for (const [path, content] of Object.entries(files)) {
      const blob = await git(['hash-object', '-w', '--stdin'], content);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const tree = await git(['write-tree']);
    return await git(['-c', 'user.name=User', '-c', 'user.email=u@example.invalid', 'commit-tree', tree, '-p', parent, '-m', 'user']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Commits on the user's branch in the main checkout, as the user would. */
export function userCommit(fx: Fixture, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) fx.repo.write(path, content);
  return fx.repo.commitAll('user work');
}
