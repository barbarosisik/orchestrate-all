/**
 * Windows Job Objects (step 10, part 2). Every process Orchestra starts on Windows (a worker, an acceptance
 * command, a detection probe) goes into a job of its own, with everything it starts, so all of it can be stopped
 * at once: also processes whose parent already exited, which `taskkill /t` no longer finds in the tree.
 *
 * - KILL_ON_JOB_CLOSE: closing the job's last handle stops every process in it, so when Orchestra stops, or
 *   crashes, nothing it started is left behind.
 * - No breakaway is allowed. Node puts the children it starts (unless detached) in one job of its own, which stops
 *   them when Node exits and lets their own children leave it silently. A job given to a process that is already in
 *   one is nested inside it, so Orchestra's job is the innermost one of the process it starts, and a child that
 *   would leave a job leaves only up to the first one that doesn't allow it (Microsoft's "Nested Jobs"): Orchestra's
 *   job keeps everything the process starts, even through the jobs of Node programs it runs.
 * - DIE_ON_UNHANDLED_EXCEPTION: a process that crashes ends instead of waiting on an error dialog no one sees.
 * - Node can't start a process suspended. So the job is made before the start (process-tree.ts), and only putting
 *   the process in it is left for after: a few microseconds, while Windows is still starting the program, long
 *   before a worker's code (a test file the program loads) can run.
 *
 * It cleans up; it is not a wall. A process in the job that tries to get out can: through Windows itself (WMI, Task
 * Scheduler, a COM server, a file opened through Explorer start processes outside it), by naming another process as
 * its parent, or by taking the job's handle from Orchestra's process (same user) and changing its limits. Only a
 * sandbox around the worker closes that, and Windows has none in Orchestra for now (docs/HANDOFF.md).
 *
 * The Windows calls go through koffi, an FFI library (the owner allowed it for this), loaded only on Windows and
 * only when a job is first needed.
 */

import { createRequire } from 'node:module';

/** A job holding processes. */
export interface ProcessJob {
  /** Puts process `pid` (and so everything it starts from now on) in the job: null, or why it failed. */
  add(pid: number): string | null;
  /** Stops every process in the job: null, or why it failed. Never throws. */
  terminate(): string | null;
  /** Frees the job, which stops any process still in it. Safe to call more than once. Never throws. */
  close(): void;
}

export type JobResult = { readonly ok: true; readonly job: ProcessJob } | { readonly ok: false; readonly error: string };

/** The exit code given to processes the job stops (what `taskkill /f` gives too). */
export const STOPPED_EXIT_CODE = 1;

// Values from the Windows SDK (winnt.h, jobapi2.h).
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION): a different size means the layout below is wrong here. */
const EXPECTED_INFO_SIZE: Readonly<Record<string, number>> = { x64: 144, arm64: 144, ia32: 112 };

/** What Orchestra uses of kernel32. Handles are koffi pointers (bigint), or null for NULL. */
interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): unknown;
  SetInformationJobObject(job: unknown, infoClass: number, info: object, size: number): number;
  OpenProcess(access: number, inherit: number, pid: number): unknown;
  AssignProcessToJobObject(job: unknown, process: unknown): number;
  TerminateJobObject(job: unknown, exitCode: number): number;
  CloseHandle(handle: unknown): number;
  GetLastError(): number;
}

interface Loaded {
  readonly kernel32: Kernel32;
  readonly infoSize: number;
}

type LoadResult = { readonly ok: true; readonly value: Loaded } | { readonly ok: false; readonly error: string };

/** The part of koffi used here (typed locally: koffi is an optional dependency). */
interface Koffi {
  load(path: string): {
    func(definition: string): (...args: unknown[]) => unknown;
    func(convention: string, name: string, result: unknown, args: readonly unknown[]): (...args: unknown[]) => unknown;
  };
  struct(members: Record<string, unknown>): unknown;
  pointer(type: unknown): unknown;
  sizeof(type: unknown): number;
}

let loaded: LoadResult | null = null;

function isNull(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0n || handle === 0;
}

function load(): LoadResult {
  if (loaded !== null) return loaded;
  try {
    // koffi is CommonJS; requiring it here keeps its native code out of every other platform and code path.
    const koffi = createRequire(import.meta.url)('koffi') as Koffi;
    // Types without names: koffi refuses a name declared twice, which loading this module twice would do.
    const basic = koffi.struct({ // JOBOBJECT_BASIC_LIMIT_INFORMATION
      PerProcessUserTimeLimit: 'int64',
      PerJobUserTimeLimit: 'int64',
      LimitFlags: 'uint32',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32',
      Affinity: 'uintptr_t',
      PriorityClass: 'uint32',
      SchedulingClass: 'uint32',
    });
    const io = koffi.struct({ // IO_COUNTERS
      ReadOperationCount: 'uint64',
      WriteOperationCount: 'uint64',
      OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64',
      WriteTransferCount: 'uint64',
      OtherTransferCount: 'uint64',
    });
    const info = koffi.struct({ // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
      BasicLimitInformation: basic,
      IoInfo: io,
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });
    const infoSize = koffi.sizeof(info);
    const expected = EXPECTED_INFO_SIZE[process.arch];
    if (expected === undefined || infoSize !== expected) {
      loaded = { ok: false, error: `Job Objects are not supported on this processor (${process.arch}, ${infoSize} bytes).` };
      return loaded;
    }
    // kernel32 is one of Windows' known DLLs: it always comes from the system folder.
    const lib = koffi.load('kernel32.dll');
    const kernel32 = {
      CreateJobObjectW: lib.func('void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)'),
      SetInformationJobObject: lib.func('__stdcall', 'SetInformationJobObject', 'int', ['void *', 'int', koffi.pointer(info), 'uint32_t']),
      OpenProcess: lib.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      AssignProcessToJobObject: lib.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
      TerminateJobObject: lib.func('int __stdcall TerminateJobObject(void *job, uint32_t exitCode)'),
      CloseHandle: lib.func('int __stdcall CloseHandle(void *handle)'),
      GetLastError: lib.func('uint32_t __stdcall GetLastError()'),
    } as unknown as Kernel32;
    loaded = { ok: true, value: { kernel32, infoSize } };
  } catch (error) {
    loaded = { ok: false, error: `The library for Windows Job Objects (koffi) could not be loaded: ${(error as Error).message}` };
  }
  return loaded;
}

/** "<what> failed (Windows error <code>)": koffi keeps the last error of the call before. */
function failure(kernel32: Kernel32, what: string): string {
  return `${what} failed (Windows error ${kernel32.GetLastError()}).`;
}

/** Makes a new job (Windows only). Never throws. */
export function createJob(): JobResult {
  if (process.platform !== 'win32') return { ok: false, error: 'Job Objects exist only on Windows.' };
  const lib = load();
  if (!lib.ok) return lib;
  const { kernel32, infoSize } = lib.value;
  try {
    const handle = kernel32.CreateJobObjectW(null, null);
    if (isNull(handle)) return { ok: false, error: failure(kernel32, 'Making a Job Object') };
    // Every field given (koffi's docs don't say what it does with a missing one): only the two limits are set.
    const limits = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };
    if (kernel32.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, limits, infoSize) === 0) {
      const error = failure(kernel32, 'Setting up the Job Object');
      kernel32.CloseHandle(handle);
      return { ok: false, error };
    }
    return { ok: true, job: new WindowsJob(kernel32, handle) };
  } catch (error) {
    return { ok: false, error: `A Job Object could not be made: ${(error as Error).message}` };
  }
}

class WindowsJob implements ProcessJob {
  private closed = false;

  constructor(
    private readonly kernel32: Kernel32,
    private readonly handle: unknown,
  ) {}

  add(pid: number): string | null {
    if (this.closed) return 'The Job Object was already closed.';
    if (!Number.isSafeInteger(pid) || pid <= 0) return `There is no process ${pid}.`;
    const k = this.kernel32;
    try {
      // Node holds a handle to its child until it has exited, so `pid` can't be reused by another process meanwhile.
      const child = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (isNull(child)) return failure(k, `Opening process ${pid}`);
      try {
        return k.AssignProcessToJobObject(this.handle, child) === 0 ? failure(k, `Putting process ${pid} in the Job Object`) : null;
      } finally {
        k.CloseHandle(child);
      }
    } catch (error) {
      return `Process ${pid} could not be put in the Job Object: ${(error as Error).message}`;
    }
  }

  terminate(): string | null {
    if (this.closed) return 'The Job Object was already closed.';
    try {
      return this.kernel32.TerminateJobObject(this.handle, STOPPED_EXIT_CODE) === 0 ? failure(this.kernel32, 'Stopping the Job Object') : null;
    } catch (error) {
      return `The Job Object could not be stopped: ${(error as Error).message}`;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.kernel32.CloseHandle(this.handle);
    } catch {
      // Nothing more can be done; Windows closes it when Orchestra exits.
    }
  }
}
