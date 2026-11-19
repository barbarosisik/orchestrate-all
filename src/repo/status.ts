/** Parsing `git status --porcelain=v2 -z` output into a list of paths with unsaved state. */

export type DirtyState = 'changed' | 'conflicted' | 'untracked' | 'ignored';

export interface DirtyPath {
  /** Repo-relative path with forward slashes; ignored folders keep their trailing "/". */
  readonly path: string;
  readonly state: DirtyState;
}

function afterFields(entry: string, fieldCount: number): string {
  let index = -1;
  for (let i = 0; i < fieldCount; i++) {
    index = entry.indexOf(' ', index + 1);
    if (index === -1) throw new Error(`Unexpected git status entry: ${entry.slice(0, 60)}`);
  }
  const path = entry.slice(index + 1);
  if (path.length === 0) throw new Error(`Unexpected git status entry: ${entry.slice(0, 60)}`);
  return path;
}

export function parseStatusZ(output: string): DirtyPath[] {
  const tokens = output.split('\u0000');
  const result: DirtyPath[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as string;
    if (entry.length === 0) continue;
    const kind = entry[0];
    if (kind === '#') continue;
    if ((kind === '?' || kind === '!') && entry[1] === ' ' && entry.length > 2) {
      result.push({ path: entry.slice(2), state: kind === '?' ? 'untracked' : 'ignored' });
    } else if (kind === '1') {
      result.push({ path: afterFields(entry, 8), state: 'changed' });
    } else if (kind === '2') {
      result.push({ path: afterFields(entry, 9), state: 'changed' });
      const original = tokens[i + 1];
      if (original === undefined || original.length === 0) {
        throw new Error(`Unexpected git status entry: rename without an original path`);
      }
      result.push({ path: original, state: 'changed' });
      i += 1;
    } else if (kind === 'u') {
      result.push({ path: afterFields(entry, 10), state: 'conflicted' });
    } else {
      throw new Error(`Unexpected git status entry: ${entry.slice(0, 60)}`);
    }
  }
  return result;
}
