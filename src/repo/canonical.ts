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

/** Forward slashes, Unicode NFC, no trailing slash; lower-case when the file system ignores case. */
function comparable(path: string, caseInsensitive: boolean): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC');
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

export function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  return comparable(a, caseInsensitive) === comparable(b, caseInsensitive);
}

/**
 * True when `child` is `parent` itself or somewhere below it. Compares whole path segments, never a bare
 * string prefix, so "/repo-evil" is not inside "/repo". Pass canonical paths.
 */
export function isInsidePath(child: string, parent: string, caseInsensitive: boolean): boolean {
  const c = comparable(child, caseInsensitive);
  const p = comparable(parent, caseInsensitive);
  // Roots work too: "/" becomes "" and "C:\" becomes "c:", so the prefix is "/" or "c:/".
  return c === p || c.startsWith(`${p}/`);
}
