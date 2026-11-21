/**
 * Safe file operations for the run store (step 9). Everything under `<home>/runs` is Orchestra's own, but
 * until workers are sandboxed (step 10) a worker runs with the user's rights and could plant links there,
 * swap files, or fill them with garbage. So:
 *
 * - Folders must be real folders: lstat, never a symlink or a Windows junction (store/layout.ts checks every
 *   folder from `<home>/runs` down before each write).
 * - Writes are atomic. A temporary file is created in the same folder (exclusively, so never through a
 *   link), written and fsynced, then renamed over the target. A crash leaves the old file or the new one,
 *   plus at most a stray temporary file, which readers never open and cleanup removes. On Windows the rename
 *   is retried briefly while another program (antivirus, an indexer) holds the file.
 * - Appends open the file without following a link (O_NOFOLLOW where the system has it), check that the file
 *   they opened is the one they inspected (same device and inode), and refuse a file with a second name (a
 *   hard link): an append must never land in somebody else's file.
 * - Reads refuse links and anything that isn't a regular file, and never load more than a stated size. Named
 *   pipes are refused before opening, and opened non-blocking, so a read can't hang.
 * - Removal never follows a link: a link is removed itself, never what it points to. Before listing a folder
 *   it checks that the folder is still where it should be (no link swapped into the path).
 * - Files are created readable by the user only (on Linux and macOS; Windows keeps its own access rules).
 *
 * Not covered: a process racing these checks, for example swapping a folder for a link between a check and
 * the write. Node has no `openat`, so only the worker sandbox of step 10 closes that gap.
 */

import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalPath, DEFAULT_CASE_INSENSITIVE, samePath } from '../repo/canonical.js';

export type FileProblemCode = 'missing' | 'link' | 'not-a-folder' | 'not-a-file' | 'too-large' | 'io';

export interface FileProblem {
  readonly code: FileProblemCode;
  readonly message: string;
}

export type FileResult<T = undefined> = { ok: true; value: T } | { ok: false; problem: FileProblem };

export interface RetryOptions {
  /** Extra attempts after the first. */
  readonly attempts?: number;
  /** Wait before the first retry; each later retry waits one step longer. */
  readonly delayMs?: number;
}

/** About 2.75 s in all: antivirus on Windows can hold a freshly written file for a while. */
const DEFAULT_RETRY = { attempts: 10, delayMs: 50 } as const;
/** Undefined on Windows, where lstat before opening has to do. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** Opening a named pipe without it waits for a writer forever. Not used on Windows. */
const NON_BLOCK = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;
const READ_CHUNK = 64 * 1024;
const TEMP_NAME = /^\..+\.[0-9a-f]{12}\.tmp$/;

function fail<T>(code: FileProblemCode, message: string): FileResult<T> {
  return { ok: false, problem: { code, message } };
}

const done: FileResult = { ok: true, value: undefined };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a failed file operation is worth retrying: on Windows a file another program holds open fails with
 * EPERM, EACCES or EBUSY; elsewhere those first two are real permission errors.
 */
export function isRetryable(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = errorCode(error);
  if (code === 'EBUSY') return true;
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}

export async function withRetry<T>(action: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_RETRY.attempts;
  const delayMs = opts.delayMs ?? DEFAULT_RETRY.delayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await delay(delayMs * (attempt + 1));
    }
  }
}

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null;
    throw error;
  }
}

/** Why `info` (from lstat) is not a regular file Orchestra may use, or null. */
function fileKindProblem(path: string, info: BigIntStats): FileProblem | null {
  if (info.isSymbolicLink()) {
    return { code: 'link', message: `${path} is a link, not a file. Orchestra never reads or writes through a link.` };
  }
  if (!info.isFile()) return { code: 'not-a-file', message: `${path} is not a regular file.` };
  return null;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Why `path` is not a real folder (code "missing" when there is nothing there), or null. */
export async function folderProblem(path: string): Promise<FileProblem | null> {
  let info: BigIntStats | null;
  try {
    info = await lstatOrNull(path);
  } catch (error) {
    return { code: 'io', message: `Could not inspect ${path}: ${errorText(error)}` };
  }
  if (info === null) return { code: 'missing', message: `${path} does not exist.` };
  if (info.isSymbolicLink()) {
    return {
      code: 'link',
      message: `${path} is a link, not a real folder. Orchestra never writes or deletes through a link; check where it came from, then remove it.`,
    };
  }
  if (!info.isDirectory()) return { code: 'not-a-folder', message: `${path} is not a folder.` };
  return null;
}

/** Creates `path` if needed (its parent must exist), then checks that it is a real folder. */
export async function ensureRealFolder(path: string): Promise<FileProblem | null> {
  try {
    await mkdir(path, { mode: FOLDER_MODE });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') return { code: 'io', message: `Could not create ${path}: ${errorText(error)}` };
  }
  return folderProblem(path);
}

/** A temporary file name next to `name`: `.<name>.<12 hex digits>.tmp`. */
export function tempName(name: string): string {
  return `.${name}.${randomBytes(6).toString('hex')}.tmp`;
}

export function isTempName(name: string): boolean {
  return TEMP_NAME.test(name);
}

async function removeQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** Makes a rename durable on Linux and macOS (Windows can't open a folder for this). */
export async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(folder, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Durability of the folder entry is best effort; the file itself was fsynced.
  } finally {
    await handle?.close();
  }
}

export interface AtomicWriteOptions {
  /** Refuse data larger than this. */
  readonly maxBytes?: number;
  readonly retry?: RetryOptions;
  /** Replaces fs.rename (tests use it to simulate a failure or a crash between the write and the rename). */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

/** Writes `data` to `path` atomically: a temporary file in the same folder, fsynced, then renamed over it. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<FileResult> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) {
    return fail('too-large', `${basename(path)} would be ${bytes.length} bytes, over the limit of ${opts.maxBytes}.`);
  }
  try {
    const existing = await lstatOrNull(path);
    const problem = existing === null ? null : fileKindProblem(path, existing);
    if (problem !== null) return { ok: false, problem };
  } catch (error) {
    return fail('io', `Could not inspect ${path}: ${errorText(error)}`);
  }

  const temp = join(dirname(path), tempName(basename(path)));
  let handle: FileHandle | undefined;
  try {
    // O_EXCL: never opens an existing file or a link planted under this name.
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await withRetry(() => (opts.rename ?? rename)(temp, path), opts.retry);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await removeQuietly(temp);
    return fail('io', `Could not write ${path}: ${errorText(error)}`);
  }
  await syncFolder(dirname(path));
  return done;
}

export interface ReadOptions {
  readonly retry?: RetryOptions;
}

/** Reads a regular file of at most `maxBytes`. Links, folders, pipes and larger files are refused. */
export async function readFileCapped(path: string, maxBytes: number, opts: ReadOptions = {}): Promise<FileResult<Buffer>> {
  let info: BigIntStats | null;
  try {
    info = await lstatOrNull(path);
  } catch (error) {
    return fail('io', `Could not inspect ${path}: ${errorText(error)}`);
  }
  if (info === null) return fail('missing', `${path} does not exist.`);
  const kind = fileKindProblem(path, info);
  if (kind !== null) return { ok: false, problem: kind };
  if (info.size > BigInt(maxBytes)) return fail('too-large', `${path} is ${info.size} bytes, over the limit of ${maxBytes}.`);

  let handle: FileHandle;
  try {
    handle = await withRetry(() => open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK), opts.retry);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') return fail('link', `${path} became a link while it was being read.`);
    return fail('io', `Could not open ${path}: ${errorText(error)}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(opened, info)) return fail('link', `${path} was replaced while it was being read.`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return fail('too-large', `${path} grew past the limit of ${maxBytes} bytes while it was being read.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { ok: true, value: Buffer.concat(chunks, total) };
  } catch (error) {
    return fail('io', `Could not read ${path}: ${errorText(error)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface AppendOptions {
  /** Create the file if it doesn't exist (exclusively). Otherwise a missing file is a problem. */
  readonly create?: boolean;
  /** fsync after writing. */
  readonly sync?: boolean;
  readonly retry?: RetryOptions;
}

/** Appends to a regular file with exactly one name, never through a link. */
export async function appendFileSafe(path: string, data: string | Uint8Array, opts: AppendOptions = {}): Promise<FileResult> {
  let info: BigIntStats | null;
  try {
    info = await lstatOrNull(path);
  } catch (error) {
    return fail('io', `Could not inspect ${path}: ${errorText(error)}`);
  }
  if (info === null && opts.create !== true) return fail('missing', `${path} does not exist.`);
  if (info !== null) {
    const kind = fileKindProblem(path, info);
    if (kind !== null) return { ok: false, problem: kind };
    if (info.nlink > 1n) {
      return fail('link', `${path} has another name (a hard link), so writing to it could change another file. Orchestra stopped.`);
    }
  }

  const flags =
    info === null
      ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW
      : constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW | NON_BLOCK;
  let handle: FileHandle;
  try {
    handle = await withRetry(() => open(path, flags, FILE_MODE), opts.retry);
  } catch (error) {
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'EEXIST') {
      return fail('link', `${path} was replaced while Orchestra was about to write to it.`);
    }
    return fail('io', `Could not open ${path}: ${errorText(error)}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink > 1n || (info !== null && !sameFile(opened, info))) {
      return fail('link', `${path} was replaced while Orchestra was about to write to it.`);
    }
    // writeFile keeps writing until every byte is written (a single write may write fewer).
    await handle.writeFile(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    if (opts.sync === true) await handle.sync();
    return done;
  } catch (error) {
    return fail('io', `Could not write ${path}: ${errorText(error)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Removes a link itself. A Windows junction may need rmdir rather than unlink. */
async function removeLink(path: string, opts: RetryOptions): Promise<void> {
  try {
    await withRetry(() => unlink(path), opts);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await withRetry(() => rmdir(path), opts);
  }
}

async function removeEntry(path: string, expected: string, opts: RetryOptions): Promise<void> {
  const info = await lstatOrNull(path);
  if (info === null) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    if (info.isSymbolicLink()) await removeLink(path, opts);
    else await withRetry(() => unlink(path), opts);
    return;
  }
  // Listing follows links in the path, so first make sure no folder on the way was swapped for one.
  const real = canonicalPath(path);
  if (real === null || !samePath(real, expected, DEFAULT_CASE_INSENSITIVE)) {
    throw new Error(`${path} moved while it was being deleted (it now leads to ${real ?? 'nothing'}); stopped.`);
  }
  for (const name of await readdir(path)) await removeEntry(join(path, name), join(expected, name), opts);
  await withRetry(() => rmdir(path), opts);
}

export interface RemoveOptions {
  /**
   * Where the tree really is (a canonical path) as the caller checked it. Removal stops if the path now
   * leads anywhere else, for example because a folder on the way was swapped for a link since the check.
   */
  readonly expected?: string;
  readonly retry?: RetryOptions;
}

/**
 * Deletes a file or folder tree without ever following a link: a link (symlink or junction) is removed
 * itself, never what it points to. Nothing there is not an error. Throws when something can't be removed.
 */
export async function removeTree(path: string, opts: RemoveOptions = {}): Promise<void> {
  const info = await lstatOrNull(path);
  if (info === null) return;
  const retry = opts.retry ?? {};
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await removeEntry(path, path, retry);
    return;
  }
  const expected = opts.expected ?? canonicalPath(path);
  if (expected === null) return;
  await removeEntry(path, expected, retry);
}

/** Removes leftover temporary files and folders (from an interrupted write or run creation) in `folder`. */
export async function removeTempEntries(folder: string): Promise<{ removed: number; problems: string[] }> {
  const problems: string[] = [];
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    return { removed, problems: [`Could not list ${folder}: ${errorText(error)}`] };
  }
  const real = canonicalPath(folder) ?? folder;
  for (const name of names.filter(isTempName)) {
    try {
      await removeTree(join(folder, name), { expected: join(real, name) });
      removed += 1;
    } catch (error) {
      problems.push(`Could not remove the leftover temporary file ${join(folder, name)}: ${errorText(error)}`);
    }
  }
  return { removed, problems };
}
