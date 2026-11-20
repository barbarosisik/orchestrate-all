/**
 * The scope check and the conductor's commit (step 5, safeguard 3).
 *
 * Snapshot: the worktree's content is staged into a private index that starts from the expected commit, so
 * nothing a worker did to its own index (assume-unchanged or skip-worktree bits, staged files) can hide a
 * change. Attributes (line endings, filters) come from that commit too, never from .gitattributes files the
 * worker wrote. The new tree is compared with the commit (`diff-tree -r -z --no-renames`) and every added,
 * changed or deleted path goes through the scope rules. Ignored files are listed but never committed.
 *
 * Commit: the conductor commits exactly the tree it checked (`commit-tree`, Orchestra's identity, never
 * signed, no hooks), moves the task branch with compare-and-swap, then reads the branch back and checks the
 * commit again (the post-commit re-check). If that fails, the branch is moved back.
 *
 * Run the integrity check first: this module re-checks only what would redirect its own git (the worktree's
 * links, a per-worktree config file, nested git folders) and trusts the repository's shared config.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCHESTRA_GIT_IDENTITY } from '../config/defaults.js';
import { repoGit, worktreeGit, type RepoContext } from '../git/context.js';
import { describeGitFailure, LONG_GIT_TIMEOUT_MS, type GitResult } from '../git/run.js';
import { DEFAULT_MAX_SCAN_ENTRIES, scanForNestedGit } from '../integrity/nested.js';
import { entriesOverlap, parseOwnsEntry, toKey } from '../plan/paths.js';
import { checkWorktreeLinks, readControlFile } from '../worktree/links.js';
import type { TaskWorktree } from '../worktree/manager.js';
import { parseRawDiff, type TreeChange } from './diff.js';
import { DEFAULT_SCOPE_RULES, evaluateScope, type ScopeRules, type ScopeTask, type ScopeViolation } from './rules.js';

export interface IgnoredPath {
  /** Repo-relative; a whole ignored folder ends with "/". */
  readonly path: string;
  /** True when it overlaps the task's owned paths: work there will not be committed. */
  readonly owned: boolean;
}

export interface ScopeReport {
  /** Nothing is out of scope, so the tree may be committed. */
  readonly clean: boolean;
  /** The commit the worktree was compared with. */
  readonly fromCommit: string;
  /** The tree the worktree holds now. */
  readonly tree: string;
  readonly changes: readonly TreeChange[];
  readonly violations: readonly ScopeViolation[];
  /** Ignored files and folders in the worktree. They are never committed. */
  readonly ignored: readonly IgnoredPath[];
}

export type ScopeErrorCode = 'bad-commit' | 'worktree-tampered' | 'nested-git' | 'git-failed';

export interface ScopeError {
  readonly code: ScopeErrorCode;
  readonly message: string;
}

export type ScopeCheck = { ok: true; report: ScopeReport } | { ok: false; error: ScopeError };

export interface ScopeOptions {
  /** The commit to compare with: where the task branch should point now. */
  readonly fromCommit: string;
  readonly rules?: ScopeRules;
  readonly maxScanEntries?: number;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIFF_ARGS = ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv'] as const;

function scopeError(code: ScopeErrorCode, message: string): ScopeCheck {
  return { ok: false, error: { code, message } };
}

function gitError(what: string, result: GitResult): ScopeCheck {
  return scopeError('git-failed', `git ${what} failed: ${describeGitFailure(result)}`);
}

function nulList(output: string): string[] {
  return output.split('\u0000').filter((item) => item.length > 0);
}

async function treePaths(ctx: RepoContext, treeish: string): Promise<string[] | GitResult> {
  const result = await repoGit(ctx, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', treeish]);
  return result.code === 0 ? nulList(result.stdout) : result;
}

/** Problems that would make git in this worktree read something other than the task's own setup. */
async function unsafeWorktree(ctx: RepoContext, wt: TaskWorktree, maxEntries: number): Promise<ScopeError | null> {
  const links = checkWorktreeLinks(wt, ctx.commonDir, ctx.caseInsensitivePaths);
  if (links.length > 0) return { code: 'worktree-tampered', message: links.map((l) => l.message).join(' ') };
  if (readControlFile(join(wt.adminDir, 'config.worktree')) !== null) {
    return { code: 'worktree-tampered', message: 'A per-worktree config file appeared; git would read settings from it.' };
  }
  const scan = await scanForNestedGit(wt.path, maxEntries);
  if (scan.findings.length > 0) {
    return { code: 'nested-git', message: `Nested git folders: ${scan.findings.map((x) => x.path).join(', ')}.` };
  }
  if (!scan.complete) return { code: 'nested-git', message: 'The worktree could not be fully scanned for nested git folders.' };
  return null;
}

export async function checkScope(
  ctx: RepoContext,
  wt: TaskWorktree,
  task: ScopeTask,
  opts: ScopeOptions,
): Promise<ScopeCheck> {
  const { fromCommit } = opts;
  if (!FULL_SHA.test(fromCommit)) return scopeError('bad-commit', `"${fromCommit}" is not a full commit id.`);
  const unsafe = await unsafeWorktree(ctx, wt, opts.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES);
  if (unsafe !== null) return { ok: false, error: unsafe };

  const fromTree = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', `${fromCommit}^{tree}`]);
  if (fromTree.code !== 0) return scopeError('bad-commit', `Commit ${fromCommit} is not in this repository.`);

  const indexDir = await mkdtemp(join(tmpdir(), 'orch-index-'));
  const inWorktree = (args: readonly string[]): Promise<GitResult> =>
    worktreeGit(ctx, wt, args, { indexFile: join(indexDir, 'index'), timeoutMs: LONG_GIT_TIMEOUT_MS });
  let tree: string;
  let ignoredPaths: string[];
  try {
    const read = await inWorktree(['read-tree', fromCommit]);
    if (read.code !== 0) return gitError('read-tree', read);
    const add = await inWorktree([`--attr-source=${fromCommit}`, 'add', '--all']);
    if (add.code !== 0) return gitError('add', add);
    const write = await inWorktree(['write-tree']);
    if (write.code !== 0) return gitError('write-tree', write);
    tree = write.stdout.trim();
    const others = await inWorktree(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
    if (others.code !== 0) return gitError('ls-files', others);
    ignoredPaths = nulList(others.stdout);
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }

  const diff = await repoGit(ctx, [...DIFF_ARGS, fromTree.stdout.trim(), tree]);
  if (diff.code !== 0) return gitError('diff-tree', diff);
  const changes = parseRawDiff(diff.stdout);
  let paths: string[] = [];
  if (changes.some((c) => c.status === 'A')) {
    const listed = await treePaths(ctx, tree);
    if (!Array.isArray(listed)) return gitError('ls-tree', listed);
    paths = listed;
  }
  const violations = evaluateScope(task, changes, opts.rules ?? DEFAULT_SCOPE_RULES, paths);

  const owned = task.owns.flatMap((raw) => {
    const parsed = parseOwnsEntry(raw);
    return parsed.ok ? [parsed.entry] : [];
  });
  const ignored = ignoredPaths.map((path) => {
    const nfc = path.normalize('NFC');
    const entry = { path: nfc, key: toKey(nfc), isFolder: nfc.endsWith('/') };
    return { path, owned: owned.some((o) => entriesOverlap(o, entry)) };
  });

  return {
    ok: true,
    report: { clean: violations.length === 0, fromCommit, tree, changes, violations, ignored },
  };
}

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface CommitOptions {
  readonly message: string;
  readonly identity?: CommitIdentity;
  readonly rules?: ScopeRules;
}

export type CommitErrorCode = 'out-of-scope' | 'branch-moved' | 'git-failed' | 'recheck-failed';

export type CommitResult =
  | { ok: true; committed: false; tip: string }
  | { ok: true; committed: true; commit: string; tip: string }
  | { ok: false; error: { code: CommitErrorCode; message: string } };

function commitError(code: CommitErrorCode, message: string): CommitResult {
  return { ok: false, error: { code, message } };
}

/** The message for a task's commit: its title, then the run and task as trailers. */
export function taskCommitMessage(runId: string, task: { readonly id: string; readonly title: string }): string {
  const title = task.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || task.id;
  return `${title}\n\nOrchestra-Run: ${runId}\nOrchestra-Task: ${task.id}\n`;
}

function identityArgs(id: CommitIdentity): string[] {
  // author.* and committer.* outrank user.* in the user's own config; user.* covers older git.
  return ['user', 'author', 'committer'].flatMap((who) => ['-c', `${who}.name=${id.name}`, '-c', `${who}.email=${id.email}`]);
}

/** Reads the new commit back and checks it again. Returns what is wrong, or null. */
async function recheck(
  ctx: RepoContext,
  wt: TaskWorktree,
  task: ScopeTask,
  report: ScopeReport,
  commit: string,
  rules: ScopeRules,
): Promise<string | null> {
  const tip = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', `${wt.ref}^{commit}`]);
  if (tip.code !== 0 || tip.stdout.trim() !== commit) return 'The task branch does not point at the new commit.';
  const tree = await repoGit(ctx, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  if (tree.code !== 0 || tree.stdout.trim() !== report.tree) return 'The new commit does not hold the checked tree.';
  const parents = await repoGit(ctx, ['rev-list', '--parents', '-n', '1', commit]);
  if (parents.code !== 0 || parents.stdout.trim() !== `${commit} ${report.fromCommit}`) {
    return 'The new commit does not have the expected parent.';
  }
  const diff = await repoGit(ctx, [...DIFF_ARGS, report.fromCommit, commit]);
  if (diff.code !== 0) return `git diff-tree failed: ${describeGitFailure(diff)}`;
  const changes = parseRawDiff(diff.stdout);
  const listed = changes.some((c) => c.status === 'A') ? await treePaths(ctx, commit) : [];
  if (!Array.isArray(listed)) return `git ls-tree failed: ${describeGitFailure(listed)}`;
  const violations = evaluateScope(task, changes, rules, listed);
  if (violations.length > 0) return `The commit fails the scope check: ${violations.map((v) => v.message).join(' ')}`;
  const key = (c: TreeChange): string => `${c.status} ${c.newMode} ${c.path}`;
  const expected = report.changes.map(key).sort().join('\n');
  if (changes.map(key).sort().join('\n') !== expected) return "The commit's changes differ from the checked ones.";
  return null;
}

/**
 * Commits a clean scope report on the task branch. Commits nothing when there are no changes, refuses a
 * report with violations, and refuses if the branch moved since the report was made.
 */
export async function commitTask(
  ctx: RepoContext,
  wt: TaskWorktree,
  task: ScopeTask,
  report: ScopeReport,
  opts: CommitOptions,
): Promise<CommitResult> {
  if (!report.clean) {
    return commitError('out-of-scope', `${report.violations.length} problem(s) found by the scope check; nothing was committed.`);
  }
  if (report.changes.length === 0) return { ok: true, committed: false, tip: report.fromCommit };

  const made = await repoGit(
    ctx,
    [...identityArgs(opts.identity ?? ORCHESTRA_GIT_IDENTITY), 'commit-tree', '--no-gpg-sign', report.tree, '-p', report.fromCommit],
    { input: opts.message },
  );
  if (made.code !== 0) return commitError('git-failed', `git commit-tree failed: ${describeGitFailure(made)}`);
  const commit = made.stdout.trim();

  const moved = await repoGit(ctx, ['update-ref', '-m', `orchestra: task ${wt.taskId}`, wt.ref, commit, report.fromCommit]);
  if (moved.code !== 0) {
    return commitError(
      'branch-moved',
      `The task branch ${wt.branch} is no longer at ${report.fromCommit.slice(0, 12)}; nothing was committed.`,
    );
  }

  const problem = await recheck(ctx, wt, task, report, commit, opts.rules ?? DEFAULT_SCOPE_RULES);
  if (problem !== null) {
    const undo = await repoGit(ctx, ['update-ref', wt.ref, report.fromCommit, commit]);
    const after = undo.code === 0 ? 'The branch was moved back.' : `Moving the branch back failed: ${describeGitFailure(undo)}`;
    return commitError('recheck-failed', `${problem} ${after}`);
  }
  return { ok: true, committed: true, commit, tip: commit };
}
