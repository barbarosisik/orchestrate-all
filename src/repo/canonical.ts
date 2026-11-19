/** Comparing folder paths the way the operating system sees them (real path, case rules). */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** Windows and macOS file systems are case-insensitive by default. */
export const DEFAULT_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function stripTrailingSeparator(path: string): string {
  const stripped = path.replace(/[\\/]+$/, '');
  if (stripped.length === 0) return path.slice(0, 1);
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

/** The absolute real path (symlinks and Windows short names resolved), or null if it doesn't exist. */
export function canonicalPath(path: string): string | null {
  try {
    return stripTrailingSeparator(realpathSync.native(resolve(path)));
  } catch {
    return null;
  }
}

export function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/** True only when `repoDir` is exactly one of the allowlisted folders (not merely inside one). */
export function isAllowedRepo(
  repoDir: string,
  allowedRepos: readonly string[],
  caseInsensitive: boolean = DEFAULT_CASE_INSENSITIVE,
): boolean {
  const target = canonicalPath(repoDir);
  if (target === null) return false;
  return allowedRepos.some((entry) => {
    const allowed = canonicalPath(entry);
    return allowed !== null && samePath(allowed, target, caseInsensitive);
  });
}
