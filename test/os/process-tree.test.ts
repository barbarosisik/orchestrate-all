import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobResult, ProcessJob } from '../../src/os/job.js';
import { OWN_PROCESS_GROUP, prepareTree, type ProcessTree } from '../../src/os/process-tree.js';

const WINDOWS = process.platform === 'win32';
const scratch: string[] = [];
const children: ChildProcess[] = [];
/**
 * Processes the tests started indirectly and have not seen end, stopped after each test in case it failed halfway.
 * A process seen gone is taken off at once: its id may be reused by another process.
 */
const strays: number[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
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
  const dir = mkdtempSync(join(tmpdir(), 'orch-tree-'));
  scratch.push(dir);
  return dir;
}

/** A node process that runs `code`, started the way the runners start theirs (its own group on Linux and macOS). */
function start(code: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', code], { detached: OWN_PROCESS_GROUP, stdio: 'ignore', windowsHide: true });
  children.push(child);
  return child;
}

/** The way the runners do it: the tree first, then the start, then the process taken in. */
function startIn(code: string): { child: ChildProcess; tree: ProcessTree } {
  const prepared = prepareTree();
  if (!prepared.ok) throw new Error(prepared.error);
  const child = start(code);
  expect(prepared.tree.attach(child.pid as number)).toBeNull();
  return { child, tree: prepared.tree };
}

function exited(child: ChildProcess, ms = 10_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([new Promise<boolean>((done) => child.once('exit', () => done(true))), delay(ms).then(() => false)]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits up to 5 s for process `pid` to end; true when it did. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await delay(50);
  if (alive(pid)) return false;
  const index = strays.indexOf(pid);
  if (index !== -1) strays.splice(index, 1);
  return true;
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100 && !existsSync(file); i++) await delay(50);
  await delay(50);
  const pid = Number(readFileSync(file, 'utf8'));
  // Never 0 or less: killing 0 after the test would reach the test runner's own process group.
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`No process id in ${file}.`);
  strays.push(pid);
  return pid;
}

/** Code that starts a child which writes its pid to `pidFile` and keeps running, then keeps running itself. */
function parentOf(pidFile: string): string {
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
  return `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`;
}

interface FakeJob extends ProcessJob {
  readonly calls: string[];
}

function fakeJob(results: { add?: string | null; terminate?: string | null } = {}): FakeJob {
  const calls: string[] = [];
  return {
    calls,
    add: (pid) => {
      calls.push(`add ${pid}`);
      return results.add ?? null;
    },
    terminate: () => {
      calls.push('terminate');
      return results.terminate ?? null;
    },
    close: () => {
      calls.push('close');
    },
  };
}

const made = (job: ProcessJob): (() => JobResult) => () => ({ ok: true, job });

describe('prepareTree with a Job Object (Windows)', () => {
  it('makes the job before the start, takes the process in, stops the job, and frees it once at the end', () => {
    const job = fakeJob();
    let made = 0;
    const result = prepareTree({ platform: 'win32', createJob: () => (made++, { ok: true, job }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(made).toBe(1);
    expect(job.calls).toEqual([]);
    expect(result.tree.attach(4321)).toBeNull();
    expect(job.calls).toEqual(['add 4321']);
    result.tree.stop();
    expect(job.calls).toEqual(['add 4321', 'terminate']);
    result.tree.end();
    result.tree.end();
    result.tree.stop();
    expect(job.calls).toEqual(['add 4321', 'terminate', 'terminate', 'close']);
  });

  it('refuses before anything starts when no job can be made', () => {
    const result = prepareTree({ platform: 'win32', createJob: () => ({ ok: false, error: 'koffi is missing.' }) });
    expect(result).toEqual({ ok: false, error: 'No Windows Job Object could be made for it, so it was not started: koffi is missing.' });
  });

  it('says why a process could not be taken in, and frees the job at the end', () => {
    const job = fakeJob({ add: 'Putting process 7 in the Job Object failed (Windows error 5).' });
    const result = prepareTree({ platform: 'win32', createJob: made(job) });
    if (!result.ok) throw new Error(result.error);
    expect(result.tree.attach(7)).toBe('It could not be put in its Windows Job Object, so it was stopped: Putting process 7 in the Job Object failed (Windows error 5).');
    result.tree.end();
    expect(job.calls).toEqual(['add 7', 'terminate', 'close']);
  });

  it('takes in one real process id only, and nothing once ended', () => {
    const job = fakeJob();
    const result = prepareTree({ platform: 'win32', createJob: made(job) });
    if (!result.ok) throw new Error(result.error);
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(result.tree.attach(pid)).toBe(`Process ${pid} can't be taken in.`);
    expect(result.tree.attach(9)).toBeNull();
    expect(result.tree.attach(10)).toBe("Process 10 can't be taken in.");
    result.tree.end();
    expect(result.tree.attach(11)).toBe("Process 11 can't be taken in.");
    expect(job.calls).toEqual(['add 9', 'terminate', 'close']);
  });

  it('stops the tree another way when the job cannot be stopped', async () => {
    const job = fakeJob({ terminate: 'Stopping the Job Object failed (Windows error 6).' });
    const result = prepareTree({ platform: 'win32', createJob: made(job) });
    if (!result.ok) throw new Error(result.error);
    const child = start('setTimeout(() => {}, 60000)');
    expect(result.tree.attach(child.pid as number)).toBeNull();
    result.tree.stop();
    expect(await exited(child)).toBe(true);
    result.tree.end();
  });
});

describe('prepareTree with a process group (Linux and macOS)', () => {
  it('kills the group to stop it, and once more at the end, never after, and never before a process is taken in', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const result = prepareTree({ platform: 'linux' });
      if (!result.ok) throw new Error(result.error);
      result.tree.stop();
      expect(kill).not.toHaveBeenCalled();
      // Never 0 or less: kill(-0) would reach Orchestra's own group.
      expect(result.tree.attach(0)).toBe("Process 0 can't be taken in.");
      expect(result.tree.attach(-5)).toBe("Process -5 can't be taken in.");
      result.tree.stop();
      expect(kill).not.toHaveBeenCalled();
      expect(result.tree.attach(999_999)).toBeNull();
      result.tree.stop();
      result.tree.end();
      result.tree.end();
      result.tree.stop();
      expect(kill.mock.calls).toEqual([
        [-999_999, 'SIGKILL'],
        [-999_999, 'SIGKILL'],
      ]);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('prepareTree for real', () => {
  it('stops the process and what it started', async () => {
    const pidFile = join(tempDir(), 'grandchild.pid');
    const { child, tree } = startIn(parentOf(pidFile));
    const grandchild = await readPid(pidFile);
    expect(alive(grandchild)).toBe(true);
    tree.stop();
    expect(await exited(child)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
    tree.end();
  });

  // On Windows Node itself stops a child started without `detached` when its parent exits; the next test covers it.
  it.skipIf(WINDOWS)('stops what the process left running when it exited', async () => {
    const pidFile = join(tempDir(), 'leftover.pid');
    const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    const { child: parent, tree } = startIn(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }).unref();`);
    const leftover = await readPid(pidFile);
    expect(await exited(parent)).toBe(true);
    expect(alive(leftover)).toBe(true);
    tree.end();
    expect(await gone(leftover)).toBe(true);
  });

  it.runIf(WINDOWS)('on Windows, also stops a process started detached, whose parent exited', async () => {
    const pidFile = join(tempDir(), 'detached.pid');
    const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    const { child: parent, tree } = startIn(
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore', detached: true }).unref();`,
    );
    const leftover = await readPid(pidFile);
    expect(await exited(parent)).toBe(true);
    expect(alive(leftover)).toBe(true);
    tree.end();
    expect(await gone(leftover)).toBe(true);
  });
});
