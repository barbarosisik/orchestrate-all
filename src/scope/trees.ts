/** Comparing and listing trees with git, for the scope check and for merging. Pass verified tree ids. */

import { repoGit, type RepoContext } from '../git/context.js';
import { describeGitFailure } from '../git/run.js';
import { parseRawDiff, type TreeChange } from './diff.js';

/** Every changed path, never a rename, with no diff driver or textconv program run. */
const DIFF_ARGS = ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv'] as const;

export type Listed<T> = ({ ok: true } & T) | { ok: false; message: string };

export async function diffTrees(ctx: RepoContext, from: string, to: string): Promise<Listed<{ changes: TreeChange[] }>> {
  const result = await repoGit(ctx, [...DIFF_ARGS, from, to]);
  if (result.code !== 0) return { ok: false, message: `git diff-tree failed: ${describeGitFailure(result)}` };
  return { ok: true, changes: parseRawDiff(result.stdout) };
}

/** Every file path in a tree. */
export async function treePaths(ctx: RepoContext, tree: string): Promise<Listed<{ paths: string[] }>> {
  const result = await repoGit(ctx, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', tree]);
  if (result.code !== 0) return { ok: false, message: `git ls-tree failed: ${describeGitFailure(result)}` };
  return { ok: true, paths: result.stdout.split('\u0000').filter((p) => p.length > 0) };
}
