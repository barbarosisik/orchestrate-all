/**
 * Telling one process from another (step 12). A process id alone names a process only while it runs: once it has
 * ended, the system may give its id to any new process. So a process Orchestra records (a worker, the conductor
 * holding its lock) is recorded with the system's own note of when it started, and a later check counts it as the
 * same process only when both the id and that start time match.
 *
 * - Linux: `/proc/<pid>/stat` (start time in clock ticks since boot) plus the boot id, so a process after a restart
 *   of the machine is never taken for one before it.
 * - macOS: `/bin/ps` (the start time to the second), started like every other process Orchestra starts.
 * - Windows: the process's creation time (GetProcessTimes, through koffi, as the Job Objects are). Without koffi,
 *   only whether the id is in use is known, and the start time is null.
 *
 * Nothing here ever acts on an id it could not just check: stopVerifiedProcess stops a process only when it is
 * running now with the recorded start time and, when asked, works in the folder it was started in (a worker in its
 * task's worktree). The second check matters because the record itself can be forged: until workers are sandboxed a
 * worker can rewrite the run folder, and name another process of the user's, start time included. On Windows it never
 * stops anything: every process Orchestra starts there is in a Job Object that Windows stops when Orchestra ends, also
 * when it crashes.
 */

import { readFile, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { launchCommand } from '../accept/run.js';
import { canonicalPath, isInsidePath } from '../repo/canonical.js';

export interface ProcessIdentity {
  readonly pid: number;
  /** The system's note of when the process started, compared as text; null when it could not be read. */
  readonly start: string | null;
}

export type ProcessLookup =
  | { readonly state: 'gone' }
  | {
      readonly state: 'running';
      readonly start: string | null;
      /** Whether it leads its own process group (Linux and macOS); null on Windows or when unknown. */
      readonly groupLeader: boolean | null;
    };

const GONE: ProcessLookup = { state: 'gone' };
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const PS_TIMEOUT_MS = 10_000;
/** Lines longer than this are not stat or ps lines. */
const MAX_LINE = 64 * 1024;

function validPid(pid: number): boolean {
  // Never 0 or less (0 and negative ids name process groups), never more than any system hands out.
  return Number.isSafeInteger(pid) && pid > 0 && pid < 2 ** 32;
}

// ---------------------------------------------------------------------------------------------------------
// Linux

/**
 * Reads `/proc/<pid>/stat`. The command name (field 2) is in parentheses and may hold anything, also ") (", so the
 * fields are read after the last ")". Linear time; null for text that is not such a line.
 */
export function parseProcStat(text: string, pid: number): { zombie: boolean; groupLeader: boolean; startTicks: string } | null {
  if (text.length === 0 || text.length > MAX_LINE) return null;
  const close = text.lastIndexOf(')');
  if (close === -1 || !text.slice(0, close).includes('(')) return null;
  const fields = text.slice(close + 1).trim().split(' ');
  // Field 3 (state) is fields[0], field 5 (process group) fields[2], field 22 (start time) fields[19].
  const state = fields[0];
  const group = fields[2];
  const start = fields[19];
  if (state === undefined || group === undefined || start === undefined) return null;
  if (!/^\d+$/.test(group) || !/^\d+$/.test(start)) return null;
  return { zombie: state === 'Z' || state === 'X', groupLeader: Number(group) === pid, startTicks: start };
}

let bootId: Promise<string> | null = null;

function linuxBootId(): Promise<string> {
  bootId ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
    (text) => text.trim().slice(0, 64),
    () => 'unknown-boot',
  );
  return bootId;
}

async function lookupLinux(pid: number): Promise<ProcessLookup> {
  let text: string;
  try {
    text = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return GONE;
  }
  const parsed = parseProcStat(text.trimEnd(), pid);
  if (parsed === null) return { state: 'running', start: null, groupLeader: null };
  if (parsed.zombie) return GONE;
  return { state: 'running', start: `${await linuxBootId()}:${parsed.startTicks}`, groupLeader: parsed.groupLeader };
}

// ---------------------------------------------------------------------------------------------------------
// macOS (and other systems with ps)

/** Reads `ps -o stat=,pgid=,lstart=` for one process: state, group, start time. Null for anything else. */
export function parsePsLine(text: string, pid: number): { zombie: boolean; groupLeader: boolean; start: string } | null {
  if (text.length > MAX_LINE) return null;
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return null;
  const parts = (lines[0] as string).trim().split(/ +/);
  const [state, group, ...start] = parts;
  if (state === undefined || group === undefined || !/^\d+$/.test(group) || start.length < 2) return null;
  return { zombie: state.startsWith('Z'), groupLeader: Number(group) === pid, start: start.join(' ') };
}

async function lookupPs(pid: number): Promise<ProcessLookup> {
  const argv = [PS, '-o', 'stat=,pgid=,lstart=', '-p', String(pid)];
  // A fixed environment, so the start time always reads the same way.
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };
  const result = await launchCommand(argv, { program: PS, args: argv.slice(1), windowsVerbatimArguments: false }, '/', env, PS_TIMEOUT_MS, MAX_LINE);
  if (result.status === 'not-started' || result.status === 'timed-out') return { state: 'running', start: null, groupLeader: null };
  // ps exits with 1 and prints nothing for an id no process has; anything else (stopped by a signal) is not known.
  if (result.exitCode === 1 && result.signal === null && result.stdout.text.trim().length === 0) return GONE;
  if (result.exitCode !== 0) return { state: 'running', start: null, groupLeader: null };
  const parsed = parsePsLine(result.stdout.text, pid);
  if (parsed === null) return { state: 'running', start: null, groupLeader: null };
  if (parsed.zombie) return GONE;
  return { state: 'running', start: parsed.start, groupLeader: parsed.groupLeader };
}

// ---------------------------------------------------------------------------------------------------------
// Windows

interface WinApi {
  OpenProcess(access: number, inherit: number, pid: number): unknown;
  GetProcessTimes(handle: unknown, creation: unknown[], exit: unknown[], kernel: unknown[], user: unknown[]): number;
  GetExitCodeProcess(handle: unknown, code: unknown[]): number;
  CloseHandle(handle: unknown): number;
  GetLastError(): number;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
const ERROR_INVALID_PARAMETER = 87;

let winApi: WinApi | null | undefined;

function loadWinApi(): WinApi | null {
  if (winApi !== undefined) return winApi;
  try {
    const koffi = createRequire(import.meta.url)('koffi') as { load(path: string): { func(definition: string): unknown } };
    const lib = koffi.load('kernel32.dll');
    winApi = {
      OpenProcess: lib.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      GetProcessTimes: lib.func(
        'int __stdcall GetProcessTimes(void *process, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)',
      ),
      GetExitCodeProcess: lib.func('int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *code)'),
      CloseHandle: lib.func('int __stdcall CloseHandle(void *handle)'),
      GetLastError: lib.func('uint32_t __stdcall GetLastError()'),
    } as unknown as WinApi;
  } catch {
    winApi = null;
  }
  return winApi;
}

function isNull(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0n || handle === 0;
}

/** Without koffi: whether the id is in use (Node asks Windows), with no start time. */
function lookupByKill(pid: number): ProcessLookup {
  try {
    process.kill(pid, 0);
    return { state: 'running', start: null, groupLeader: null };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? { state: 'running', start: null, groupLeader: null } : GONE;
  }
}

function lookupWindows(pid: number): ProcessLookup {
  const api = loadWinApi();
  if (api === null) return lookupByKill(pid);
  try {
    const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (isNull(handle)) {
      // No such process; anything else (access denied) means some process has this id.
      return api.GetLastError() === ERROR_INVALID_PARAMETER ? GONE : { state: 'running', start: null, groupLeader: null };
    }
    try {
      const code: unknown[] = [0];
      if (api.GetExitCodeProcess(handle, code) !== 0 && Number(code[0]) !== STILL_ACTIVE) return GONE;
      const creation: unknown[] = [0];
      const unused: unknown[][] = [[0], [0], [0]];
      const ok = api.GetProcessTimes(handle, creation, unused[0] as unknown[], unused[1] as unknown[], unused[2] as unknown[]) !== 0;
      return { state: 'running', start: ok ? String(creation[0]) : null, groupLeader: null };
    } finally {
      api.CloseHandle(handle);
    }
  } catch {
    return lookupByKill(pid);
  }
}

// ---------------------------------------------------------------------------------------------------------

/** Whether process `pid` runs now and, if so, when it started. Never throws; never looks up 0 or a negative id. */
export async function lookupProcess(pid: number): Promise<ProcessLookup> {
  if (!validPid(pid)) return GONE;
  if (process.platform === 'win32') return lookupWindows(pid);
  if (process.platform === 'linux') return lookupLinux(pid);
  return lookupPs(pid);
}

/** The identity to record for process `pid`, which runs now; null when it is already gone. */
export async function identifyProcess(pid: number): Promise<ProcessIdentity | null> {
  const found = await lookupProcess(pid);
  return found.state === 'running' ? { pid, start: found.start } : null;
}

/**
 * Whether what was found now is the recorded process: "same" only when both start times are known and equal;
 * "other" when they differ (the id was reused); "unknown" when either is missing.
 */
export function sameProcess(recorded: ProcessIdentity | null, found: ProcessLookup): 'same' | 'other' | 'gone' | 'unknown' {
  if (found.state === 'gone') return 'gone';
  if (recorded === null || recorded.start === null || found.start === null) return 'unknown';
  return recorded.start === found.start ? 'same' : 'other';
}

/** The folder process `pid` works in (Linux: /proc; macOS: lsof), or null when it can't be read (and on Windows). */
export async function processFolder(pid: number): Promise<string | null> {
  if (!validPid(pid) || process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      return (await readlink(`/proc/${pid}/cwd`)).replace(/ \(deleted\)$/, '');
    } catch {
      return null;
    }
  }
  const argv = [LSOF, '-a', '-p', String(pid), '-d', 'cwd', '-Fn'];
  const env = { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' };
  const result = await launchCommand(argv, { program: LSOF, args: argv.slice(1), windowsVerbatimArguments: false }, '/', env, PS_TIMEOUT_MS, MAX_LINE);
  if (result.status !== 'passed') return null;
  const line = result.stdout.text.split('\n').find((l) => l.startsWith('n'));
  return line === undefined || line.length < 2 ? null : line.slice(1);
}

export interface StopOptions {
  /** Stop it only when the folder it works in is this one or inside it (a worker's worktree). */
  readonly insideFolder?: string;
  readonly caseInsensitive?: boolean;
}

/**
 * - stopped: it was the recorded process, working where expected, and it was stopped;
 * - gone: no process has the id now;
 * - not-ours: the id now names a process that started at another time (the id was reused);
 * - elsewhere: the recorded process still runs, but not in the expected folder (a forged record, or it moved): left alone;
 * - unverified: it could not be told whether it is the recorded process: left alone;
 * - still-running: it is the recorded process and it could not be stopped (on Windows: never tried, see below).
 */
export type StopOutcome = 'stopped' | 'gone' | 'not-ours' | 'elsewhere' | 'unverified' | 'still-running';

/**
 * Stops a recorded process (and its process group, when it still leads one) only after checking, just now, that it
 * is that process. Windows: never stops anything: Orchestra's Job Objects stop every process it started when it ends,
 * so the recorded process is normally gone; if it still runs, something kept its job alive, and it is reported as
 * "still-running". Never throws.
 */
export async function stopVerifiedProcess(recorded: ProcessIdentity | null, opts: StopOptions = {}): Promise<StopOutcome> {
  if (recorded === null || !validPid(recorded.pid)) return 'unverified';
  const found = await lookupProcess(recorded.pid);
  const same = sameProcess(recorded, found);
  if (same === 'gone') return 'gone';
  if (same === 'unknown') return 'unverified';
  if (same === 'other' || found.state !== 'running') return 'not-ours';
  if (process.platform === 'win32') return 'still-running';
  if (opts.insideFolder !== undefined) {
    const folder = await processFolder(recorded.pid);
    if (folder === null) return 'unverified';
    const where = canonicalPath(folder) ?? folder;
    const expected = canonicalPath(opts.insideFolder) ?? opts.insideFolder;
    if (!isInsidePath(where, expected, opts.caseInsensitive ?? process.platform === 'darwin')) return 'elsewhere';
  }
  try {
    // A negative id names the process group, which it leads: everything it started that stayed in its group.
    process.kill(found.groupLeader === true ? -recorded.pid : recorded.pid, 'SIGKILL');
  } catch {
    // It ended in the meantime.
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (sameProcess(recorded, await lookupProcess(recorded.pid)) !== 'same') return 'stopped';
    await delay(50);
  }
  return 'still-running';
}
