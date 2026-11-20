/**
 * The files that tie a linked worktree to the repository:
 * - `<worktree>/.git` is a file: `gitdir: <commonDir>/worktrees/<name>`;
 * - `<commonDir>/worktrees/<name>/gitdir` points back to `<worktree>/.git`;
 * - `<commonDir>/worktrees/<name>/commondir` points to the shared folder (usually `../..`).
 *
 * Reading them needs no git, so they can be checked before the conductor runs any git in a worktree. A
 * worker that rewrites one of them could send later git commands to a repository of its choosing.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalPath, samePath } from '../repo/canonical.js';

export interface LinkProblem {
  readonly code: 'git-pointer' | 'worktree-admin';
  readonly message: string;
}

/** A small control file's text, or null if it is missing or isn't a regular file (a folder or a symlink). */
export function readControlFile(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isRealFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A path stored in a control file: absolute, or relative to the folder holding the file. */
function resolveStored(value: string, base: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

/** The admin folder named by a worktree's `.git` file text (`gitdir: <path>`), or null if malformed. */
export function parseGitFile(text: string, worktreePath: string): string | null {
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text);
  return match?.[1] === undefined ? null : resolveStored(match[1], worktreePath);
}

/** Single-line file content without its line ending, or null. */
function firstLine(text: string | null): string | null {
  if (text === null) return null;
  const line = text.replace(/\r?\n$/, '');
  return line.length === 0 || line.includes('\n') ? null : line;
}

/** A one-line control file (HEAD, gitdir, commondir) without its line ending, or null. */
export function readControlLine(path: string): string | null {
  return firstLine(readControlFile(path));
}

/**
 * Compares where two paths really are (symlinks and short names resolved), also when the last part doesn't
 * exist: then the parent folders are resolved and the names compared.
 */
export function sameLocation(a: string, b: string, caseInsensitive: boolean): boolean {
  const realA = canonicalPath(a);
  const realB = canonicalPath(b);
  if (realA !== null && realB !== null) return samePath(realA, realB, caseInsensitive);
  const viaParent = (p: string): string => join(canonicalPath(dirname(p)) ?? resolve(dirname(p)), basename(p));
  return samePath(viaParent(a), viaParent(b), caseInsensitive);
}

/** Where an admin folder's `gitdir` file points (the worktree's `.git`), or null. */
export function adminTarget(adminDir: string): string | null {
  const line = readControlLine(join(adminDir, 'gitdir'));
  return line === null ? null : resolveStored(line, adminDir);
}

/**
 * Finds git's admin folder for a worktree by reading every `<commonDir>/worktrees/*\/gitdir`. Doesn't trust
 * the worktree's own `.git` file, which a worker can rewrite.
 */
export function findAdminDir(commonDir: string, worktreePath: string, caseInsensitive: boolean): string | null {
  const parent = join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return null;
  }
  const wanted = join(worktreePath, '.git');
  for (const name of names) {
    const adminDir = join(parent, name);
    const target = adminTarget(adminDir);
    if (target !== null && sameLocation(target, wanted, caseInsensitive)) return canonicalPath(adminDir) ?? adminDir;
  }
  return null;
}

/** Checks that the worktree and its admin folder still point at each other and at the shared folder. */
export function checkWorktreeLinks(
  wt: { readonly path: string; readonly adminDir: string },
  commonDir: string,
  caseInsensitive: boolean,
): LinkProblem[] {
  const problems: LinkProblem[] = [];
  const gitFile = join(wt.path, '.git');
  const pointerText = readControlFile(gitFile);
  const pointer = pointerText === null ? null : parseGitFile(pointerText, wt.path);
  if (pointer === null) {
    problems.push({
      code: 'git-pointer',
      message: `${gitFile} is missing, is not a file, or is not a "gitdir:" link.`,
    });
  } else if (!sameLocation(pointer, wt.adminDir, caseInsensitive)) {
    problems.push({ code: 'git-pointer', message: `${gitFile} now points to ${pointer} instead of ${wt.adminDir}.` });
  }

  if (!isRealFolder(wt.adminDir)) {
    problems.push({ code: 'worktree-admin', message: `Git's folder for this worktree (${wt.adminDir}) is missing.` });
    return problems;
  }
  const target = adminTarget(wt.adminDir);
  if (target === null || !sameLocation(target, gitFile, caseInsensitive)) {
    problems.push({
      code: 'worktree-admin',
      message: `${join(wt.adminDir, 'gitdir')} no longer points to ${gitFile}.`,
    });
  }
  const common = readControlLine(join(wt.adminDir, 'commondir'));
  if (common === null || !sameLocation(resolveStored(common, wt.adminDir), commonDir, caseInsensitive)) {
    problems.push({
      code: 'worktree-admin',
      message: `${join(wt.adminDir, 'commondir')} no longer points to the repository (${commonDir}).`,
    });
  }
  return problems;
}
