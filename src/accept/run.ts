/**
 * The acceptance runner (step 6). Runs a task's acceptance commands in its worktree, one after the other,
 * and records what really happened: exit code, time and output. A worker's own "the tests pass" is never
 * used; the conductor runs the commands itself.
 *
 * - No shell: each command is an argument array from the approved plan, resolved by resolve.ts.
 * - The environment is an allowlist (env.ts): secrets don't reach the commands.
 * - Each command has a time limit. On timeout its whole process tree is stopped: on Linux and macOS the
 *   command runs in its own process group, which is killed; on Windows `taskkill /t` stops the tree. On
 *   Linux and macOS, processes a command leaves running when it exits are stopped too.
 * - Output is kept up to a limit per stream: the start and, mostly, the end (where test runners summarize).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { DEFAULT_LIMITS } from '../config/defaults.js';
import { commandEnv, type CommandEnvOptions } from './env.js';
import { resolveCommand, type Launch } from './resolve.js';

export const DEFAULT_COMMAND_TIMEOUT_MS = DEFAULT_LIMITS.acceptanceCommandTimeoutMinutes * 60_000;
/** Output kept per stream: the first quarter from the start, the rest from the end. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** How long to wait for output to finish after a command exits (a leftover process may hold it open). */
const CLOSE_GRACE_MS = 5_000;

export interface CapturedOutput {
  readonly text: string;
  /** Bytes the command wrote in total. */
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export const COMMAND_STATUSES = ['passed', 'failed', 'timed-out', 'not-started'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export interface CommandResult {
  readonly argv: readonly string[];
  /** The program that was started, or null if none could be. */
  readonly program: string | null;
  readonly status: CommandStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  /** Why the command didn't start or didn't finish normally. */
  readonly error: string | null;
}

export interface AcceptanceResult {
  /** Every command passed (true when there are none). */
  readonly passed: boolean;
  readonly commands: readonly CommandResult[];
}

export interface RunOptions extends CommandEnvOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Base environment to filter; defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Keeps the first and last bytes of a stream, up to a limit. */
export class OutputCapture {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  constructor(maxBytes: number) {
    this.headLimit = Math.floor(maxBytes / 4);
    this.tailLimit = maxBytes - this.headLimit;
  }

  add(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const take = rest.subarray(0, this.headLimit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > this.tailLimit) {
      const first = this.tail[0] as Buffer;
      const excess = this.tailBytes - this.tailLimit;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  result(): CapturedOutput {
    const kept = this.headBytes + this.tailBytes;
    const left = this.total - kept;
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    const text = left > 0 ? `${head}\n[... ${left} bytes left out ...]\n${tail}` : `${head}${tail}`;
    return { text, totalBytes: this.total, truncated: left > 0 };
  }
}

const EMPTY_OUTPUT: CapturedOutput = { text: '', totalBytes: 0, truncated: false };

/** Stops a command and everything it started. */
async function stopTree(pid: number, env: NodeJS.ProcessEnv): Promise<void> {
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

function notStarted(argv: readonly string[], program: string | null, error: string): CommandResult {
  return {
    argv,
    program,
    status: 'not-started',
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: EMPTY_OUTPUT,
    stderr: EMPTY_OUTPUT,
    error,
  };
}

function launchCommand(
  argv: readonly string[],
  launch: Launch,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = new OutputCapture(maxOutputBytes);
    const stderr = new OutputCapture(maxOutputBytes);
    let timedOut = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    let finished = false;

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(launch.program, [...launch.args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        // Its own process group on Linux and macOS, so the whole tree can be stopped.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Some failures (a file that isn't a program: ENOEXEC) are thrown right away instead of reported.
      resolve(notStarted(argv, launch.program, error instanceof Error ? error.message : String(error)));
      return;
    }

    const finish = (error: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const code = exit?.code ?? null;
      const status: CommandStatus = timedOut ? 'timed-out' : code === 0 ? 'passed' : 'failed';
      resolve({
        argv,
        program: launch.program,
        status,
        exitCode: code,
        signal: exit?.signal ?? null,
        durationMs: Date.now() - started,
        stdout: stdout.result(),
        stderr: stderr.result(),
        error: timedOut ? `Stopped after ${Math.round(timeoutMs / 1000)} s.` : error,
      });
    };

    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void stopTree(child.pid, env);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (exit === null && !finished) {
        finished = true;
        resolve(notStarted(argv, launch.program, error.message));
      }
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // Anything the command left running is stopped (on Linux and macOS: its process group).
      if (child.pid !== undefined && process.platform !== 'win32') void stopTree(child.pid, env);
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish('Its output stayed open after it exited (a process it started may still be running).');
      }, CLOSE_GRACE_MS);
    });
    child.on('close', () => {
      if (exit !== null) finish(null);
    });
  });
}

/** Runs one command in `cwd`. Never throws: problems come back in the result. */
export async function runCommand(cwd: string, argv: readonly string[], opts: RunOptions = {}): Promise<CommandResult> {
  const env = commandEnv(opts.env ?? process.env, opts);
  const resolved = resolveCommand(argv, { cwd, env });
  if (!resolved.ok) return notStarted(argv, null, resolved.error.message);
  return launchCommand(
    argv,
    resolved.launch,
    cwd,
    env,
    opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  );
}

/** Runs every command, in order, even after one fails, so the review sees the whole picture. */
export async function runAcceptance(
  cwd: string,
  commands: readonly (readonly string[])[],
  opts: RunOptions = {},
): Promise<AcceptanceResult> {
  const results: CommandResult[] = [];
  for (const argv of commands) results.push(await runCommand(cwd, argv, opts));
  return { passed: results.every((r) => r.status === 'passed'), commands: results };
}
