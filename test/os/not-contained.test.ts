/**
 * What every runner does when a process can't be contained (on Windows: no Job Object). Either nothing is started
 * (no job could be made), or the process is stopped as it starts and never gets its input (it could not be put in
 * the job). prepareTree is replaced here so this runs on every platform; it is tested in process-tree.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/accept/run.js';
import { detectEngines } from '../../src/engines/detect.js';
import { runWorker, type WorkerOutcome } from '../../src/engines/worker.js';
import { createRun, type RunStore } from '../../src/store/run.js';
import { fakeEnv, installFakeEngine, type FakeEngine } from '../helpers/fake-engine.js';
import { BASE, NOW, sampleReady } from '../helpers/store.js';

const NO_JOB = 'No Windows Job Object could be made for it, so it was not started: koffi is missing.';
const NOT_TAKEN = 'It could not be put in its Windows Job Object, so it was stopped: Windows error 5.';

const mode = vi.hoisted(() => ({ current: 'no-job' as 'no-job' | 'not-taken' }));

vi.mock('../../src/os/process-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/os/process-tree.js')>();
  return {
    ...actual,
    prepareTree: () =>
      mode.current === 'no-job'
        ? { ok: false, error: NO_JOB }
        : { ok: true, tree: { attach: () => NOT_TAKEN, stop: () => {}, end: () => {} } },
  };
});

const RUN = '20261121-120000-abcd';
const scratch: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-contain-')));
  scratch.push(dir);
  return dir;
}

/** Runs a Claude worker whose engine never ends on its own: only being stopped ends it before its time limit. */
async function runHangingWorker(): Promise<{ outcome: WorkerOutcome; fake: FakeEngine; store: RunStore; ms: number }> {
  const root = tempDir();
  const home = join(root, 'home');
  const created = await createRun(home, { runId: RUN, ready: sampleReady([{ id: 'api', engine: 'claude', model: 'opus' }]), hooks: 'off', caseInsensitivePaths: true }, { now: () => NOW });
  if (!created.ok) throw new Error(created.problem.message);
  const store = created.value;
  stores.push(store);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const path = join(home, 'wt', RUN, 'api');
  mkdirSync(path, { recursive: true });
  const fake = installFakeEngine(bin, 'claude', { run: { hang: true } });
  const started = Date.now();
  const outcome = await runWorker({
    store,
    worktree: { runId: RUN, taskId: 'api', path, branch: `orchestra/${RUN}/api`, ref: '', startSha: BASE, adminDir: '', lockReason: '', worktreeConfig: 'missing' },
    round: 0,
    brief: 'The secret brief.',
    env: fakeEnv(bin),
    timeoutMs: 20_000,
    now: () => NOW,
  });
  return { outcome, fake, store, ms: Date.now() - started };
}

function writeCommand(marker: string): string[] {
  return [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
}

describe('when no Job Object can be made', () => {
  it('starts no worker', async () => {
    mode.current = 'no-job';
    const { outcome, fake, store } = await runHangingWorker();
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toBe(`Claude Code could not be started: ${NO_JOB}`);
    expect(fake.calls()).toEqual([]);
    expect(store.state.tasks.find((t) => t.id === 'api')?.workers[0]?.error).toBe(`Claude Code could not be started: ${NO_JOB}`);
  });

  it('starts no acceptance command', async () => {
    mode.current = 'no-job';
    const dir = tempDir();
    const marker = join(dir, 'ran.txt');
    const result = await runCommand(dir, writeCommand(marker));
    expect(result).toMatchObject({ status: 'not-started', exitCode: null, error: NO_JOB });
    await delay(500);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs no detection probe', async () => {
    mode.current = 'no-job';
    const bin = join(tempDir(), 'bin');
    mkdirSync(bin);
    const fake = installFakeEngine(bin, 'codex', { replies: { '--version': { stdout: ['codex-cli 0.170.0'] } } });
    const detection = await detectEngines({ env: fakeEnv(bin), cwd: realpathSync(tmpdir()), engines: ['codex'] });
    expect(detection.ready).toEqual([]);
    expect(detection.engines[0]?.problems[0]).toMatchObject({ code: 'not-runnable' });
    expect(detection.engines[0]?.problems[0]?.message).toContain(NO_JOB);
    expect(fake.calls()).toEqual([]);
  });
});

describe('when a process cannot be put in its Job Object', () => {
  it('stops the worker as it starts, before it gets its brief', async () => {
    mode.current = 'not-taken';
    const { outcome, fake, store, ms } = await runHangingWorker();
    expect(ms).toBeLessThan(10_000);
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toBe(`Claude Code was stopped as it started. ${NOT_TAKEN}`);
    expect(outcome.mayStillBeRunning).toBe(false);
    // Stopped before node even ran the engine's script, which records every call it gets.
    expect(fake.calls()).toEqual([]);
    expect(store.state.tasks.find((t) => t.id === 'api')?.workers[0]?.error).toBe(`Claude Code was stopped as it started. ${NOT_TAKEN}`);
  });

  it('stops an acceptance command as it starts', async () => {
    mode.current = 'not-taken';
    const dir = tempDir();
    const marker = join(dir, 'ran.txt');
    const result = await runCommand(dir, writeCommand(marker));
    expect(result).toMatchObject({ status: 'not-started', exitCode: null, error: `Stopped as it started. ${NOT_TAKEN}` });
    await delay(500);
    expect(existsSync(marker)).toBe(false);
  });
});
