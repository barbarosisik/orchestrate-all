import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, readLockOwner, removeStale, type LockOwner } from '../../src/manager/lock.js';
import { identifyProcess } from '../../src/os/process-identity.js';

const WINDOWS = process.platform === 'win32';
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-lock-'));
  scratch.push(dir);
  return dir;
}

function owner(path: string): LockOwner {
  return JSON.parse(readFileSync(path, 'utf8')) as LockOwner;
}

/** The identity of a process that has ended: its id names nothing now (or something else). */
async function deadOwner(): Promise<LockOwner> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const identity = await identifyProcess(child.pid as number);
  await new Promise<void>((done) => {
    child.once('exit', () => done());
    child.kill('SIGKILL');
  });
  return { pid: child.pid as number, start: identity?.start ?? 'gone', nonce: 'a'.repeat(32), createdAt: new Date().toISOString() };
}

describe('acquireLock', () => {
  it('takes a free lock, names its holder, and refuses a second holder while it lives', async () => {
    const path = join(folder(), 'conductor.lock');
    const first = await acquireLock(path);
    if (!first.ok) throw new Error(first.message);
    expect(owner(path)).toMatchObject({ pid: process.pid, nonce: first.lock.owner.nonce });
    expect(await first.lock.stillHeld()).toBe(true);
    const second = await acquireLock(path);
    expect(second.ok ? 'ok' : second.code).toBe('busy');
    expect(second.ok ? null : second.owner?.nonce).toBe(first.lock.owner.nonce);
    await first.lock.release();
    expect(readdirSync(join(path, '..'))).toEqual([]);
    const third = await acquireLock(path);
    expect(third.ok).toBe(true);
    if (third.ok) await third.lock.release();
  });

  it('replaces a lock left by a process that has ended, and leaves nothing else behind', async () => {
    const dir = folder();
    const path = join(dir, 'conductor.lock');
    writeFileSync(path, JSON.stringify(await deadOwner()));
    const taken = await acquireLock(path);
    if (!taken.ok) throw new Error(taken.message);
    expect(owner(path).nonce).toBe(taken.lock.owner.nonce);
    expect(readdirSync(dir)).toEqual(['conductor.lock']);
    expect(taken.lock.notes.join(' ')).toContain('left by a process that has ended');
    await taken.lock.release();
  });

  it('replaces a lock whose process id now belongs to another process (a different start time)', async () => {
    const path = join(folder(), 'conductor.lock');
    const me = await identifyProcess(process.pid);
    writeFileSync(path, JSON.stringify({ pid: process.pid, start: `${me?.start}-before`, nonce: 'b'.repeat(32), createdAt: new Date().toISOString() }));
    const taken = await acquireLock(path);
    expect(taken.ok).toBe(true);
    if (taken.ok) await taken.lock.release();
  });

  it('never replaces a lock whose holder may still run (its start time is unknown)', async () => {
    const path = join(folder(), 'conductor.lock');
    const held = { pid: process.pid, start: null, nonce: 'c'.repeat(32), createdAt: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(held));
    const refused = await acquireLock(path);
    expect(refused.ok ? 'ok' : refused.code).toBe('busy');
    expect(refused.ok ? '' : refused.message).toContain(path);
    expect(owner(path).nonce).toBe(held.nonce);
  });

  it('waits on a damaged lock while it is new, and replaces it once it is old', async () => {
    const path = join(folder(), 'conductor.lock');
    writeFileSync(path, '{"pid":');
    const fresh = await acquireLock(path);
    expect(fresh.ok ? 'ok' : fresh.code).toBe('busy');
    const old = new Date(Date.now() - 120_000);
    utimesSync(path, old, old);
    const taken = await acquireLock(path);
    expect(taken.ok).toBe(true);
    if (taken.ok) await taken.lock.release();
  });

  it.skipIf(WINDOWS)('refuses a lock file or folder that is a link', async () => {
    const dir = folder();
    const elsewhere = join(dir, 'elsewhere');
    writeFileSync(elsewhere, JSON.stringify(await deadOwner()));
    symlinkSync(elsewhere, join(dir, 'conductor.lock'));
    const refused = await acquireLock(join(dir, 'conductor.lock'));
    expect(refused.ok ? 'ok' : refused.code).toBe('link');
    const real = join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'linked'));
    const viaLink = await acquireLock(join(dir, 'linked', 'conductor.lock'));
    expect(viaLink.ok ? 'ok' : viaLink.code).toBe('link');
  });

  it('clears a takeover file left by a process that ended while replacing a stale lock', async () => {
    const dir = folder();
    const path = join(dir, 'conductor.lock');
    writeFileSync(path, JSON.stringify(await deadOwner()));
    writeFileSync(`${path}.takeover`, JSON.stringify({ ...(await deadOwner()), nonce: 'f'.repeat(32) }));
    const taken = await acquireLock(path);
    if (!taken.ok) throw new Error(taken.message);
    expect(readdirSync(dir)).toEqual(['conductor.lock']);
    await taken.lock.release();
  });

  it('waits while a running process replaces a stale lock, then reports the lock busy', async () => {
    const dir = folder();
    const path = join(dir, 'conductor.lock');
    writeFileSync(path, JSON.stringify(await deadOwner()));
    const me = await identifyProcess(process.pid);
    writeFileSync(`${path}.takeover`, JSON.stringify({ pid: process.pid, start: me?.start ?? null, nonce: '9'.repeat(32), createdAt: new Date().toISOString() }));
    const refused = await acquireLock(path, { retryDelayMs: 1 });
    expect(refused.ok ? 'ok' : refused.message).toContain('replacing a stale lock');
  });

  it('gives exactly one holder when many try at once, also over a stale lock', async () => {
    for (const stale of [false, true, false, true, true]) {
      const dir = folder();
      const path = join(dir, 'conductor.lock');
      if (stale) writeFileSync(path, JSON.stringify(await deadOwner()));
      const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(path)));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner?.ok) {
        expect(owner(path).nonce).toBe(winner.lock.owner.nonce);
        await winner.lock.release();
      }
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('tells a holder when its lock was taken from it', async () => {
    const path = join(folder(), 'conductor.lock');
    const held = await acquireLock(path);
    if (!held.ok) throw new Error(held.message);
    writeFileSync(path, JSON.stringify({ ...held.lock.owner, nonce: 'd'.repeat(32) }));
    expect(await held.lock.stillHeld()).toBe(false);
    await held.lock.release();
    // A lock that is no longer its own is left alone.
    expect(owner(path).nonce).toBe('d'.repeat(32));
  });
});

describe('removeStale', () => {
  it('puts back a lock that is not the stale one it was asked to remove', async () => {
    const dir = folder();
    const path = join(dir, 'conductor.lock');
    const stale = await deadOwner();
    const fresh = { ...(await deadOwner()), nonce: '7'.repeat(32) };
    writeFileSync(path, JSON.stringify(fresh));
    expect(await removeStale(path, stale, '1'.repeat(32), 0)).toBe(false);
    expect(owner(path).nonce).toBe(fresh.nonce);
    expect(readdirSync(dir)).toEqual(['conductor.lock']);
    expect(await removeStale(path, fresh, '1'.repeat(32), 1)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(await removeStale(path, fresh, '1'.repeat(32), 2)).toBe(false);
  });
});

describe('readLockOwner', () => {
  it('reads a valid owner and nothing else', async () => {
    const dir = folder();
    const path = join(dir, 'conductor.lock');
    expect(await readLockOwner(path)).toEqual({ ok: false, code: 'missing' });
    writeFileSync(path, 'x'.repeat(100_000));
    expect((await readLockOwner(path)).ok).toBe(false);
    writeFileSync(path, JSON.stringify({ pid: 0, start: null, nonce: 'e'.repeat(32), createdAt: new Date().toISOString() }));
    expect((await readLockOwner(path)).ok).toBe(false);
  });
});
