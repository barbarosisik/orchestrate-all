/**
 * Fingerprints of files and folders, to tell later whether anything changed. Symlinks are never followed:
 * a link is recorded by the text it points to, so a change can't hide behind one.
 *
 * A fingerprint is "missing", "dir", "file:<sha256>", "link:<target>" or "other".
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function fingerprintPath(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return `file:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
    return 'other';
  } catch {
    return 'missing';
  }
}

/**
 * Fingerprints of a folder and everything below it, keyed by `<prefix>/<relative path>` (the folder itself
 * under `<prefix>`). A missing folder gives a single "missing" entry.
 */
export async function fingerprintFolder(root: string, prefix: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const pending: string[] = [''];
  while (pending.length > 0) {
    const rel = pending.pop() as string;
    const key = rel === '' ? prefix : `${prefix}/${rel}`;
    const fingerprint = await fingerprintPath(join(root, rel));
    result[key] = fingerprint;
    if (fingerprint !== 'dir') continue;
    const names = await readdir(join(root, rel)).catch(() => [] as string[]);
    for (const name of names) pending.push(rel === '' ? name : `${rel}/${name}`);
  }
  return result;
}

export interface RecordDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

/** Keys added, removed or changed between two fingerprint records, each list sorted. */
export function diffRecords(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): RecordDiff {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function isEmptyDiff(diff: RecordDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
