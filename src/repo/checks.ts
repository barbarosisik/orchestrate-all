/**
 * Repository checks (the second half of safeguard 1). Runs after validatePlan and before anything else:
 * real top-level git repo, target branch, base commit, and no unsaved work under owned paths.
 * Read-only: git runs with optional locks off, so the user's index is never written.
 */

import { statSync } from 'node:fs';
import { sha256Of } from '../plan/hash.js';
import { entriesOverlap, parseOwnsEntry, toKey, type OwnsEntry } from '../plan/paths.js';
import type { NormalizedPlan, ValidationError, ValidationErrorCode } from '../plan/validate.js';
import { runGit, type GitResult } from '../git/run.js';
import { canonicalPath, DEFAULT_CASE_INSENSITIVE, samePath } from './canonical.js';
import { parseStatusZ, type DirtyPath, type DirtyState } from './status.js';

export interface RepoOptions {
  readonly caseInsensitivePaths?: boolean;
  /** How many unsaved files to name per task before summarizing the rest. */
  readonly maxListed?: number;
}

export interface ReadyPlan {
  /** The normalized plan plus the commit every worker starts from. This is what gets approved. */
  readonly plan: NormalizedPlan & { readonly baseSha: string };
  readonly planHash: string;
  /** Canonical top-level folder of the repository. */
  readonly repoRoot: string;
  /** Git's shared folder (`--git-common-dir`), used later to address worktrees explicitly. */
  readonly gitCommonDir: string;
}

export type RepoCheckResult = { ok: true; ready: ReadyPlan } | { ok: false; errors: ValidationError[] };

const STATE_TEXT: Record<DirtyState, string> = {
  changed: 'uncommitted change',
  conflicted: 'unresolved conflict',
  untracked: 'new file, not committed',
  ignored: 'ignored by git',
};

function failure(code: ValidationErrorCode, message: string, path = 'repo'): RepoCheckResult {
  return { ok: false, errors: [{ path, code, message }] };
}

function gitFailure(what: string, result: GitResult): RepoCheckResult {
  const detail = result.timedOut ? 'timed out' : result.stderr.trim().split('\n')[0] || `exit code ${result.code}`;
  return failure('git-failed', `git ${what} failed: ${detail}`);
}

function dirtyEntry(dirty: DirtyPath): OwnsEntry {
  const path = dirty.path.normalize('NFC');
  return { path, key: toKey(path), isFolder: path.endsWith('/') };
}

function dirtyOwnedErrors(plan: NormalizedPlan, dirty: readonly DirtyPath[], maxListed: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const dirtyEntries = dirty.map((d) => ({ dirty: d, entry: dirtyEntry(d) }));

  plan.tasks.forEach((task, index) => {
    const owned = task.owns.flatMap((raw) => {
      const parsed = parseOwnsEntry(raw);
      return parsed.ok ? [parsed.entry] : [];
    });
    const hits = dirtyEntries.filter(({ entry }) => owned.some((o) => entriesOverlap(o, entry)));
    if (hits.length === 0) return;

    const listed = hits.slice(0, maxListed).map(({ dirty: d }) => `${d.path} (${STATE_TEXT[d.state]})`);
    const more = hits.length > maxListed ? ` and ${hits.length - maxListed} more` : '';
    errors.push({
      path: `tasks[${index}].owns`,
      code: 'dirty-owned',
      message:
        `Task "${task.id}" owns paths with unsaved work: ${listed.join(', ')}${more}. ` +
        'Workers start from the last commit and would not see these files. Commit, stash or move them first.',
    });
  });
  return errors;
}

export async function checkRepo(plan: NormalizedPlan, opts: RepoOptions = {}): Promise<RepoCheckResult> {
  const caseInsensitive = opts.caseInsensitivePaths ?? DEFAULT_CASE_INSENSITIVE;

  const dir = canonicalPath(plan.repo);
  if (dir === null || !statSync(dir).isDirectory()) {
    return failure('repo-missing', `"${plan.repo}" does not exist or is not a folder.`);
  }

  const bare = await runGit(['rev-parse', '--is-bare-repository'], { cwd: dir });
  if (bare.code !== 0) return failure('not-a-git-repo', `"${plan.repo}" is not inside a git repository.`);
  if (bare.stdout.trim() === 'true') return failure('bare-repo', `"${plan.repo}" is a bare repository with no files.`);

  const where = await runGit(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: dir });
  if (where.code !== 0) return gitFailure('rev-parse', where);
  const [topLevel = '', commonDir = ''] = where.stdout.split('\n').map((line) => line.trim());
  const root = canonicalPath(topLevel);
  if (root === null || !samePath(root, dir, caseInsensitive)) {
    return failure(
      'repo-not-toplevel',
      `"${plan.repo}" is inside a repository but is not its top folder (${topLevel}). Use the top folder.`,
    );
  }

  const branchOk = await runGit(['check-ref-format', '--branch', plan.targetBranch], { cwd: dir });
  if (branchOk.code !== 0) {
    return failure('bad-branch', `"${plan.targetBranch}" is not a valid branch name.`, 'targetBranch');
  }
  const tip = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${plan.targetBranch}^{commit}`], { cwd: dir });
  if (tip.code !== 0) {
    return failure('branch-missing', `Branch "${plan.targetBranch}" does not exist in this repository.`, 'targetBranch');
  }
  const baseSha = tip.stdout.trim();

  const status = await runGit(
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames'],
    { cwd: dir },
  );
  if (status.code !== 0) return gitFailure('status', status);
  const errors = dirtyOwnedErrors(plan, parseStatusZ(status.stdout), opts.maxListed ?? 5);
  if (errors.length > 0) return { ok: false, errors };

  const readyPlan = { ...plan, baseSha };
  return {
    ok: true,
    ready: { plan: readyPlan, planHash: sha256Of(readyPlan), repoRoot: dir, gitCommonDir: canonicalPath(commonDir) ?? commonDir },
  };
}
