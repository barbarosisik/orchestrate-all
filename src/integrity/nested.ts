/**
 * Looks for git metadata a worker may have planted inside its worktree: a `.git` file or folder below the
 * top (a nested repository, or a link to some other git folder), or a folder git would accept as a git
 * folder: HEAD plus objects and refs, or HEAD plus a `commondir` file pointing at such a pair elsewhere.
 * Any git command run from inside such a folder would use that repository's config, which can name programs
 * to run. The worktree's own top-level `.git` is checked separately.
 *
 * Names are compared the way Windows and macOS file systems compare them: ".GIT", ".git." and ".git " (Windows
 * drops trailing dots and spaces) and ".git" with invisible characters (old macOS HFS+ ignores them) all
 * count as ".git".
 *
 * Symlinks are not followed. A folder that can't be read makes the scan incomplete rather than silently
 * skipping it.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export interface NestedGitFinding {
  /** Path relative to the worktree, with forward slashes. */
  readonly path: string;
  readonly kind: 'git-entry' | 'repo-layout';
}

export interface NestedGitScan {
  readonly findings: readonly NestedGitFinding[];
  /** False when the entry limit was reached or a folder couldn't be read. */
  readonly complete: boolean;
}

/** Enough for a project with a large node_modules; a run can raise it. */
export const DEFAULT_MAX_SCAN_ENTRIES = 1_000_000;

// Characters HFS+ ignores in names (the list git itself uses for core.protectHFS).
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/** A name as a case-insensitive file system that drops trailing dots and spaces would see it. */
function foldName(name: string): string {
  return name.replace(HFS_IGNORED, '').toLowerCase().replace(/[. ]+$/, '');
}

/** True for any spelling of ".git" that Windows or macOS would treat as ".git". */
export function isGitName(name: string): boolean {
  return foldName(name) === '.git';
}

function looksLikeGitFolder(entries: readonly Dirent[]): boolean {
  const names = new Set(entries.map((e) => foldName(e.name)));
  return names.has('head') && ((names.has('objects') && names.has('refs')) || names.has('commondir'));
}

export async function scanForNestedGit(root: string, maxEntries = DEFAULT_MAX_SCAN_ENTRIES): Promise<NestedGitScan> {
  const findings: NestedGitFinding[] = [];
  const pending: string[] = [''];
  let seen = 0;
  let complete = true;

  while (pending.length > 0) {
    const rel = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch (error) {
      // A folder that vanished mid-scan is fine; one we can't read could hide anything.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      continue;
    }
    if (looksLikeGitFolder(entries)) {
      findings.push({ path: rel === '' ? '.' : rel, kind: 'repo-layout' });
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) return { findings, complete: false };
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (isGitName(entry.name)) {
        if (rel !== '') findings.push({ path: childRel, kind: 'git-entry' });
        continue;
      }
      // Dirent reports symlinks (and Windows junctions) as links, not folders, so they are not followed.
      if (entry.isDirectory()) pending.push(childRel);
    }
  }
  return { findings: findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), complete };
}
