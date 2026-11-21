/**
 * Turning an acceptance command (an argument array from the approved plan) into a program to start,
 * without a shell.
 *
 * - A bare name ("npm", "cargo") is looked up in PATH's absolute folders only, never in the worktree the
 *   command runs in: a worker could put an `npm.exe` there.
 * - A name with a folder ("./gradlew", "scripts/check.sh") is a file of the project, relative to the worktree.
 * - On Windows, PATHEXT decides which extensions are tried. `.exe` and `.com` files start directly. `.cmd` and
 *   `.bat` files need cmd.exe, which re-reads its command line, so (the "BatBadBut" problem, CVE-2024-27980):
 *   - npm and npx start their real JavaScript file with node instead, when it is where Node installs it;
 *   - any other batch file runs through `cmd.exe /d /s /c` with every argument quoted, and only with
 *     arguments that hold none of the characters cmd.exe or the batch file could act on (" % ! ^ & | < > ( )
 *     and control characters). A command that needs one is refused with a clear message.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { absolutePathFolders, isRunnableFile } from '../os/path-search.js';

export interface Launch {
  /** The program to start (a full path). */
  readonly program: string;
  readonly args: readonly string[];
  /** Pass `args` to Windows as written (only for the cmd.exe line, which is quoted here). */
  readonly windowsVerbatimArguments: boolean;
}

export type ResolveErrorCode = 'empty' | 'not-found' | 'unsafe-argument';

export type ResolveResult =
  | { ok: true; launch: Launch }
  | { ok: false; error: { code: ResolveErrorCode; message: string } };

export interface ResolveOptions {
  /** The worktree the command runs in. */
  readonly cwd: string;
  /** The command's environment (PATH, PATHEXT, SystemRoot). */
  readonly env: NodeJS.ProcessEnv;
  /** Defaults to this process's platform. */
  readonly platform?: NodeJS.Platform;
  /**
   * More npm shims to start as node + script on Windows, beyond npm's and npx's: the shim's file name (lower
   * case) and its script, relative to the shim's folder.
   */
  readonly nodeScripts?: Readonly<Record<string, string>>;
}

/** Extensions Windows can start without a shell, and those that need cmd.exe. */
const DIRECT_EXTENSIONS = new Set(['.exe', '.com']);
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Characters cmd.exe or a batch file could act on, plus control characters. */
const UNSAFE_FOR_BATCH = /["%!^&|<>()\u0000-\u001f\u007f]/;
/** Same, for the batch file's own path: "C:\Program Files (x86)\..." needs its parentheses. */
const UNSAFE_IN_BATCH_PATH = /["%!^&|<>\u0000-\u001f\u007f]/;

/** npm's and npx's real scripts, where Node's Windows installer puts them next to npm.cmd. */
const NODE_SCRIPTS: Readonly<Record<string, string>> = {
  'npm.cmd': join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  'npx.cmd': join('node_modules', 'npm', 'bin', 'npx-cli.js'),
};

function fail(code: ResolveErrorCode, message: string): ResolveResult {
  return { ok: false, error: { code, message } };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** PATHEXT's extensions Windows can start (lower case, in order). */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const listed = (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').map((e) => e.trim().toLowerCase());
  return listed.filter((e) => DIRECT_EXTENSIONS.has(e) || BATCH_EXTENSIONS.has(e));
}

/** The file names to try for a name: itself if it already has a startable extension, then name + extension. */
function candidates(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [name];
  const extensions = windowsExtensions(env);
  const own = extname(name).toLowerCase();
  const withOwn = extensions.includes(own) ? [name] : [];
  return [...withOwn, ...extensions.map((ext) => `${name}${ext}`)];
}

function hasFolder(name: string, platform: NodeJS.Platform): boolean {
  return name.includes('/') || (platform === 'win32' && name.includes('\\'));
}

/** Finds the file a command name means, or null. */
export function findProgramFile(name: string, opts: ResolveOptions): string | null {
  const platform = opts.platform ?? process.platform;
  const names = candidates(name, platform, opts.env);
  const folders = hasFolder(name, platform) || isAbsolute(name) ? [opts.cwd] : absolutePathFolders(opts.env);
  for (const folder of folders) {
    for (const candidate of names) {
      const file = isAbsolute(candidate) ? candidate : resolve(folder, candidate);
      if (isRunnableFile(file)) return file;
    }
  }
  return null;
}

/** For npm.cmd / npx.cmd (and `extra` shims): node and the script, when they are laid out as usual. */
function nodeScriptLaunch(file: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}): Launch | null {
  const name = basename(file).toLowerCase();
  const script = Object.hasOwn(NODE_SCRIPTS, name) ? NODE_SCRIPTS[name] : Object.hasOwn(extra, name) ? extra[name] : undefined;
  if (script === undefined) return null;
  const dir = dirname(file);
  const scriptPath = join(dir, script);
  if (!existsSync(scriptPath)) return null;
  const node = join(dir, 'node.exe');
  return { program: existsSync(node) ? node : process.execPath, args: [scriptPath, ...args], windowsVerbatimArguments: false };
}

/** The `cmd.exe /d /s /c "..."` launch for a batch file, or why it can't be done safely. */
export function batchLaunch(file: string, args: readonly string[], env: NodeJS.ProcessEnv): ResolveResult {
  if (UNSAFE_IN_BATCH_PATH.test(file)) {
    return fail('unsafe-argument', `The path ${file} holds a character cmd.exe would act on, so it can't run safely.`);
  }
  for (const arg of args) {
    if (UNSAFE_FOR_BATCH.test(arg) || arg.endsWith('\\')) {
      return fail(
        'unsafe-argument',
        `"${arg}" can't be passed safely to ${basename(file)}, a batch file run by cmd.exe ` +
          '(no " % ! ^ & | < > ( ), control characters or a trailing backslash). Run the tool directly instead, ' +
          'for example with node and its script.',
      );
    }
  }
  const systemRoot = envValue(env, 'SYSTEMROOT');
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    return fail('not-found', 'SystemRoot is not set, so cmd.exe cannot be found.');
  }
  // /d: no AutoRun commands; /s /c "...": cmd strips exactly the outer quotes and runs the rest.
  const line = [file, ...args].map((part) => `"${part}"`).join(' ');
  return {
    ok: true,
    launch: { program: join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true },
  };
}

export function resolveCommand(argv: readonly string[], opts: ResolveOptions): ResolveResult {
  const [name, ...args] = argv;
  if (name === undefined || name.length === 0) return fail('empty', 'The command is empty.');
  const file = findProgramFile(name, opts);
  if (file === null) {
    const where = hasFolder(name, opts.platform ?? process.platform) ? 'in the worktree' : "in PATH's folders";
    return fail('not-found', `"${name}" was not found ${where}.`);
  }
  if ((opts.platform ?? process.platform) !== 'win32' || !BATCH_EXTENSIONS.has(extname(file).toLowerCase())) {
    return { ok: true, launch: { program: file, args, windowsVerbatimArguments: false } };
  }
  const viaNode = nodeScriptLaunch(file, args, opts.nodeScripts);
  return viaNode !== null ? { ok: true, launch: viaNode } : batchLaunch(file, args, opts.env);
}
