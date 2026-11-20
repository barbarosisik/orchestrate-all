/**
 * The one way Orchestra runs git: no shell, arguments as an array, a cleaned environment, hardening
 * options on every call, and a timeout. Failures come back as data (exit code + stderr), not exceptions;
 * only "git could not be started at all" rejects.
 */

import { spawn } from 'node:child_process';

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Text written to git's stdin, after which stdin is closed. */
  readonly input?: string;
  /** Leave stdin open (tests only). By default stdin is closed immediately. */
  readonly keepStdinOpen?: boolean;
  readonly gitBinary?: string;
  /** Base environment to clean; defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Use this index file instead of the repository's own (sets GIT_INDEX_FILE after cleaning). Lets the
   * conductor stage a worktree's content in a private index that no worker has touched.
   */
  readonly indexFile?: string;
}

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
/** For calls that walk a whole tree (checkout, removal, staging a worktree): big projects take a while. */
export const LONG_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Applied to every call. core.fsmonitor can name a program git runs on status/diff, so it is always off;
 * long paths help on Windows; quotepath off keeps non-ASCII paths readable in messages; automatic gc and
 * maintenance stay off so they never hold locks while workers run.
 */
export const GIT_HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
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

/** One line for an error message: "timed out", git's first stderr line, or the exit code. */
export function describeGitFailure(result: GitResult): string {
  if (result.timedOut) return 'timed out';
  return result.stderr.trim().split('\n')[0] || `exit code ${result.code}`;
}

export function runGit(args: readonly string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.gitBinary ?? 'git', [...GIT_HARDENING, ...args], {
      cwd: opts.cwd,
      env: withIndexFile(gitEnv(opts.env ?? process.env), opts.indexFile),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else if (opts.keepStdinOpen !== true) child.stdin.end();
  });
}
