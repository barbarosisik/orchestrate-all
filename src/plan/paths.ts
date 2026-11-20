/**
 * Owned-path entries ("owns") and how they are compared.
 *
 * An entry is a repo-relative file path, or a folder path ending in "/" meaning everything under it.
 * Comparison is done on a key that is slash-normalized, Unicode NFC and lower-case, because the target
 * platform (Windows) treats paths case-insensitively.
 */

export interface OwnsEntry {
  /** Normalized display form: forward slashes, NFC, no repeated slashes; folders keep a trailing "/". */
  readonly path: string;
  /** Comparison key: like `path` but lower-case and without a trailing "/". */
  readonly key: string;
  readonly isFolder: boolean;
}

export type PathIssue =
  | 'empty'
  | 'absolute'
  | 'too-long'
  | 'dot-segment'
  | 'wildcard'
  | 'invalid-char'
  | 'trailing-dot-or-space'
  | 'short-name'
  | 'reserved-device-name';

export type ParseResult = { ok: true; entry: OwnsEntry } | { ok: false; issue: PathIssue };

export const MAX_PATH_LENGTH = 1000;

const WILDCARD = /[*?[\]]/;
// Characters Windows does not allow in names, plus ":" (drive letters, alternate data streams) and control chars.
const INVALID_CHAR = /[<>:"|\u0000-\u001f\u007f]/;
const SHORT_NAME = /~\d/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function toKey(normalizedPath: string): string {
  const withoutSlash = normalizedPath.endsWith('/') ? normalizedPath.slice(0, -1) : normalizedPath;
  return withoutSlash.toLowerCase().normalize('NFC');
}

/** True for names Windows reserves for devices (CON, NUL, COM1, ...), with or without an extension. */
export function isWindowsDeviceName(name: string): boolean {
  return DEVICE_NAME.test(name.split('.')[0] ?? name);
}

function segmentIssue(segment: string): PathIssue | null {
  if (segment === '.' || segment === '..') return 'dot-segment';
  if (WILDCARD.test(segment)) return 'wildcard';
  if (INVALID_CHAR.test(segment)) return 'invalid-char';
  if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) return 'trailing-dot-or-space';
  if (SHORT_NAME.test(segment)) return 'short-name';
  if (isWindowsDeviceName(segment)) return 'reserved-device-name';
  return null;
}

// In a file name (not an "owns" pattern), "[" and "]" are fine; "*", "?" and "\" are not allowed on Windows.
const INVALID_NAME_CHAR = /[<>:"|?*\\\u0000-\u001f\u007f]/;

/**
 * Why a repo-relative file path (as git stores it, with "/") could not be checked out on Windows, or null if
 * it can. Used for files a worker adds, so a task can't leave the user with a tree Windows can't open.
 */
export function windowsPathIssue(gitPath: string): PathIssue | null {
  for (const segment of gitPath.split('/')) {
    if (segment.length === 0) return 'empty';
    if (INVALID_NAME_CHAR.test(segment)) return 'invalid-char';
    if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) return 'trailing-dot-or-space';
    if (SHORT_NAME.test(segment)) return 'short-name';
    if (isWindowsDeviceName(segment)) return 'reserved-device-name';
  }
  return null;
}

export function parseOwnsEntry(raw: string): ParseResult {
  if (raw.length === 0) return { ok: false, issue: 'empty' };

  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return { ok: false, issue: 'absolute' };

  const collapsed = slashed.replace(/\/{2,}/g, '/').normalize('NFC');
  if (collapsed.length > MAX_PATH_LENGTH) return { ok: false, issue: 'too-long' };

  const isFolder = collapsed.endsWith('/');
  const body = isFolder ? collapsed.slice(0, -1) : collapsed;
  const segments = body.split('/');

  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, issue: 'empty' };
    const issue = segmentIssue(segment);
    if (issue !== null) return { ok: false, issue };
  }

  const path = isFolder ? `${body}/` : body;
  return { ok: true, entry: { path, key: toKey(path), isFolder } };
}

/** True when `outer` is a folder that contains `inner`, or both name the same path. */
export function covers(outer: OwnsEntry, inner: OwnsEntry): boolean {
  if (outer.key === inner.key) return true;
  return outer.isFolder && inner.key.startsWith(`${outer.key}/`);
}

export function entriesOverlap(a: OwnsEntry, b: OwnsEntry): boolean {
  return covers(a, b) || covers(b, a);
}

/** Removes duplicates and entries already covered by a folder in the same list, sorted by key. */
export function minimizeEntries(entries: readonly OwnsEntry[]): OwnsEntry[] {
  const kept: OwnsEntry[] = [];
  for (const candidate of entries) {
    if (kept.some((existing) => covers(existing, candidate))) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      const existing = kept[i];
      if (existing !== undefined && covers(candidate, existing)) kept.splice(i, 1);
    }
    kept.push(candidate);
  }
  return kept.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

export const PATH_ISSUE_TEXT: Record<PathIssue, string> = {
  empty: 'is empty or has an empty segment',
  absolute: 'is absolute; use a path relative to the repository root',
  'too-long': `is longer than ${MAX_PATH_LENGTH} characters`,
  'dot-segment': 'contains a "." or ".." segment',
  wildcard: 'contains a wildcard (* ? [ ]); list exact files, or a folder ending in "/"',
  'invalid-char': 'contains a character Windows does not allow in names (< > : " | ? * \\ or a control character)',
  'trailing-dot-or-space': 'has a name that starts with a space or ends with a dot or space',
  'short-name': 'looks like a Windows 8.3 short name (for example PROGRA~1)',
  'reserved-device-name': 'uses a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)',
};
