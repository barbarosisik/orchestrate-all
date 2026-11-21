/** Parsing `git diff-tree -r -z --raw --no-renames` output: one entry per added, changed or deleted path. */

export type ChangeStatus = 'A' | 'D' | 'M' | 'T';

export interface TreeChange {
  /** Repo-relative path with forward slashes, exactly as git stores it. */
  readonly path: string;
  /** A = added, D = deleted, M = content or mode changed, T = type changed (e.g. file to symlink). */
  readonly status: ChangeStatus;
  /** "000000" when added. */
  readonly oldMode: string;
  /** "000000" when deleted; "120000" is a symlink, "160000" a nested repository (gitlink). */
  readonly newMode: string;
  /** Object ids before and after; all zeros on the side where the path doesn't exist. */
  readonly oldId: string;
  readonly newId: string;
}

const STATUSES: ReadonlySet<string> = new Set(['A', 'D', 'M', 'T']);

export function parseRawDiff(output: string): TreeChange[] {
  const tokens = output.split('\u0000');
  const changes: TreeChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i] as string;
    if (meta.length === 0) continue;
    const fields = meta.startsWith(':') ? meta.slice(1).split(' ') : [];
    const path = tokens[i + 1];
    const status = fields[4];
    if (fields.length !== 5 || status === undefined || !STATUSES.has(status) || path === undefined || path.length === 0) {
      throw new Error(`Unexpected git diff entry: ${meta.slice(0, 80)}`);
    }
    changes.push({
      path,
      status: status as ChangeStatus,
      oldMode: fields[0] as string,
      newMode: fields[1] as string,
      oldId: fields[2] as string,
      newId: fields[3] as string,
    });
    i += 1;
  }
  return changes;
}
