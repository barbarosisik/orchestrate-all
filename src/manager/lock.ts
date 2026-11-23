/**
 * The conductor's lock (step 12): one process at a time drives the runs of an Orchestra home, so every run has
 * exactly one writer. The run store already refuses to open a run twice in one process; this lock covers other
 * processes. The background service (12b) takes it when it starts and holds it for its whole life, which also
 * makes it the one instance per home.
 *
 * The lock is a small file naming its holder: process id, the system's start time of that process
 * (os/process-identity.ts) and a random nonce.
 * - Taking it: the holder's file is written under a temporary name and hard-linked into place, which fails when a
 *   lock is already there, so a reader never sees a half-written lock.
 * - A lock is live while its holder runs: same id and same start time. It is stale when that process has ended, or
 *   when its id now names a process that started at another time. When either start time is unknown, the lock is
 *   treated as live: a lock that might still be held is never taken. A damaged lock counts as being written while it
 *   is new, and as stale once it is a minute old.
 * - Replacing a stale lock: only the holder of a second, short-lived file (`<lock>.takeover`, taken the same way)
 *   may remove a stale lock, and it reads the lock again first: so a lock another process has just taken is never
 *   removed. The stale lock is renamed aside and read back; if it was not the stale one after all, it goes back. Then
 *   every taker tries again from the start. A takeover file left by a process that ended is itself stale and is
 *   moved aside the same way.
 * - stillHeld() lets the holder check that the file still names it (the service checks it regularly and stops if
 *   not); release() removes the file only while it names the holder.
 *
 * Known limit: if a taker ends while holding the takeover file and two others then race to remove that file, both
 * may go on to remove the stale lock; stillHeld() catches a lock lost that way within one check.
 */

import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { identifyProcess, lookupProcess, sameProcess } from '../os/process-identity.js';
import { ensureRealFolder, withRetry } from '../store/files.js';

const LockOwnerSchema = z
  .object({
    pid: z.number().int().positive().max(2 ** 32 - 1),
    start: z.string().min(1).max(200).nullable(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type LockOwner = z.infer<typeof LockOwnerSchema>;

const MAX_LOCK_BYTES = 4096;
/** A damaged lock younger than this may still be being written; older, it is stale. */
const DAMAGED_GRACE_MS = 60_000;
const ATTEMPTS = 60;
/** Wait between attempts while another process replaces a stale lock. */
const DEFAULT_RETRY_MS = 25;

export type LockFailureCode = 'busy' | 'link' | 'io';

export type LockResult =
  | { readonly ok: true; readonly lock: HeldLock }
  | { readonly ok: false; readonly code: LockFailureCode; readonly message: string; readonly owner?: LockOwner };

type ReadOwner =
  | { readonly ok: true; readonly owner: LockOwner }
  | { readonly ok: false; readonly code: 'missing' | 'link' | 'invalid'; readonly ageMs?: number };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a lock file: never through a link, never more than a few KiB. */
export async function readLockOwner(path: string): Promise<ReadOwner> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { ok: false, code: 'missing' } : { ok: false, code: 'invalid' };
  }
  if (info.isSymbolicLink()) return { ok: false, code: 'link' };
  const ageMs = Date.now() - info.mtimeMs;
  if (!info.isFile() || info.size > MAX_LOCK_BYTES) return { ok: false, code: 'invalid', ageMs };
  try {
    const parsed = LockOwnerSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? { ok: true, owner: parsed.data } : { ok: false, code: 'invalid', ageMs };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { ok: false, code: 'missing' } : { ok: false, code: 'invalid', ageMs };
  }
}

/** A lock this process holds. */
export class HeldLock {
  private released = false;

  /** @internal Use acquireLock. */
  constructor(
    readonly path: string,
    readonly owner: LockOwner,
    /** What was cleaned up on the way (a stale lock replaced). */
    readonly notes: readonly string[],
  ) {}

  /** Whether the lock file still names this holder. */
  async stillHeld(): Promise<boolean> {
    if (this.released) return false;
    const found = await readLockOwner(this.path);
    return found.ok && found.owner.nonce === this.owner.nonce;
  }

  /** Removes the lock file, only while it still names this holder. Never throws. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const found = await readLockOwner(this.path);
    if (found.ok && found.owner.nonce === this.owner.nonce) await withRetry(() => unlink(this.path)).catch(() => undefined);
  }
}

function busy(path: string, owner: LockOwner | undefined, why: string): LockResult {
  const who = owner === undefined ? '' : ` (process ${owner.pid}, since ${owner.createdAt})`;
  return {
    ok: false,
    code: 'busy',
    message: `Another Orchestra process holds ${path}${who}: ${why} If you are sure none runs, delete that file.`,
    ...(owner === undefined ? {} : { owner }),
  };
}

/** Puts `content` at `path` only if nothing is there: written aside, then hard-linked, so it is never seen half-written. */
async function createExclusive(path: string, content: string, nonce: string, attempt: number): Promise<'created' | 'exists'> {
  const temp = join(dirname(path), `.${basename(path)}.${nonce}.${attempt}.tmp`);
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    await link(temp, path);
    return 'created';
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return 'exists';
    // A file system without hard links: create the file itself, exclusively (a reader may see it empty for a moment,
    // which counts as being written).
    if (['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(errorCode(error) ?? '')) {
      try {
        await writeFile(path, content, { flag: 'wx', mode: 0o600 });
        return 'created';
      } catch (inner) {
        if (errorCode(inner) === 'EEXIST') return 'exists';
        throw inner;
      }
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Exported for tests. Moves the stale lock `stale` (as read) out of the way. If what was moved turns out to be another lock (it was
 * replaced in between), it is put back. Returns whether the stale lock was removed.
 */
export async function removeStale(path: string, stale: LockOwner | null, nonce: string, attempt: number): Promise<boolean> {
  const aside = join(dirname(path), `.${basename(path)}.stale.${nonce}.${attempt}`);
  try {
    // Windows may refuse for a moment while another process reads the file.
    await withRetry(() => rename(path, aside));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  const moved = await readLockOwner(aside);
  const same = stale === null ? !moved.ok : moved.ok && moved.owner.nonce === stale.nonce;
  if (!same) await link(aside, path).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
  return same;
}

export interface LockOptions {
  /** Time between attempts while another process replaces a stale lock. */
  readonly retryDelayMs?: number;
}

type Staleness = { readonly state: 'live'; readonly owner?: LockOwner; readonly why: string } | { readonly state: 'stale'; readonly owner: LockOwner | null } | { readonly state: 'missing' };

/** Whether the lock (or takeover) file at `path` is held by a running process. */
async function staleness(path: string): Promise<Staleness | { readonly state: 'link' }> {
  const found = await readLockOwner(path);
  if (!found.ok) {
    if (found.code === 'missing') return { state: 'missing' };
    if (found.code === 'link') return { state: 'link' };
    if ((found.ageMs ?? 0) < DAMAGED_GRACE_MS) return { state: 'live', why: 'it is being written, or damaged (it is replaced once it is a minute old).' };
    return { state: 'stale', owner: null };
  }
  const owner = found.owner;
  const same = sameProcess(owner, await lookupProcess(owner.pid));
  if (same === 'same') return { state: 'live', owner, why: 'it is running.' };
  if (same === 'unknown') return { state: 'live', owner, why: 'it may still be running (its start time could not be compared).' };
  return { state: 'stale', owner };
}

function sameStale(a: LockOwner | null, b: Staleness | { readonly state: 'link' }): boolean {
  if (b.state !== 'stale') return false;
  return a === null ? b.owner === null : b.owner !== null && b.owner.nonce === a.nonce;
}

/**
 * Removes the stale lock `stale` (as read), holding the takeover file while doing so. Returns "removed", "retry" (the
 * lock changed, or a stale takeover file was cleared) or "wait" (another process is replacing it now).
 */
async function replaceStale(path: string, stale: LockOwner | null, content: string, nonce: string, attempt: number): Promise<'removed' | 'retry' | 'wait'> {
  const takeover = `${path}.takeover`;
  if ((await createExclusive(takeover, content, nonce, attempt)) === 'exists') {
    const other = await staleness(takeover);
    if (other.state === 'link') throw new Error(`${takeover} is a link.`);
    if (other.state === 'stale') {
      await removeStale(takeover, other.owner, nonce, attempt);
      return 'retry';
    }
    return other.state === 'missing' ? 'retry' : 'wait';
  }
  try {
    // Holding the takeover file: no one else removes the lock now. Is it still the stale one that was read?
    if (!sameStale(stale, await staleness(path))) return 'retry';
    return (await removeStale(path, stale, nonce, attempt)) ? 'removed' : 'retry';
  } finally {
    const mine = await readLockOwner(takeover);
    if (mine.ok && mine.owner.nonce === nonce) await unlink(takeover).catch(() => undefined);
  }
}

/** Takes the lock at `path` for this process. Its folder must be a real folder (it is created if missing). */
export async function acquireLock(path: string, opts: LockOptions = {}): Promise<LockResult> {
  const folder = dirname(path);
  try {
    await mkdir(dirname(folder), { recursive: true });
  } catch (error) {
    return { ok: false, code: 'io', message: `Could not create ${dirname(folder)}: ${errorText(error)}` };
  }
  const problem = await ensureRealFolder(folder);
  if (problem !== null) return { ok: false, code: problem.code === 'link' ? 'link' : 'io', message: problem.message };

  const nonce = randomBytes(16).toString('hex');
  const me: LockOwner = { pid: process.pid, start: (await identifyProcess(process.pid))?.start ?? null, nonce, createdAt: new Date().toISOString() };
  const content = `${JSON.stringify(me)}\n`;
  const notes: string[] = [];
  const retryMs = opts.retryDelayMs ?? DEFAULT_RETRY_MS;
  const why = 'another process is replacing a stale lock.';
  let lastOwner: LockOwner | undefined;
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if ((await createExclusive(path, content, nonce, attempt)) === 'created') return { ok: true, lock: new HeldLock(path, me, notes) };
      const found = await staleness(path);
      if (found.state === 'missing') continue;
      if (found.state === 'link') return { ok: false, code: 'link', message: `${path} is a link. Orchestra never uses a lock through a link; remove it.` };
      if (found.state === 'live') return busy(path, found.owner, found.why);
      lastOwner = found.owner ?? undefined;
      const replaced = await replaceStale(path, found.owner, content, nonce, attempt);
      if (replaced === 'removed') {
        notes.push(
          found.owner === null
            ? `Replaced a damaged lock at ${path}.`
            : `Replaced a lock at ${path} left by a process that has ended (process ${found.owner.pid}).`,
        );
      } else if (replaced === 'wait') {
        await new Promise((done) => setTimeout(done, retryMs));
      }
    }
  } catch (error) {
    return { ok: false, code: 'io', message: `Could not take the lock ${path}: ${errorText(error)}` };
  }
  return busy(path, lastOwner, why);
}
