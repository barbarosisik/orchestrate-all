/**
 * The git config and attributes files that change how git behaves in this repository, wherever they are:
 * system, global and XDG files, files pulled in by `include.path` / `includeIf.<condition>.path`, and the
 * global attributes file. A worker that edits one could make the conductor's git run a program (a filter,
 * core.fsmonitor in an included file) or read other attributes.
 *
 * Found by asking git which files it read (`git config --list --show-origin`), plus the files git would read
 * if they existed, so creating one is noticed too.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { repoGit, type RepoContext } from '../git/context.js';
import { describeGitFailure } from '../git/run.js';
import { samePath } from '../repo/canonical.js';

/** ~/.gitconfig and the XDG config and attributes files ($XDG_CONFIG_HOME/git/, else ~/.config/git/). */
export function defaultGlobalGitFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return [join(homedir(), '.gitconfig'), join(configHome, 'git', 'config'), join(configHome, 'git', 'attributes')];
}

/** A path from a config value: "~/" is the home folder; a relative path is relative to `base`. Null if unusable. */
export function resolveConfigPath(value: string, base: string): string | null {
  if (value.length === 0 || value.startsWith('%(')) return null;
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(1));
  if (value.startsWith('~')) return null;
  return isAbsolute(value) ? value : resolve(base, value);
}

/** Files read and files named, from `git config --list --show-origin -z` output. Paths resolve against `cwd`. */
export function parseConfigOrigins(output: string, cwd: string, repoRoot: string): string[] {
  const files: string[] = [];
  const tokens = output.split('\u0000');
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const origin = tokens[i] as string;
    const entry = tokens[i + 1] as string;
    if (!origin.startsWith('file:')) continue;
    const file = resolve(cwd, origin.slice('file:'.length));
    files.push(file);
    const newline = entry.indexOf('\n');
    const key = (newline === -1 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline === -1 ? '' : entry.slice(newline + 1);
    let named: string | null = null;
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
      // Included files are relative to the file that includes them.
      named = resolveConfigPath(value, dirname(file));
    } else if (key === 'core.attributesfile') {
      named = resolveConfigPath(value, repoRoot);
    }
    if (named !== null) files.push(named);
  }
  return files;
}

export type ConfigFilesResult = { ok: true; files: string[] } | { ok: false; message: string };

/**
 * Every config and attributes file to watch, sorted, without the repository's own `config` and
 * `config.worktree` (watched with the repository's files).
 */
export async function gitConfigFiles(ctx: RepoContext, extra: readonly string[]): Promise<ConfigFilesResult> {
  const list = await repoGit(ctx, ['config', '--list', '--show-origin', '-z']);
  if (list.code !== 0) return { ok: false, message: `git config --list failed: ${describeGitFailure(list)}` };
  const files = [...extra, ...parseConfigOrigins(list.stdout, ctx.commonDir, ctx.repoRoot)];
  // The system and global files git would read if they existed (git 2.42+; older git skips this).
  for (const name of ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL']) {
    const known = await repoGit(ctx, ['var', name]);
    if (known.code !== 0) continue;
    for (const line of known.stdout.split('\n')) {
      const file = line.replace(/\r$/, '');
      if (file.length > 0 && isAbsolute(file)) files.push(file);
    }
  }
  const own = [join(ctx.commonDir, 'config'), join(ctx.commonDir, 'config.worktree')];
  const ci = ctx.caseInsensitivePaths;
  const unique = new Map<string, string>();
  for (const file of files) {
    const normalized = resolve(file);
    if (own.some((o) => samePath(o, normalized, ci))) continue;
    const key = ci ? normalized.toLowerCase() : normalized;
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return { ok: true, files: [...unique.values()].sort() };
}
