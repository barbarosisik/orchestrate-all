/**
 * The one way Orchestra runs git: no shell, arguments as an array, a cleaned environment, hardening
 * options on every call, and a timeout. Failures come back as data (exit code + stderr), not exceptions;
 * only "git could not be started at all" rejects.
 *
 * Git is started by its full path, found in PATH's absolute folders only. A bare `spawn('git')` would let
 * Windows run a `git.exe` from the folder git runs in, and git runs in worktrees that workers control.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { absolutePathFolders, isRunnableFile, pathValue } from '../os/path-search.js';

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Stdout went past `maxStdoutBytes`: only its start was kept, and git was stopped. */
  readonly truncated?: boolean;
}

/** Like GitResult, with stdout as raw bytes (for object contents). */
export interface RawGitResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated?: boolean;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Text written to git's stdin, after which stdin is closed. */
  readonly input?: string;
  /** Leave stdin open (tests only). By default stdin is closed immediately. */
  readonly keepStdinOpen?: boolean;
  /** The git program to run. Defaults to the first `git` found in PATH's absolute folders. */
  readonly gitBinary?: string;
  /** Base environment to clean; defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Use this index file instead of the repository's own (sets GIT_INDEX_FILE after cleaning). Lets the
   * conductor stage a worktree's content in a private index that no worker has touched.
   */
  readonly indexFile?: string;
  /**
   * Keep at most this many bytes of stdout (the start), then stop git. For output only shown to the user, such
   * as a diff, which could otherwise be as large as the files it shows.
   */
  readonly maxStdoutBytes?: number;
}

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
/** For calls that walk a whole tree (checkout, removal, staging a worktree): big projects take a while. */
export const LONG_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Applied to every call.
 * - core.fsmonitor can name a program git runs on status/diff, so it is always off.
 * - Replacement refs (refs/replace/) and the commit-graph file can make git see other objects or other
 *   commit trees than the ones stored, so neither is used.
 * - Long paths help on Windows; quotepath off keeps non-ASCII paths readable in messages.
 * - Automatic gc and maintenance stay off so they never hold locks while workers run.
 */
export const GIT_HARDENING: readonly string[] = [
  '--no-replace-objects',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.commitGraph=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'core.quotepath=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
];

/** Copies the environment without any GIT_* variable (they can redirect git to another repo or index). */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toUpperCase().startsWith('GIT_')) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

function withIndexFile(env: NodeJS.ProcessEnv, indexFile: string | undefined): NodeJS.ProcessEnv {
  if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/**
 * The full path of the git program: the first `git` (`git.exe` on Windows) in PATH. Empty, relative and
 * "." entries are skipped, so the folder git would run in is never searched. Null when there is none.
 */
export function findGitProgram(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of absolutePathFolders(env)) {
    const candidate = join(dir, name);
    if (isRunnableFile(candidate)) return candidate;
  }
  return null;
}

let found: { readonly path: string; readonly program: string } | undefined;

function gitProgram(env: NodeJS.ProcessEnv): string {
  const path = pathValue(env);
  if (found?.path === path) return found.program;
  const program = findGitProgram(env);
  if (program === null) throw new Error('Git was not found in PATH. Install Git, then try again.');
  found = { path, program };
  return program;
}

/** One line for an error message: "timed out", git's first stderr line, or the exit code. */
export function describeGitFailure(result: GitResult | RawGitResult): string {
  if (result.timedOut) return 'timed out';
  return result.stderr.trim().split('\n')[0] || `exit code ${result.code}`;
}

/** Runs git and returns stdout as raw bytes. */
export function runGitRaw(args: readonly string[], opts: GitOptions): Promise<RawGitResult> {
  return new Promise((resolve, reject) => {
    const base = opts.env ?? process.env;
    // Throws (and so rejects) when git can't be found.
    const program = opts.gitBinary ?? gitProgram(base);
    const child = spawn(program, [...GIT_HARDENING, ...args], {
      cwd: opts.cwd,
      env: withIndexFile(gitEnv(base), opts.indexFile),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);

    const maxOut = opts.maxStdoutBytes ?? Infinity;
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (outBytes + chunk.length > maxOut) {
        out.push(chunk.subarray(0, maxOut - outBytes));
        outBytes = maxOut;
        truncated = true;
        child.kill();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else if (opts.keepStdinOpen !== true) child.stdin.end();
  });
}

export async function runGit(args: readonly string[], opts: GitOptions): Promise<GitResult> {
  const raw = await runGitRaw(args, opts);
  return { ...raw, stdout: raw.stdout.toString('utf8') };
}
