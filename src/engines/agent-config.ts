/**
 * The agents' own config folders, before and after each worker (step 10, research §7.5). A worker that writes
 * outside its worktree could plant something that runs later with the user's full rights, outside any run: a
 * hook in `~/.claude/settings.json`, an MCP server in `~/.codex/config.toml`, a rule in `~/.gemini/GEMINI.md`, a
 * line in Claude's automatic memory for one of the user's projects (CVE-2026-25725 was such a planted user-level
 * hook). Only the conductor's checks after the worker catch it until workers are sandboxed at the OS level.
 *
 * What is watched: the files and folders, per engine, that change how an agent behaves: settings (hooks,
 * permissions, status-line commands), the user's own rule files, sub-agents, commands, skills (Codex's bundled
 * `.system` ones too: Codex loads them), hook scripts, plugin lists, MCP and hook configs, Codex's command rules
 * and profiles, Gemini extensions, Claude's automatic memory (`projects/<project>/memory`), and scripts at the
 * top of `~/.claude`, `~/.codex` and `~/.gemini` (where settings usually point their status-line and notify
 * commands). What engines write as they work (sessions, logs, history, caches, todo lists) is left out, so a normal
 * run reports nothing.
 *
 * What is never read: sign-ins. `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`
 * and `~/.claude.json` (which can hold an API key, and changes on every run) are not on the list, and any file
 * named like a sign-in, or under `.ssh`, `.aws` and the like, is fingerprinted by size, times and file id only,
 * without opening it (Orchestra never reads credentials). Other files are hashed (up to 1 MiB; larger ones by
 * size, times and id), so an edit that keeps the size and puts the old modification time back is still seen.
 * Files are opened without following links and never block on a pipe (store/files.ts).
 *
 * Links: dotfile setups often link `~/.claude/settings.json` or a skill folder elsewhere, so a link is recorded by
 * its target and followed: the file or folder it leads to is compared too (a folder to the same limits, each real
 * folder once, so a loop ends). A folder counts through what it holds (a new empty folder changes nothing an
 * agent reads). Each tree is compared up to 5000 entries and 6 levels deep; past that the report says it is
 * incomplete, which counts as a problem.
 *
 * Known limits: plugin code under `~/.claude/plugins/marketplaces` and `cache` changes on its own and is left out
 * (the lists of installed plugins are watched); managed settings need admin rights and are left out; with workers
 * running in parallel, or the user's own agent sessions writing memory, a change is reported by every worker that
 * ran while it happened.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import type { Stats } from 'node:fs';
import { readFileCapped } from '../store/files.js';

const MAX_HASH_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5000;
const MAX_DEPTH = 6;

/** Names never opened, wherever they are: sign-ins, keys and tokens. */
const SIGN_IN_NAME =
  /(^|[._-])(credentials?|auth|oauth|token|tokens|secret|secrets)([._-]|$)|\.(key|pem|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)|^\.(netrc|npmrc|pypirc|git-credentials)$|^\.env/i;
/** Folders whose files are never opened. */
const SECRET_FOLDERS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'gcloud']);
/** Scripts at the top of an agent's folder: settings point their commands there. */
const SCRIPT_NAME = /\.(sh|bash|zsh|fish|ps1|psm1|cmd|bat|py|js|mjs|cjs|ts|rb|pl|exe)$/i;

interface Place {
  /** The engine (or "agents" for the shared skills folder). */
  readonly name: 'claude' | 'codex' | 'agents' | 'gemini';
  readonly root: string;
  /** Files at fixed places in `root`, relative paths. */
  readonly files: readonly string[];
  /** Folders compared with all they hold, relative paths. */
  readonly trees: readonly string[];
  /** File names directly in `root` that are watched too. */
  readonly rootPatterns: readonly RegExp[];
  /** `[parent, child]`: the `child` folder of every folder in `parent` (Claude's per-project memory). */
  readonly nested: readonly (readonly [string, string])[];
}

export interface AgentConfigOptions {
  /** The user's home folder (os.homedir() for a real run; tests pass a temp folder). */
  readonly home: string;
  /** The environment, for CLAUDE_CONFIG_DIR and CODEX_HOME. */
  readonly env: NodeJS.ProcessEnv;
  /** Entries compared per tree; defaults to 5000. */
  readonly maxEntries?: number;
}

function envFolder(env: NodeJS.ProcessEnv, name: string): string | null {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  const value = key === undefined ? undefined : env[key];
  return value !== undefined && value.length > 0 && isAbsolute(value) ? value : null;
}

/** Where each agent keeps the settings that change how it behaves. */
export function watchedPlaces(opts: Pick<AgentConfigOptions, 'home' | 'env'>): Place[] {
  const { home, env } = opts;
  return [
    {
      name: 'claude',
      root: envFolder(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude'),
      files: ['settings.json', 'CLAUDE.md', join('plugins', 'installed_plugins.json'), join('plugins', 'known_marketplaces.json')],
      trees: ['rules', 'agents', 'commands', 'skills', 'hooks', 'output-styles'],
      rootPatterns: [SCRIPT_NAME],
      nested: [['projects', 'memory']],
    },
    {
      name: 'codex',
      root: envFolder(env, 'CODEX_HOME') ?? join(home, '.codex'),
      files: ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'hooks.json'],
      trees: ['rules', 'prompts', 'skills'],
      rootPatterns: [/\.config\.toml$/i, SCRIPT_NAME],
      nested: [],
    },
    { name: 'agents', root: join(home, '.agents'), files: [], trees: ['skills'], rootPatterns: [], nested: [] },
    {
      name: 'gemini',
      root: join(home, '.gemini'),
      files: ['GEMINI.md', 'AGENTS.md', 'settings.json', join('antigravity-cli', 'settings.json')],
      trees: ['config', 'commands', 'extensions'],
      rootPatterns: [SCRIPT_NAME],
      nested: [],
    },
  ];
}

export interface AgentConfigSnapshot {
  /** Path → fingerprint. */
  readonly entries: ReadonlyMap<string, string>;
  /** Trees that could not be compared in full. */
  readonly incomplete: readonly string[];
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown';
}

/** A file that must not be opened: named like a sign-in, or inside a folder of secrets. */
function isSecret(path: string): boolean {
  return SIGN_IN_NAME.test(basename(path)) || path.split(sep).some((part) => SECRET_FOLDERS.has(part));
}

/** Size, both times and the file id: any write changes the change time, which `utimes` can't put back. */
function metadata(info: Stats): string {
  return `${info.size} ${info.mtimeMs} ${info.ctimeMs} ${info.dev}:${info.ino}`;
}

async function filePrint(path: string, info: Stats, secretName: boolean): Promise<string> {
  if (secretName || isSecret(path) || info.size > MAX_HASH_BYTES) return `file ${metadata(info)}`;
  const read = await readFileCapped(path, MAX_HASH_BYTES);
  if (!read.ok) return `file unreadable ${read.problem.code} ${metadata(info)}`;
  return `file ${info.size} ${createHash('sha256').update(read.value).digest('hex')}`;
}

interface Print {
  readonly print: string | null;
  /** For a folder (also one reached through a link): its real path and entry names. */
  readonly folder: { readonly real: string; readonly children: readonly string[] } | null;
}

async function folderOf(path: string): Promise<Print['folder'] | string> {
  try {
    return { real: await realpath(path), children: (await readdir(path)).sort() };
  } catch (error) {
    return `folder error ${code(error)}`;
  }
}

/**
 * The fingerprint of one entry (null print for a plain folder, which counts through what it holds), or null when
 * it doesn't exist. A link is recorded by its target and followed.
 */
async function fingerprint(path: string): Promise<Print | null> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    return code(error) === 'ENOENT' ? null : { print: `error ${code(error)}`, folder: null };
  }
  if (info.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(path);
    } catch (error) {
      return { print: `link error ${code(error)}`, folder: null };
    }
    let real: string;
    let resolved: Stats;
    try {
      real = await realpath(path);
      resolved = await stat(real);
    } catch (error) {
      return { print: `link ${target} -> ${code(error)}`, folder: null };
    }
    if (resolved.isDirectory()) {
      const folder = await folderOf(real);
      return typeof folder === 'string' ? { print: `link ${target} -> ${folder}`, folder: null } : { print: `link ${target} -> folder`, folder };
    }
    if (!resolved.isFile()) return { print: `link ${target} -> other`, folder: null };
    return { print: `link ${target} -> ${await filePrint(real, resolved, isSecret(path))}`, folder: null };
  }
  if (info.isDirectory()) {
    const folder = await folderOf(path);
    return typeof folder === 'string' ? { print: folder, folder: null } : { print: null, folder };
  }
  if (!info.isFile()) return { print: 'other', folder: null };
  return { print: await filePrint(path, info, false), folder: null };
}

async function walkTree(top: string, entries: Map<string, string>, incomplete: string[], maxEntries: number): Promise<void> {
  let count = 0;
  let tooDeep = false;
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: top, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift() as { path: string; depth: number };
    if (count >= maxEntries) {
      incomplete.push(`${top} has more than ${maxEntries} entries; only the first were compared.`);
      return;
    }
    const print = await fingerprint(path);
    if (print === null) continue;
    count += 1;
    if (print.print !== null) entries.set(path, print.print);
    if (print.folder === null || visited.has(print.folder.real)) continue;
    visited.add(print.folder.real);
    if (depth >= MAX_DEPTH) {
      if (print.folder.children.length > 0) tooDeep = true;
      continue;
    }
    for (const child of print.folder.children) queue.push({ path: join(path, child), depth: depth + 1 });
  }
  if (tooDeep) incomplete.push(`${top} is nested deeper than ${MAX_DEPTH} folders; deeper files were not compared.`);
}

async function namesIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch {
    return [];
  }
}

/** Fingerprints every watched file and folder. Never throws; unreadable entries are fingerprinted as such. */
export async function snapshotAgentConfig(opts: AgentConfigOptions): Promise<AgentConfigSnapshot> {
  const entries = new Map<string, string>();
  const incomplete: string[] = [];
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  for (const place of watchedPlaces(opts)) {
    const fixed = place.files.map((file) => join(place.root, file));
    const matching = (await namesIn(place.root)).filter((name) => place.rootPatterns.some((p) => p.test(name))).map((name) => join(place.root, name));
    for (const path of [...new Set([...fixed, ...matching])]) {
      const print = await fingerprint(path);
      if (print !== null) entries.set(path, print.print ?? 'folder');
    }
    for (const tree of place.trees) await walkTree(join(place.root, tree), entries, incomplete, maxEntries);
    for (const [parent, child] of place.nested) {
      for (const name of await namesIn(join(place.root, parent))) {
        await walkTree(join(place.root, parent, name, child), entries, incomplete, maxEntries);
      }
    }
  }
  return { entries, incomplete };
}

export interface AgentConfigChange {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'changed';
}

export interface AgentConfigReport {
  /** Nothing changed and everything could be compared. */
  readonly ok: boolean;
  readonly changes: readonly AgentConfigChange[];
  readonly incomplete: readonly string[];
}

export function compareAgentConfig(before: AgentConfigSnapshot, after: AgentConfigSnapshot): AgentConfigReport {
  const changes: AgentConfigChange[] = [];
  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort();
  for (const path of paths) {
    const was = before.entries.get(path);
    const is = after.entries.get(path);
    if (was === is) continue;
    changes.push({ path, change: was === undefined ? 'added' : is === undefined ? 'removed' : 'changed' });
  }
  const incomplete = [...new Set([...before.incomplete, ...after.incomplete])];
  return { ok: changes.length === 0 && incomplete.length === 0, changes, incomplete };
}
