/**
 * Which rule files a task's worker must be pointed at (step 11, research §4.5): the ones that apply to the files
 * it may change, that its engine won't load by itself. The brief lists their paths ("read before editing files
 * under X"); no rule text is copied into it, so nothing is loaded twice and nested precedence stays as the
 * project wrote it.
 *
 * Which rule files apply: those of the top folder, of every folder on the way to a file the task owns, and of
 * every folder inside a folder it owns. In each such folder:
 * - `AGENTS.md` is the shared file, so every worker gets it (Codex gets `AGENTS.override.md` instead where one
 *   is, as Codex itself would), together with its own engine's files (CLAUDE.md and `.claude/rules` for Claude;
 *   GEMINI.md and `.agents/...` for Antigravity);
 * - a folder without either gets the other engines' files instead (a CLAUDE.md-only project still has rules for
 *   Codex). `AGENTS.override.md` is Codex's alone and never given to other engines.
 *
 * What each engine loads by itself, in a worktree whose top is the repository's top:
 * - Claude Code: every Claude rule file (the top ones at the start, nested ones when it reads a file there) and
 *   what they import or link to; an AGENTS.md only from 2.1.277 on, and only where no CLAUDE.md is in charge
 *   (none at the top and none in its folder). An unknown version counts as older.
 * - Codex: the top folder's `AGENTS.override.md` (when not empty) or else its `AGENTS.md`; nothing below.
 * - Antigravity: the top folder's `AGENTS.md`, GEMINI.md and `.agents/...` files; nothing below.
 * Files over what the engine loads (Codex 32 KiB, Antigravity 24,000 bytes) are pointed at to read in full. A
 * link checked out as text (core.symlinks off), or a file holding just another rule file's name, gives the
 * engine one line, so the worker is pointed at what it names. A CLAUDE.md that only imports is replaced by its
 * imports for engines that don't follow them.
 *
 * Only committed files count (untracked and ignored ones are not in the worktree), and names that are odd in a
 * brief are never pointed at.
 */

import { atLeast, parseVersion } from '../engines/version.js';
import { parseOwnsEntry } from '../plan/paths.js';
import type { EngineName } from '../plan/schema.js';
import { ANTIGRAVITY_RULES_CAP, CODEX_RULES_CAP, isOddName, type RuleFileEntry, type RulesManifest } from './manifest.js';
import { CLAUDE_MAIN_KINDS } from './names.js';

/** Claude Code reads AGENTS.md itself from this version on. */
export const CLAUDE_AGENTS_MD_VERSION = '2.1.277';

export type PointerReason = 'not-loaded' | 'too-long' | 'link-target' | 'import';

export interface RulePointer {
  /** The repo-relative file the worker should read. */
  readonly path: string;
  /** The folder whose files these rules are for ('' for the whole repository). */
  readonly folder: string;
  readonly reason: PointerReason;
  /** The rule file that leads here (a link, a one-line pointer or an import), or null. */
  readonly via: string | null;
}

export interface TaskRules {
  /** The project has rule files that workers get. */
  readonly any: boolean;
  /** Top folder first, each file once. */
  readonly pointers: readonly RulePointer[];
}

export interface RulesForTaskOptions {
  /** Claude Code's version from detection, for Claude workers. Unknown counts as older than 2.1.277. */
  readonly claudeVersion?: string | null;
}

/** Folder comparison key: Windows first, so letter case is ignored (as for owned paths). */
function key(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function depth(folder: string): number {
  return folder === '' ? 0 : folder.split('/').length;
}

/** Folders whose rules apply to a task that owns these entries (keys). */
function relevantFolders(owns: readonly string[], ruleFolders: readonly string[]): Set<string> {
  const folders = new Set<string>(['']);
  for (const raw of owns) {
    const parsed = parseOwnsEntry(raw);
    if (!parsed.ok) continue;
    const { entry } = parsed;
    const segments = entry.key.split('/');
    const upTo = entry.isFolder ? segments.length : segments.length - 1;
    for (let i = 1; i <= upTo; i++) folders.add(segments.slice(0, i).join('/'));
    if (entry.isFolder) for (const folder of ruleFolders) if (folder.startsWith(`${entry.key}/`)) folders.add(folder);
  }
  return folders;
}

export function rulesForTask(manifest: RulesManifest, task: { readonly owns: readonly string[] }, engine: EngineName, opts: RulesForTaskOptions = {}): TaskRules {
  const files = manifest.files.filter((f) => f.source === 'committed' && !f.flags.some((flag) => flag.code === 'odd-name'));
  const byPath = new Map(files.map((f) => [key(f.path), f]));
  const byFolder = new Map<string, RuleFileEntry[]>();
  for (const f of files) {
    const list = byFolder.get(key(f.folder)) ?? [];
    list.push(f);
    byFolder.set(key(f.folder), list);
  }
  const linksAsText = manifest.linksAsText;
  const version = opts.claudeVersion === undefined || opts.claudeVersion === null ? null : parseVersion(opts.claudeVersion);
  const claudeReadsAgents = version !== null && atLeast(version, CLAUDE_AGENTS_MD_VERSION);
  const hasClaudeMain = (folder: string): boolean => (byFolder.get(key(folder)) ?? []).some((f) => CLAUDE_MAIN_KINDS.has(f.kind));
  const rootOverride = (byFolder.get('') ?? []).some((f) => f.kind === 'AGENTS.override.md' && (f.size ?? 0) > 0);
  // Files Claude reaches through its own rule files: their imports, and their links when links are real.
  const claudeReaches = new Set<string>();
  for (const f of files) {
    if (f.family !== 'claude') continue;
    for (const i of f.imports) if (i.path !== null && i.exists) claudeReaches.add(key(i.path));
    if (f.link?.resolved != null && !linksAsText) claudeReaches.add(key(f.link.resolved));
  }

  const loadsItself = (f: RuleFileEntry): boolean => {
    switch (engine) {
      case 'claude':
        if (f.family === 'claude') return true;
        if (f.kind !== 'AGENTS.md') return false;
        return claudeReaches.has(key(f.path)) || (claudeReadsAgents && !hasClaudeMain('') && !hasClaudeMain(f.folder));
      case 'codex':
        return f.folder === '' && (rootOverride ? f.kind === 'AGENTS.override.md' : f.kind === 'AGENTS.md');
      case 'antigravity':
        return f.folder === '' && (f.family === 'gemini' || f.kind === 'AGENTS.md');
    }
  };
  const tooLong = (f: RuleFileEntry): boolean => {
    if (f.link !== null || f.size === null) return false;
    if (engine === 'codex') return f.size > CODEX_RULES_CAP;
    if (engine === 'antigravity') return f.size > ANTIGRAVITY_RULES_CAP;
    return false;
  };

  const pointers: RulePointer[] = [];
  const seen = new Set<string>();
  const push = (path: string, folder: string, reason: PointerReason, via: string | null): void => {
    if (isOddName(path) || seen.has(key(path))) return;
    seen.add(key(path));
    pointers.push({ path, folder, reason, via });
  };
  /** Points at a file a rule file leads to, unless the engine loads it fully by itself. */
  const lead = (path: string, folder: string, reason: PointerReason, via: string): void => {
    const target = byPath.get(key(path));
    if (target !== undefined && loadsItself(target) && target.link === null && target.pointsTo === null && !tooLong(target)) return;
    push(target?.link?.resolved ?? target?.pointsTo ?? path, folder, reason, via);
  };

  const wanted = (folder: string): RuleFileEntry[] => {
    const here = byFolder.get(folder) ?? [];
    const shared = here.filter((f) => f.kind === 'AGENTS.md');
    const claude = here.filter((f) => f.family === 'claude');
    const gemini = here.filter((f) => f.family === 'gemini');
    let primary: RuleFileEntry[];
    if (engine === 'codex') {
      const override = here.filter((f) => f.kind === 'AGENTS.override.md' && (folder !== '' || (f.size ?? 0) > 0));
      primary = override.length > 0 ? override : shared;
    } else primary = [...shared, ...(engine === 'claude' ? claude : gemini)];
    if (primary.length > 0) return primary;
    return engine === 'codex' ? [...claude, ...gemini] : engine === 'claude' ? gemini : claude;
  };

  const folders = [...relevantFolders(task.owns, [...byFolder.keys()])].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const folder of folders) {
    const list = wanted(folder);
    // Files that lead elsewhere first, so a pointer says where it came from.
    const redirects = (f: RuleFileEntry): boolean => f.link !== null || f.pointsTo !== null || f.importsOnly;
    for (const f of [...list.filter(redirects), ...list.filter((g) => !redirects(g))]) {
      if (f.link !== null) {
        if (f.link.resolved !== null && (linksAsText || !loadsItself(f))) lead(f.link.resolved, f.folder, 'link-target', f.path);
        continue;
      }
      if (f.pointsTo !== null) {
        lead(f.pointsTo, f.folder, 'link-target', f.path);
        continue;
      }
      if (loadsItself(f)) {
        if (tooLong(f)) push(f.path, f.folder, 'too-long', null);
        continue;
      }
      if (!f.importsOnly) push(f.path, f.folder, 'not-loaded', null);
      for (const i of f.imports) if (i.path !== null && i.exists) lead(i.path, f.folder, 'import', f.path);
    }
  }
  return { any: files.length > 0, pointers };
}
