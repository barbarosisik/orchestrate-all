/**
 * Running one worker (step 10): the task's engine, from the approved plan, started on the task's worktree with
 * the brief, until it ends, its time limit passes or the run is cancelled. What happened is saved as it
 * happens, so a crash loses at most the end:
 *
 * 1. The engine and model come from the plan, never from the caller, and the worktree must be this task's own
 *    folder, `<home>/wt/<runId>/<taskId>`, with no link on the way from `<home>/wt`.
 * 2. The program is found in PATH only (programs.ts), started without a shell, with the worker environment
 *    (env.ts) and the brief on stdin. Nothing is written to disk for the engine to read at start (a settings
 *    file in a shared folder could be rewritten by another engine's worker first). The folder is checked again
 *    right before the start, and a cancel that came while the run was being prepared is honoured.
 * 3. Its raw output goes to the run folder as it comes (store.openOutput, capped), and its stdout is read as
 *    JSON events by the engine's adapter (a line too long to read is skipped and counted).
 * 4. The store records the worker run before the start (endedAt null, so a crash shows it never finished) and
 *    again at the end, with exit code, error and tokens; the log gets "started" and "finished".
 * 5. At the time limit, or when `signal` aborts, the whole process tree is stopped (os/process-tree.ts: its
 *    process group on Linux and macOS, a Job Object on Windows, without which it is not run). Processes the
 *    engine leaves running when it exits are stopped too. Once the engine has exited, a later time limit or
 *    cancel changes nothing. `mayStillBeRunning` says when something it started may still be writing.
 *
 * A run counts as "completed" only when the engine exited with 0, said it finished, and broke none of the
 * conditions it was started under (EngineReport.violations). Whatever the worker says, the conductor's own
 * checks come next (integrity, scope, agent config folders, the gate); "completed" only means the engine ended
 * normally. runWorker never throws; problems come back in the outcome.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Launch } from '../accept/resolve.js';
import { DEFAULT_LIMITS } from '../config/defaults.js';
import { homeLayout } from '../config/home.js';
import { OWN_PROCESS_GROUP, prepareTree, timerDelay } from '../os/process-tree.js';
import type { EngineName } from '../plan/schema.js';
import { canonicalPath, samePath } from '../repo/canonical.js';
import { clipText, workerEntry } from '../store/entries.js';
import type { RunStore } from '../store/run.js';
import type { WorkerRun } from '../store/schema.js';
import { taskState, withTask } from '../store/state.js';
import type { CappedOutput, OutputSummary } from '../store/stream.js';
import type { TaskWorktree } from '../worktree/manager.js';
import type { EngineAdapter, WorkerRequest } from './adapter.js';
import { workerEnv } from './env.js';
import { LineSplitter } from './lines.js';
import { engineLaunch } from './programs.js';
import { ADAPTERS } from './registry.js';
import { ReportBuilder, type EngineReport } from './report.js';

export const DEFAULT_WORKER_TIMEOUT_MS = DEFAULT_LIMITS.taskTimeoutMinutes * 60_000;
/** The longest stdout line read as an event; longer lines are only saved. */
export const MAX_EVENT_LINE_BYTES = 8 * 1024 * 1024;
/** How long to wait for output to end after the engine exits (a leftover process may hold it open). */
const CLOSE_GRACE_MS = 5_000;
/** After a stop: how long to wait for the process to go before giving up on it. */
const STOP_GRACE_MS = 15_000;
/** The error text kept in the run's state. */
const MAX_ERROR_BYTES = 2000;

export const WORKER_STATUSES = ['completed', 'failed', 'timed-out', 'cancelled', 'not-started'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface WorkerOptions {
  readonly store: RunStore;
  /** The task's worktree (step 3); its task id says which task runs. */
  readonly worktree: TaskWorktree;
  /** The review round (0 for the first run, then one more per revision). */
  readonly round: number;
  readonly brief: string;
  /** Whether Claude workers keep their shell tools (PLAN §4 default: no). */
  readonly shell?: boolean;
  /** The time limit; defaults to DEFAULT_WORKER_TIMEOUT_MS (a value that is not a positive number too). */
  readonly timeoutMs?: number;
  /** Aborting it stops the worker (the run was cancelled). */
  readonly signal?: AbortSignal;
  /** The environment to filter (env.ts); defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** More variable names to pass to the worker (the user's config). */
  readonly allowEnv?: readonly string[];
  /** Absolute paths to engines' programs, used instead of PATH (only the task's engine's is used). */
  readonly programs?: Partial<Record<EngineName, string>>;
  readonly now?: () => Date;
}

export interface WorkerOutcome {
  readonly status: WorkerStatus;
  readonly engine: EngineName | null;
  readonly model: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number;
  readonly report: EngineReport;
  /** Why the run did not complete, in plain words; null when it completed. */
  readonly error: string | null;
  /** Other things worth knowing (a process that kept the output open). */
  readonly notes: readonly string[];
  /**
   * The engine could not be stopped, or a process it started kept its output open after it exited: something it
   * started may still be writing. Don't check or commit its worktree until that is sorted out.
   */
  readonly mayStillBeRunning: boolean;
  readonly output: { readonly stdout: OutputSummary | null; readonly stderr: OutputSummary | null };
  /** Variables the user allowed that were not passed, because they would switch billing. */
  readonly refusedEnv: readonly string[];
  /** Problems saving to the run folder (the run itself may have gone well). */
  readonly storeProblems: readonly string[];
}

interface ProcessEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Why it could not be started, or null. */
  readonly spawnError: string | null;
  /** Whether a process was started at all. */
  readonly spawned: boolean;
  /** Why it was stopped as soon as it started (it could not be contained), or null. */
  readonly containError: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly note: string | null;
  readonly mayStillBeRunning: boolean;
}

function notStarted(error: string, engine: EngineName | null = null, model: string | null = null, refusedEnv: readonly string[] = []): WorkerOutcome {
  return {
    status: 'not-started',
    engine,
    model,
    exitCode: null,
    signal: null,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    report: new ReportBuilder().report(),
    error,
    notes: [],
    mayStillBeRunning: false,
    output: { stdout: null, stderr: null },
    refusedEnv,
    storeProblems: [],
  };
}

function timeText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

const NOT_SPAWNED = { exitCode: null, signal: null, spawned: false, containError: null, timedOut: false, cancelled: false, note: null, mayStillBeRunning: false };

/** Starts the program and waits for it to end, to be stopped, or to fail to start. Never throws. */
function runProcess(
  launch: Launch,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onStdout: (chunk: Buffer) => void,
  onStderr: (chunk: Buffer) => void,
): Promise<ProcessEnd> {
  return new Promise((resolve) => {
    // A cancel that came while the run was being prepared: the listener below would never hear it.
    if (signal?.aborted === true) {
      resolve({ ...NOT_SPAWNED, spawnError: null, cancelled: true });
      return;
    }
    // Its whole tree, ready before the start (a Job Object on Windows, without which it is not started).
    const prepared = prepareTree({ env });
    if (!prepared.ok) {
      resolve({ ...NOT_SPAWNED, spawnError: prepared.error });
      return;
    }
    const { tree } = prepared;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.program, [...launch.args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        // Its own process group on Linux and macOS, so the whole tree can be stopped.
        detached: OWN_PROCESS_GROUP,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      tree.end();
      resolve({ ...NOT_SPAWNED, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;
    // Taken in right away (no process id: it didn't start, and 'error' says why).
    const containError = child.pid === undefined ? null : tree.attach(child.pid);
    let exit: { code: number | null; signal: string | null } | null = null;
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    let stopDeadline: NodeJS.Timeout | undefined;

    const finish = (note: string | null, mayStillBeRunning: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(stopDeadline);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      tree.end();
      resolve({
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        spawnError,
        spawned: spawnError === null,
        containError,
        timedOut,
        cancelled,
        note,
        mayStillBeRunning,
      });
    };
    const stop = (): void => {
      tree.stop();
      stopDeadline ??= setTimeout(() => finish('It could not be stopped and may still be running.', true), STOP_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // The engine may exit without reading all of stdin (EPIPE); that is not a problem of ours.
    child.stdin.on('error', () => {});
    if (containError === null) child.stdin.end(stdin);
    else {
      // Not taken in: it never gets the brief, and it goes now (it had no time to start anything).
      child.stdin.end();
      child.kill('SIGKILL');
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', (error) => {
      if (exit === null) {
        spawnError = error.message;
        finish(null, false);
      }
    });
    child.on('exit', (code, sig) => {
      exit = { code, signal: sig };
      // It ended on its own (or was stopped): a time limit or a cancel coming later changes nothing.
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Anything it left running is stopped (its process group, or its Job Object).
      tree.end();
      grace = setTimeout(() => finish('Its output stayed open after it exited (a process it started may still be running).', true), CLOSE_GRACE_MS);
    });
    child.on('close', () => {
      if (exit !== null) finish(null, false);
    });
  });
}

/** Status and error from how the process ended and what the engine reported. */
function verdict(adapter: EngineAdapter, end: ProcessEnd, report: EngineReport, timeoutMs: number): { status: WorkerStatus; error: string | null } {
  const name = adapter.label;
  if (end.cancelled && !end.spawned) return { status: 'cancelled', error: `The run was cancelled before ${name} started.` };
  // It never got the brief, whatever happened next.
  if (end.containError !== null) return { status: 'not-started', error: `${name} was stopped as it started. ${end.containError}` };
  if (end.cancelled) return { status: 'cancelled', error: `${name} was stopped because the run was cancelled.` };
  if (end.timedOut) return { status: 'timed-out', error: `${name} was stopped after its time limit (${timeText(timeoutMs)}).` };
  if (end.spawnError !== null) return { status: 'not-started', error: `${name} could not be started: ${end.spawnError}` };
  // How it ended first (a crash explains a missing init event), then every condition it broke.
  let ending: string | null = null;
  if (report.succeeded === false) ending = report.problems[0] ?? `${name} reported that it did not finish.`;
  else if (end.exitCode !== 0) {
    ending = `${name} ${end.exitCode !== null ? `exited with code ${end.exitCode}` : `was stopped by ${end.signal ?? 'an unknown signal'}`}.`;
  } else if (report.succeeded === null) ending = `${name} ended without a final result.`;
  const parts = [...(ending === null ? [] : [ending]), ...report.violations];
  return parts.length === 0 ? { status: 'completed', error: null } : { status: 'failed', error: parts.join(' ') };
}

async function closeOutput(output: CappedOutput, problems: string[]): Promise<OutputSummary | null> {
  const closed = await output.close();
  if (closed.ok) return closed.value;
  problems.push(`The worker's output could not be saved in full: ${closed.problem.message}`);
  return null;
}

/** Runs the task's worker once. Never throws. */
export async function runWorker(opts: WorkerOptions): Promise<WorkerOutcome> {
  const { store, worktree } = opts;
  const taskId = worktree.taskId;
  const task = store.record.plan.tasks.find((t) => t.id === taskId);
  if (task === undefined) return notStarted(`Run ${store.runId} has no task "${taskId}".`);
  const { engine, model } = task;
  if (worktree.runId !== store.runId) {
    return notStarted(`The worktree ${worktree.path} belongs to run ${worktree.runId}, not ${store.runId}.`, engine, model);
  }
  if (opts.signal?.aborted === true) return notStarted('The run was cancelled before the worker started.', engine, model);
  const wrongFolder = await worktreeProblem(store, worktree);
  if (wrongFolder !== null) return notStarted(wrongFolder, engine, model);

  const adapter = ADAPTERS[engine];
  const { env, refused } = workerEnv(engine, opts.env ?? process.env, { allow: opts.allowEnv ?? [] });
  const request: WorkerRequest = { model, worktree: worktree.path, brief: opts.brief, shell: opts.shell ?? false };
  try {
    const launch = adapter.launch(request);
    const program = opts.programs?.[engine];
    const resolved = engineLaunch(engine, launch.args, { cwd: worktree.path, env, ...(program !== undefined ? { program } : {}) });
    if (!resolved.ok) return notStarted(resolved.error.message, engine, model, refused);
    return await supervise(opts, adapter, resolved.launch, launch.stdin, env, refused);
  } catch (error) {
    return notStarted(`The worker could not be prepared: ${(error as Error).message}`, engine, model, refused);
  }
}

/**
 * Why `worktree` is not a folder a worker may run in, or null. Only ever this task's own worktree folder,
 * `<home>/wt/<runId>/<taskId>` (step 3), reached without a link on the way: never, by a caller's mistake or a link
 * another worker planted, the user's checkout or another folder. Checked before the run is prepared and again just
 * before the start.
 */
async function worktreeProblem(store: RunStore, worktree: TaskWorktree): Promise<string | null> {
  const worktrees = homeLayout(store.home).worktrees;
  const own = join(worktrees, store.runId, worktree.taskId);
  for (const folder of [worktrees, join(worktrees, store.runId), own]) {
    try {
      const info = await lstat(folder);
      if (!info.isDirectory()) return `${folder} is not a real folder (a link or a file), so no worker runs there.`;
    } catch (error) {
      return `The worktree folder ${folder} can't be used: ${(error as Error).message}`;
    }
  }
  const expected = canonicalPath(own);
  const actual = canonicalPath(worktree.path);
  if (expected === null || actual === null || !samePath(actual, expected, store.record.caseInsensitivePaths)) {
    return `${worktree.path} is not the worktree folder of task "${worktree.taskId}".`;
  }
  return null;
}

async function supervise(
  opts: WorkerOptions,
  adapter: EngineAdapter,
  launch: Launch,
  stdin: string,
  env: NodeJS.ProcessEnv,
  refused: readonly string[],
): Promise<WorkerOutcome> {
  const { store, round } = opts;
  const taskId = opts.worktree.taskId;
  const { engine } = adapter;
  const model = store.record.plan.tasks.find((t) => t.id === taskId)?.model ?? '';
  const now = opts.now ?? (() => new Date());
  const timeoutMs = timerDelay(opts.timeoutMs, DEFAULT_WORKER_TIMEOUT_MS);
  const storeProblems: string[] = [];

  const out = await store.openOutput(taskId, round, 'stdout');
  if (!out.ok) return notStarted(`The worker's output file could not be opened: ${out.problem.message}`, engine, model, refused);
  const err = await store.openOutput(taskId, round, 'stderr');
  if (!err.ok) {
    await out.value.close();
    return notStarted(`The worker's error output file could not be opened: ${err.problem.message}`, engine, model, refused);
  }

  const startedAt = now().toISOString();
  const run: WorkerRun = { round, engine, model, startedAt, endedAt: null, exitCode: null, error: null, tokens: null };
  const added = await store.update((state) => withTask(state, taskId, { workers: [...(taskState(state, taskId)?.workers ?? []), run] }));
  if (!added.ok) {
    await Promise.all([out.value.close(), err.value.close()]);
    return notStarted(`The worker run could not be recorded, so it was not started: ${added.problem.message}`, engine, model, refused);
  }
  const startLog = await store.appendLog(workerEntry(taskId, round, 'started', { engine, model, exitCode: null, error: null }));
  if (!startLog.ok) storeProblems.push(`The log could not be written: ${startLog.problem.message}`);

  const parser = adapter.parser({ model, worktree: opts.worktree.path, brief: opts.brief, shell: opts.shell ?? false });
  const splitter = new LineSplitter(
    MAX_EVENT_LINE_BYTES,
    (line) => {
      try {
        parser.line(line);
      } catch {
        parser.skipped(Buffer.byteLength(line));
      }
    },
    (bytes) => parser.skipped(bytes),
  );
  const started = performance.now();
  // The folder once more, right before the start: another worker may have swapped it for a link meanwhile.
  const lateProblem = await worktreeProblem(store, opts.worktree);
  const end: ProcessEnd = lateProblem !== null ? { ...NOT_SPAWNED, spawnError: lateProblem } : await runProcess(
    launch,
    opts.worktree.path,
    env,
    stdin,
    timeoutMs,
    opts.signal,
    (chunk) => {
      if (!out.value.isClosed) out.value.write(chunk);
      splitter.push(chunk);
    },
    (chunk) => {
      if (!err.value.isClosed) err.value.write(chunk);
    },
  );
  splitter.end();
  const durationMs = Math.round(performance.now() - started);
  const report = parser.report();
  const { status, error } = verdict(adapter, end, report, timeoutMs);
  const stdout = await closeOutput(out.value, storeProblems);
  const stderr = await closeOutput(err.value, storeProblems);

  const endedAt = now().toISOString();
  const stored = error === null ? null : clipText(error, MAX_ERROR_BYTES);
  const finished: WorkerRun = { ...run, endedAt, exitCode: end.exitCode, error: stored, tokens: report.tokens };
  const updated = await store.update((state) => {
    const workers = [...(taskState(state, taskId)?.workers ?? [])];
    const index = workers.findLastIndex((w) => w.round === round && w.startedAt === startedAt && w.endedAt === null);
    if (index === -1) workers.push(finished);
    else workers[index] = finished;
    return withTask(state, taskId, { workers });
  });
  if (!updated.ok) storeProblems.push(`The end of the worker run could not be recorded: ${updated.problem.message}`);
  const endLog = await store.appendLog(workerEntry(taskId, round, 'finished', { engine, model, exitCode: end.exitCode, error: stored }));
  if (!endLog.ok) storeProblems.push(`The log could not be written: ${endLog.problem.message}`);

  return {
    status,
    engine,
    model,
    exitCode: end.exitCode,
    signal: end.signal,
    startedAt,
    endedAt,
    durationMs,
    report,
    error,
    notes: end.note === null ? [] : [end.note],
    mayStillBeRunning: end.mayStillBeRunning,
    output: { stdout, stderr },
    refusedEnv: refused,
    storeProblems,
  };
}
