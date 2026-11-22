/**
 * Stopping a process and everything it started (steps 6 and 10).
 *
 * - Linux and macOS: the process is started in its own process group (`detached: true`), and the whole group
 *   is killed. A process that left the group (started a session of its own) is not reached.
 * - Windows: the process goes into a Job Object of its own, made before it starts (job.ts), and the whole job is
 *   stopped: also processes whose parent already exited. Without a job the process is not run at all.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createJob, type JobResult, type ProcessJob } from './job.js';

/** The longest delay a timer takes: Node runs a longer one (or NaN, Infinity) after 1 ms instead. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A time limit usable with setTimeout: `ms` when it is a positive number (at most MAX_TIMER_MS), else `fallback`. */
export function timerDelay(ms: number | undefined, fallback: number): number {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : fallback;
}

/** Whether a child should be started in its own process group, so its whole tree can be stopped. */
export const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** A process about to be started, and everything it will start. */
export interface ProcessTree {
  /**
   * Takes in process `pid`, just started (with `detached: OWN_PROCESS_GROUP`): null, or why it could not be (only on
   * Windows). On a refusal the caller must stop the process at once (`child.kill`), before giving it anything.
   */
  attach(pid: number): string | null;
  /** Stops the process and everything it started (a time limit, a cancel). Never throws. */
  stop(): void;
  /**
   * Once the process has exited, or could not be started: stops whatever it left running, and frees what held the
   * tree. Safe to call more than once; stop() does nothing after it. Never throws.
   */
  end(): void;
}

export interface ContainOptions {
  /** Defaults to this process's platform. */
  readonly platform?: NodeJS.Platform;
  /** Makes a Windows Job Object (job.ts). */
  readonly createJob?: () => JobResult;
  /** Where to find `taskkill`, the last resort on Windows (SystemRoot); defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
}

export type PrepareResult = { readonly ok: true; readonly tree: ProcessTree } | { readonly ok: false; readonly error: string };

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/**
 * Gets ready to take charge of a process before it is started, so that after the start only `attach` is left. On
 * Windows this makes the process's Job Object now (loading koffi the first time); it fails when none can be made,
 * and then nothing should be started.
 */
export function prepareTree(opts: ContainOptions = {}): PrepareResult {
  if ((opts.platform ?? process.platform) !== 'win32') return { ok: true, tree: groupTree() };
  const made = (opts.createJob ?? createJob)();
  if (!made.ok) return { ok: false, error: `No Windows Job Object could be made for it, so it was not started: ${made.error}` };
  return { ok: true, tree: jobTree(made.job, opts.env ?? process.env) };
}

/** Linux and macOS: the process's own group (it was started as a group leader). */
function groupTree(): ProcessTree {
  let pid: number | null = null;
  // Once ended, never again: when the whole group is gone, its number may be given to another one.
  let ended = false;
  const killGroup = (): void => {
    if (pid === null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  };
  return {
    attach: (started) => {
      // Never 0 or less: kill(-0) would reach Orchestra's own group.
      if (ended || pid !== null || !validPid(started)) return `Process ${started} can't be taken in.`;
      pid = started;
      return null;
    },
    stop: () => {
      if (!ended) killGroup();
    },
    end: () => {
      if (ended) return;
      ended = true;
      killGroup();
    },
  };
}

/** Windows: the process's own Job Object, made before it started. */
function jobTree(job: ProcessJob, env: NodeJS.ProcessEnv): ProcessTree {
  let pid: number | null = null;
  let ended = false;
  return {
    attach: (started) => {
      if (ended || pid !== null || !validPid(started)) return `Process ${started} can't be taken in.`;
      const problem = job.add(started);
      if (problem !== null) return `It could not be put in its Windows Job Object, so it was stopped: ${problem}`;
      pid = started;
      return null;
    },
    stop: () => {
      if (ended) return;
      // The job stops all of it. taskkill is only the last resort, for what is still in the tree: stop() is called
      // while the process runs, so Node still holds it and its id can't belong to another process yet.
      if (job.terminate() !== null && pid !== null) void stopTree(pid, env);
    },
    end: () => {
      if (ended) return;
      ended = true;
      job.terminate();
      job.close();
    },
  };
}

/**
 * Stops process `pid` and everything it started, without a Job Object. Never throws; resolves once the stop was
 * attempted. Linux and macOS: its process group. Windows: `taskkill /t /f`, which reaches only the processes whose
 * parents are still running.
 */
export async function stopTree(pid: number, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
    return;
  }
  const systemRoot = Object.entries(env).find(([k]) => k.toUpperCase() === 'SYSTEMROOT')?.[1] ?? process.env.SystemRoot;
  if (systemRoot === undefined) return;
  await new Promise<void>((done) => {
    const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => done());
    killer.on('close', () => done());
  });
}
