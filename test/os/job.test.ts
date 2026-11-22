import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createJob, type ProcessJob } from '../../src/os/job.js';

const WINDOWS = process.platform === 'win32';
const scratch: string[] = [];
const jobs: ProcessJob[] = [];
/** Processes started indirectly and not yet seen gone (a process seen gone is taken off: its id may be reused). */
const strays: number[] = [];
afterEach(() => {
  for (const job of jobs.splice(0)) job.close();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-job-'));
  scratch.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await delay(50);
  if (alive(pid)) return false;
  const index = strays.indexOf(pid);
  if (index !== -1) strays.splice(index, 1);
  return true;
}

function newJob(): ProcessJob {
  const made = createJob();
  if (!made.ok) throw new Error(made.error);
  jobs.push(made.job);
  return made.job;
}

/**
 * A node process that waits for a line on stdin, then starts a child that writes its pid to `pidFile` and keeps
 * running (detached, so its parent's own job doesn't hold it), and exits. Waiting first leaves time to put it in
 * a job before it starts anything.
 */
function parent(pidFile: string): ChildProcessWithoutNullStreams {
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
  const code =
    `process.stdin.once('data', () => {` +
    ` require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore', detached: true }).unref();` +
    ` process.exit(0); });`;
  return spawn(process.execPath, ['-e', code], { windowsHide: true });
}

async function leftoverOf(proc: ChildProcessWithoutNullStreams, pidFile: string): Promise<number> {
  const exited = new Promise<void>((done) => proc.once('exit', () => done()));
  proc.stdin.write('go\n');
  await exited;
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(50);
  await delay(50);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  // Never 0 or less: killing 0 after the test would reach the test runner's own process group.
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`No process id in ${pidFile}.`);
  strays.push(pid);
  return pid;
}

describe('createJob', () => {
  it.skipIf(WINDOWS)('says Job Objects exist only on Windows', () => {
    expect(createJob()).toEqual({ ok: false, error: 'Job Objects exist only on Windows.' });
  });

  it.runIf(WINDOWS)('without a job, a process whose parent exited keeps running (what the job is for)', async () => {
    const pidFile = join(tempDir(), 'free.pid');
    const leftover = await leftoverOf(parent(pidFile), pidFile);
    await delay(500);
    expect(alive(leftover)).toBe(true);
  });

  it.runIf(WINDOWS)('stops a process and what it started, even after the parent exited', async () => {
    const pidFile = join(tempDir(), 'held.pid');
    const proc = parent(pidFile);
    const job = newJob();
    expect(job.add(proc.pid as number)).toBeNull();
    const leftover = await leftoverOf(proc, pidFile);
    expect(alive(leftover)).toBe(true);
    expect(job.terminate()).toBeNull();
    expect(await gone(leftover)).toBe(true);
  });

  it.runIf(WINDOWS)('stops what is still in the job when the job is closed', async () => {
    const pidFile = join(tempDir(), 'closed.pid');
    const proc = parent(pidFile);
    const job = newJob();
    expect(job.add(proc.pid as number)).toBeNull();
    const leftover = await leftoverOf(proc, pidFile);
    expect(alive(leftover)).toBe(true);
    job.close();
    expect(await gone(leftover)).toBe(true);
  });

  it.runIf(WINDOWS)('refuses a process id that cannot be one, and anything once closed', () => {
    const job = newJob();
    expect(job.add(0)).toBe('There is no process 0.');
    expect(job.add(-1)).toBe('There is no process -1.');
    expect(job.add(1.5)).toBe('There is no process 1.5.');
    job.close();
    job.close();
    expect(job.add(4321)).toBe('The Job Object was already closed.');
    expect(job.terminate()).toBe('The Job Object was already closed.');
  });
});
