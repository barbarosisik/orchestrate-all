import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  identifyProcess,
  lookupProcess,
  processFolder,
  parseProcStat,
  parsePsLine,
  sameProcess,
  stopVerifiedProcess,
} from '../../src/os/process-identity.js';

const WINDOWS = process.platform === 'win32';
const children: ChildProcess[] = [];
afterEach(() => {
  // Only processes this test started and still sees running; never a group, never 0.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill('SIGKILL');
  }
});

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-cwd-')));
  folders.push(dir);
  return dir;
}

function sleeper(detached: boolean, cwd?: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached, ...(cwd !== undefined ? { cwd } : {}) });
  children.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done();
    else child.once('exit', () => done());
  });
}

describe('lookupProcess', () => {
  it('finds this process, with a start time that stays the same', async () => {
    const first = await lookupProcess(process.pid);
    const second = await lookupProcess(process.pid);
    expect(first.state).toBe('running');
    if (first.state !== 'running' || second.state !== 'running') return;
    expect(first.start).not.toBeNull();
    expect(second.start).toBe(first.start);
  });

  it('finds a child while it runs, and not once it has ended', async () => {
    const child = sleeper(false);
    const pid = child.pid as number;
    const running = await lookupProcess(pid);
    expect(running.state).toBe('running');
    child.kill('SIGKILL');
    await exited(child);
    expect((await lookupProcess(pid)).state).toBe('gone');
  });

  it('counts a process that has exited but was not reaped yet as gone', async () => {
    // The parent writes its child's id, then blocks without reaping the child once it exits (a zombie on Linux and
    // macOS, an exited process whose handle is still open on Windows).
    const parent = spawn(
      process.execPath,
      ['-e', "const c=require('child_process').spawn(process.execPath,['-e','0'],{stdio:'ignore'});require('fs').writeSync(1,String(c.pid)+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,8000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(parent);
    const pid = await new Promise<number>((resolve) => parent.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    let state = 'running';
    for (let i = 0; i < 100 && state === 'running'; i++) {
      await delay(50);
      state = (await lookupProcess(pid)).state;
    }
    expect(state).toBe('gone');
    expect(parent.exitCode).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 40])('never looks up %s', async (pid) => {
    expect(await lookupProcess(pid)).toEqual({ state: 'gone' });
  });

  it.skipIf(WINDOWS)('tells whether the process leads its own process group', async () => {
    const own = sleeper(true);
    const shared = sleeper(false);
    const ownFound = await lookupProcess(own.pid as number);
    const sharedFound = await lookupProcess(shared.pid as number);
    expect(ownFound.state === 'running' && ownFound.groupLeader).toBe(true);
    expect(sharedFound.state === 'running' && sharedFound.groupLeader).toBe(false);
  });

  it.runIf(WINDOWS)('reports no process groups on Windows', async () => {
    const found = await lookupProcess(process.pid);
    expect(found.state === 'running' && found.groupLeader).toBeNull();
  });
});

describe('identifyProcess and sameProcess', () => {
  it('recognizes the same process and tells another one apart', async () => {
    const child = sleeper(false);
    const recorded = await identifyProcess(child.pid as number);
    expect(recorded?.pid).toBe(child.pid);
    expect(sameProcess(recorded, await lookupProcess(child.pid as number))).toBe('same');
    expect(sameProcess(recorded === null ? null : { ...recorded, start: `${recorded.start}-other` }, await lookupProcess(child.pid as number))).toBe('other');
    expect(sameProcess({ pid: child.pid as number, start: null }, await lookupProcess(child.pid as number))).toBe('unknown');
    expect(sameProcess(null, await lookupProcess(child.pid as number))).toBe('unknown');
    expect(sameProcess(recorded, { state: 'gone' })).toBe('gone');
    expect(sameProcess(recorded, { state: 'running', start: null, groupLeader: null })).toBe('unknown');
  });

  it('identifies nothing for a process that is gone', async () => {
    const child = sleeper(false);
    const pid = child.pid as number;
    child.kill('SIGKILL');
    await exited(child);
    expect(await identifyProcess(pid)).toBeNull();
  });
});

describe('stopVerifiedProcess', () => {
  it.skipIf(WINDOWS)('stops a process it has just recognized, with its whole group', async () => {
    const child = sleeper(true);
    const recorded = await identifyProcess(child.pid as number);
    const ended = exited(child);
    expect(await stopVerifiedProcess(recorded)).toBe('stopped');
    await ended;
  });

  it.skipIf(WINDOWS)('never stops a process whose start time differs (its id was reused)', async () => {
    const child = sleeper(true);
    const recorded = await identifyProcess(child.pid as number);
    expect(recorded).not.toBeNull();
    expect(await stopVerifiedProcess({ pid: child.pid as number, start: `${recorded?.start}x` })).toBe('not-ours');
    expect(await stopVerifiedProcess({ pid: child.pid as number, start: null })).toBe('unverified');
    await delay(50);
    expect(child.exitCode).toBeNull();
  });

  it.skipIf(WINDOWS)('stops it only when it works inside the given folder (a forged record names another process)', async () => {
    const own = folder();
    const elsewhere = folder();
    const child = sleeper(true, elsewhere);
    const recorded = await identifyProcess(child.pid as number);
    expect(await processFolder(child.pid as number)).toBe(elsewhere);
    expect(await stopVerifiedProcess(recorded, { insideFolder: own })).toBe('elsewhere');
    await delay(50);
    expect(child.exitCode).toBeNull();
    const ended = exited(child);
    expect(await stopVerifiedProcess(recorded, { insideFolder: elsewhere })).toBe('stopped');
    await ended;
  });

  it.runIf(WINDOWS)('reads no working folder on Windows', async () => {
    expect(await processFolder(process.pid)).toBeNull();
  });

  it('reads no working folder for an id that names no process', async () => {
    expect(await processFolder(0)).toBeNull();
  });

  it('reports a process that is already gone', async () => {
    const child = sleeper(true);
    const recorded = await identifyProcess(child.pid as number);
    child.kill('SIGKILL');
    await exited(child);
    expect(await stopVerifiedProcess(recorded)).toBe('gone');
    expect(await stopVerifiedProcess(null)).toBe('unverified');
    // Never 0 (which names the caller's own process group) nor any other id that names no single process.
    for (const pid of [0, -1, 1.5]) expect(await stopVerifiedProcess({ pid, start: 'x' })).toBe('unverified');
  });

  it.runIf(WINDOWS)('never stops a Windows process, and reports one still running', async () => {
    const child = sleeper(false);
    const recorded = await identifyProcess(child.pid as number);
    expect(await stopVerifiedProcess(recorded)).toBe('still-running');
    await delay(50);
    expect(child.exitCode).toBeNull();
  });
});

describe('parseProcStat (Linux)', () => {
  const stat = (comm: string, state: string, pgrp: number, start: number): string =>
    `4242 (${comm}) ${state} 1 ${pgrp} 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 10 18446744073709551615`;

  it('reads state, group and start, whatever the command name holds', () => {
    expect(parseProcStat(stat('node', 'S', 4242, 777), 4242)).toEqual({ zombie: false, groupLeader: true, startTicks: '777' });
    expect(parseProcStat(stat('a) (b) S 9 9', 'R', 1, 778), 4242)).toEqual({ zombie: false, groupLeader: false, startTicks: '778' });
    expect(parseProcStat(stat('x', 'Z', 4242, 779), 4242)?.zombie).toBe(true);
  });

  it('refuses text that is not a stat line', () => {
    expect(parseProcStat('', 1)).toBeNull();
    expect(parseProcStat('4242 (node S 1 2', 4242)).toBeNull();
    expect(parseProcStat('4242 (node) S 1', 4242)).toBeNull();
    expect(parseProcStat(stat('node', 'S', 1, 777).replace(' 777 ', ' x7 '), 4242)).toBeNull();
  });

  it('reads a huge line in linear time', () => {
    const started = performance.now();
    parseProcStat(`1 (${') '.repeat(200_000)}`, 1);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('parsePsLine (macOS)', () => {
  it('reads state, group and start time', () => {
    expect(parsePsLine('Ss   4242 Sun Nov 22 12:23:45 2026\n', 4242)).toEqual({ zombie: false, groupLeader: true, start: 'Sun Nov 22 12:23:45 2026' });
    expect(parsePsLine('S+ 1 Mon Nov  2 01:02:03 2026', 4242)).toEqual({ zombie: false, groupLeader: false, start: 'Mon Nov 2 01:02:03 2026' });
    expect(parsePsLine('Z 4242 Sun Nov 22 12:23:45 2026', 4242)?.zombie).toBe(true);
  });

  it('refuses anything else', () => {
    expect(parsePsLine('', 1)).toBeNull();
    expect(parsePsLine('S x Sun Nov 22 12:23:45 2026', 1)).toBeNull();
    expect(parsePsLine('S 12', 12)).toBeNull();
    expect(parsePsLine('S 1 a\nS 2 b', 1)).toBeNull();
  });
});
