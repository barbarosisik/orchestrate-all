/**
 * Finding the program an engine is started with (step 10), the same way acceptance commands are found
 * (accept/resolve.ts): in PATH's absolute folders only, never in the worktree the worker runs in, where a
 * worker could have put a `claude.exe` of its own.
 *
 * On Windows, npm installs Claude Code and Codex as `.cmd` shims. A worker's arguments must never pass through
 * cmd.exe, which re-reads them, so these shims are started as node plus the CLI's own script, as npm's own
 * shims are. The user may also name a program by its absolute path in the config (for example the Claude Code
 * that comes with the VS Code extension, research §9 D4); a relative path is refused, since it would be looked
 * up in the worktree.
 */

import { isAbsolute, join } from 'node:path';
import { resolveCommand, type ResolveResult } from '../accept/resolve.js';
import type { EngineName } from '../plan/schema.js';

export const ENGINE_COMMANDS: Readonly<Record<EngineName, string>> = { claude: 'claude', codex: 'codex', antigravity: 'agy' };

/** npm's Windows shims for the engines and the script each one starts (relative to the shim's folder). */
const ENGINE_NODE_SCRIPTS: Readonly<Record<string, string>> = {
  'claude.cmd': join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  'codex.cmd': join('node_modules', '@openai', 'codex', 'bin', 'codex.js'),
};

export interface ProgramOptions {
  /** The folder the program will run in. Never searched. */
  readonly cwd: string;
  /** The environment it will run with (PATH, PATHEXT, SystemRoot). */
  readonly env: NodeJS.ProcessEnv;
  /** An absolute path from the user's config, used instead of PATH. */
  readonly program?: string;
  /** Defaults to this process's platform. */
  readonly platform?: NodeJS.Platform;
}

/** How to start `engine` with `args`, or why it can't be started. */
export function engineLaunch(engine: EngineName, args: readonly string[], opts: ProgramOptions): ResolveResult {
  if (opts.program !== undefined && !isAbsolute(opts.program)) {
    return {
      ok: false,
      error: { code: 'not-found', message: `The program configured for ${engine} must be an absolute path, not "${opts.program}".` },
    };
  }
  return resolveCommand([opts.program ?? ENGINE_COMMANDS[engine], ...args], {
    cwd: opts.cwd,
    env: opts.env,
    nodeScripts: ENGINE_NODE_SCRIPTS,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  });
}
