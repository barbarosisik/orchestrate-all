/**
 * The rules manifest (step 11, research §4.5): every agent rule file the run's workers could follow, built before
 * planning. The orchestrator gets this list, not the rule text; the user sees what workers will and won't see;
 * and each brief points its worker at the rule files its engine won't load by itself (applicable.ts).
 *
 * What is listed:
 * - every rule file (names.ts) in the base commit, which is what every worker's worktree holds: path, kind,
 *   folder, size, blob id, whether it is stored as a link (and where the link leads, inside the repository
 *   only), and a Claude rule file's `@imports`;
 * - the files Claude rule files import, and what those import, up to Claude's four hops;
 * - rule files that are only in the user's checkout (untracked or ignored by git): workers never see them;
 * - the user's personal rule files, per engine, and whether workers load them.
 *
 * What is flagged (each with a plain message): a link that worktrees check out as a one-line text file
 * (core.symlinks off, as on most Windows clones); a link leading out of the repository, nowhere, or to another
 * link; an import that is outside, missing or a link; a CLAUDE.md that holds only imports or only another rule
 * file's name; files over what Codex (32 KiB) or Antigravity (24,000 bytes) load, counting Windows line endings;
 * hidden characters; AGENTS.override.md (Codex only); a CLAUDE.md whose text differs from the AGENTS.md beside it;
 * a name in another letter case; a copy in the user's checkout that differs from the committed one; names a brief
 * can't show safely.
 *
 * Links: Orchestra never follows one, and never points a worker at a link or through one. A link that leads out of
 * the repository is the user's to remove: an engine that loads it follows it wherever it leads.
 *
 * Read-only and bounded: files are read from git's object store (each one checked against its id), at most
 * `maxFiles` of them, 1 MiB each and 16 MiB together; the user's copies and personal files are opened without
 * following links. Text taken from the repository (link targets, import names) is quoted and cut short in
 * messages. Credentials are never opened: only rule files and the files they import are read.
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { envFolder } from '../engines/agent-config.js';
import { repoGit, repoGitRaw, worktreeGit, type RepoContext } from '../git/context.js';
import { readVerifiedObjects, type GitObject } from '../git/objects.js';
import { describeGitFailure, LONG_GIT_TIMEOUT_MS } from '../git/run.js';
import { windowsPathIssue } from '../plan/paths.js';
import type { EngineName } from '../plan/schema.js';
import { canonicalPath, samePath } from '../repo/canonical.js';
import { parseStatusZ } from '../repo/status.js';
import { readFileCapped } from '../store/files.js';
import { findAdminDir } from '../worktree/links.js';
import { findHidden, showHidden } from './hidden.js';
import { claudeImports, importsOnly, resolveRepoPath, type RuleImport } from './imports.js';
import { classifyRulePath, ruleNamePathspecs, type RuleName } from './names.js';

/** Codex stops adding project rule files once they reach this many bytes together. */
export const CODEX_RULES_CAP = 32 * 1024;
/** Antigravity cuts each rule file at this many bytes. */
export const ANTIGRAVITY_RULES_CAP = 24_000;
export const DEFAULT_MAX_RULE_FILES = 500;
/** Larger files are listed but not read. */
export const MAX_RULE_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024;
/** The listing of the base commit's files; a larger one means a repository Orchestra can't check. */
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
/** Claude Code follows imports this many hops deep. */
export const MAX_IMPORT_HOPS = 4;
const MAX_LINK_TARGET_CHARS = 1024;
const MAX_SHOWN_CHARS = 200;
const MAX_GLOBAL_RULE_FILES = 200;
const LINK_MODE = '120000';
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Characters that make a name unsafe to show in a brief or to open on Windows (U+FFFD: a name that wasn't UTF-8). */
const ODD_NAME = /[\u0000-\u001f\u007f<>`\\:\uFFFD]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const RULE_FLAG_CODES = [
  'not-in-worktree',
  'uncommitted-changes',
  'link-as-text',
  'link-outside',
  'link-missing',
  'leads-to-link',
  'pointer-only',
  'over-codex-cap',
  'over-antigravity-cap',
  'hidden-unicode',
  'codex-only',
  'differs-from-agents',
  'name-case',
  'import-outside',
  'import-missing',
  'unchecked',
  'odd-name',
] as const;
export type RuleFlagCode = (typeof RULE_FLAG_CODES)[number];

export interface RuleFlag {
  readonly code: RuleFlagCode;
  readonly message: string;
}

export type RuleSource = 'committed' | 'untracked' | 'ignored';

export interface ManifestImport extends RuleImport {
  /** The imported file is a regular file in the base commit (not a link); `path` is then its stored spelling. */
  readonly exists: boolean;
}

export interface RuleFileEntry extends RuleName {
  /** Repo-relative, "/" separators, as stored. */
  readonly path: string;
  /** In the base commit (every worker has it), or only in the user's checkout. */
  readonly source: RuleSource;
  /** The blob id in the base commit; null when not committed. */
  readonly id: string | null;
  /** Bytes (for a link, the length of what it points to); null when unknown. */
  readonly size: number | null;
  /** Line breaks without a carriage return: the bytes Windows line endings add. Null when not read. */
  readonly lineBreaks: number | null;
  /**
   * Stored as a link: what it points to as written, and the regular file in the repository it resolves to (null
   * when it leads outside, nowhere, or to another link).
   */
  readonly link: { readonly target: string; readonly resolved: string | null } | null;
  /** A plain file whose whole text names another rule file (a link checked out as text and committed so). */
  readonly pointsTo: string | null;
  readonly imports: readonly ManifestImport[];
  /** A Claude rule file that holds nothing but imports. */
  readonly importsOnly: boolean;
  readonly flags: readonly RuleFlag[];
}

/** A file a Claude rule file imports (directly or through other imports) that is not a rule file itself. */
export interface ImportedFile {
  readonly path: string;
  readonly id: string;
  readonly size: number;
  /** The files that import it. */
  readonly importedBy: readonly string[];
  readonly imports: readonly ManifestImport[];
  readonly flags: readonly RuleFlag[];
}

export interface GlobalRuleFile {
  readonly engine: EngineName;
  /** Absolute path. */
  readonly path: string;
  /** Whether workers of that engine load it (Claude workers run with project settings only). */
  readonly loadedByWorkers: boolean;
  /** Bytes; null for a link, which is not opened. */
  readonly size: number | null;
  readonly link: boolean;
  readonly flags: readonly RuleFlag[];
}

export interface RulesManifest {
  readonly baseSha: string;
  /** Worktrees check links out as small text files holding the target's name (core.symlinks off). */
  readonly linksAsText: boolean;
  /** Sorted by path. */
  readonly files: readonly RuleFileEntry[];
  /** Sorted by path. */
  readonly imported: readonly ImportedFile[];
  /** Claude, Codex, then Antigravity. */
  readonly globals: readonly GlobalRuleFile[];
  /** What could not be checked; the manifest is still usable. */
  readonly problems: readonly string[];
}

export interface ManifestOptions {
  /** The run's base commit. */
  readonly baseSha: string;
  /** The user's home folder (os.homedir() for a real run; tests pass a temp folder). */
  readonly home: string;
  /** The environment, for CLAUDE_CONFIG_DIR and CODEX_HOME. */
  readonly env: NodeJS.ProcessEnv;
  /** Overrides what core.symlinks says (tests). */
  readonly linksAsText?: boolean;
  /** Files read at most (rule files first, then imported ones); the rest are listed unchecked. */
  readonly maxFiles?: number;
  /** Bytes read at most, all together (tests; defaults to 16 MiB). */
  readonly maxTotalBytes?: number;
}

export type ManifestResult = { ok: true; manifest: RulesManifest } | { ok: false; problem: string };

interface TreeBlob {
  readonly mode: string;
  readonly id: string;
  readonly size: number;
  readonly path: string;
}

/** The base commit's files: every blob by key, and the rule files among them. */
interface Tree {
  readonly blobs: ReadonlyMap<string, TreeBlob>;
  readonly rules: readonly TreeBlob[];
  readonly key: (path: string) => string;
}

interface Budget {
  readonly maxFiles: number;
  readonly maxBytes: number;
  files: number;
  bytes: number;
}

interface Draft {
  readonly blob: TreeBlob;
  readonly name: RuleName;
  text: string | null;
  lineBreaks: number | null;
  link: RuleFileEntry['link'];
  pointsTo: string | null;
  imports: ManifestImport[];
  importsOnly: boolean;
  flags: RuleFlag[];
}

interface ImportDraft {
  readonly blob: TreeBlob;
  readonly importedBy: string[];
  imports: ManifestImport[];
  flags: RuleFlag[];
}

function flag(code: RuleFlagCode, message: string): RuleFlag {
  return { code, message };
}

function byPath<T>(a: T & { readonly path: string }, b: T & { readonly path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function folderOfFile(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * True for names a brief can't show safely or Windows can't open: control and hidden characters, < > ` \\ : and the
 * other characters Windows refuses, device names (CON, AUX.md, ...), short names, names ending in a dot or space,
 * and empty or dot segments. Such files are listed but never read from the checkout or pointed at.
 */
export function isOddName(path: string): boolean {
  return ODD_NAME.test(path) || windowsPathIssue(path) !== null || findHidden(path).count > 0 || path.split('/').some((s) => s === '.' || s === '..');
}

/** A path as messages show it: quoted, with escapes, when its name is odd. */
export function shownPath(path: string): string {
  return isOddName(path) ? JSON.stringify(showHidden(path)) : path;
}

/** Text from the repository (a link's target, an import's name) as messages show it: quoted, escaped, cut short. */
export function shownText(text: string): string {
  const chars = Array.from(text);
  return JSON.stringify(showHidden(chars.length > MAX_SHOWN_CHARS ? `${chars.slice(0, MAX_SHOWN_CHARS).join('')}…` : text));
}

function shownList(items: readonly string[]): string {
  const shown = items.slice(0, 5).map(shownText).join(', ');
  return items.length > 5 ? `${shown} and ${items.length - 5} more` : shown;
}

function sameText(a: string, b: string): boolean {
  const plain = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return plain(a) === plain(b);
}

function decodeUtf8(content: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

/** Line feeds without a carriage return before them. */
function bareLineBreaks(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) if (text[i - 1] !== '\r') count += 1;
  return count;
}

function parseLsTree(output: Buffer, key: (path: string) => string): Tree {
  const rules: TreeBlob[] = [];
  const blobs = new Map<string, TreeBlob>();
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(0, start);
    if (end === -1) end = output.length;
    const record = output.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) continue;
    const header = /^(\d{6}) (\w+) ([0-9a-f]+) +(-|\d+)$/.exec(record.subarray(0, tab).toString('latin1'));
    if (header === null || header[2] !== 'blob') continue;
    const blob = { mode: header[1] as string, id: header[3] as string, size: Number(header[4]), path: record.subarray(tab + 1).toString('utf8') };
    blobs.set(key(blob.path), blob);
    if (classifyRulePath(blob.path) !== null) rules.push(blob);
  }
  return { blobs, rules: rules.sort(byPath), key };
}

/** The regular file (not a link) at a repo-relative path in the base commit, or undefined. */
function regularFile(tree: Tree, path: string): TreeBlob | undefined {
  const blob = tree.blobs.get(tree.key(path));
  return blob !== undefined && blob.mode !== LINK_MODE ? blob : undefined;
}

async function linksCheckedOutAsText(ctx: RepoContext, problems: string[]): Promise<boolean> {
  const result = await repoGit(ctx, ['config', '--type=bool', '--get', 'core.symlinks']);
  if (result.code === 0) return result.stdout.trim() === 'false';
  // Unset: git's default is true, except that Git for Windows checks links out as text unless told otherwise.
  if (result.code !== 1) problems.push(`core.symlinks could not be read (${describeGitFailure(result)}).`);
  return process.platform === 'win32';
}

/** Why a file of this size can't be read within the budget, or null (and the budget is spent on it). */
function spend(budget: Budget, size: number): string | null {
  if (size > MAX_RULE_FILE_BYTES) return `it is larger than ${MAX_RULE_FILE_BYTES} bytes`;
  if (budget.files >= budget.maxFiles) return `the run reads at most ${budget.maxFiles} files`;
  if (budget.bytes + size > budget.maxBytes) return `the run reads at most ${budget.maxBytes} bytes of rule files`;
  budget.files += 1;
  budget.bytes += size;
  return null;
}

async function readBlobs(ctx: RepoContext, blobs: readonly TreeBlob[]): Promise<{ ok: true; objects: Map<string, GitObject> } | { ok: false; problem: string }> {
  const read = await readVerifiedObjects(ctx, [...new Set(blobs.map((b) => b.id))]);
  return read.ok ? read : { ok: false, problem: `The rule files could not be read from git: ${read.problem.message}` };
}

/** A file's imports, resolved against the base commit, with the flags they call for. */
function resolveImports(tree: Tree, path: string, text: string, flags: RuleFlag[]): ManifestImport[] {
  const imports = claudeImports(text, path).map((i): ManifestImport => {
    const file = i.path === null ? undefined : regularFile(tree, i.path);
    return file === undefined ? { ...i, exists: false } : { ...i, path: file.path, exists: true };
  });
  const outside = imports.filter((i) => i.external).map((i) => i.raw);
  const links = imports.filter((i) => i.path !== null && tree.blobs.get(tree.key(i.path))?.mode === LINK_MODE).map((i) => i.raw);
  const missing = imports.filter((i) => !i.external && !i.exists && !links.includes(i.raw)).map((i) => i.raw);
  if (outside.length > 0) flags.push(flag('import-outside', `${shownPath(path)} imports ${shownList(outside)}, outside the repository: workers on other engines can't read it.`));
  if (links.length > 0) {
    flags.push(flag('leads-to-link', `${shownPath(path)} imports ${shownList(links)}, which is a link: Claude Code follows it wherever it leads; other workers are not pointed at it.`));
  }
  if (missing.length > 0) flags.push(flag('import-missing', `${shownPath(path)} imports ${shownList(missing)}, which is not in the repository.`));
  return imports;
}

function hiddenFlag(path: string, text: string, flags: RuleFlag[]): void {
  const hidden = findHidden(text);
  if (hidden.count > 0) {
    flags.push(flag('hidden-unicode', `${shownPath(path)} has ${hidden.count} hidden character(s) (${hidden.codes.join(', ')}): text a reader can't see but a model reads. Check it before running workers.`));
  }
}

function linkFlags(tree: Tree, draft: Draft, target: string, linksAsText: boolean): void {
  const { path } = draft.blob;
  const usable = target.length > 0 && target.length <= MAX_LINK_TARGET_CHARS && !CONTROL.test(target) && findHidden(target).count === 0;
  const resolved = usable ? resolveRepoPath(folderOfFile(path), target) : null;
  const hit = resolved === null ? undefined : tree.blobs.get(tree.key(resolved));
  draft.link = { target, resolved: hit !== undefined && hit.mode !== LINK_MODE ? hit.path : null };
  if (resolved === null) {
    draft.flags.push(
      flag(
        'link-outside',
        linksAsText
          ? `${shownPath(path)} is a link to ${shownText(target)}, outside the repository. Worktrees hold it as a one-line text file, and workers are not pointed at what it names.`
          : `${shownPath(path)} is a link to ${shownText(target)}, outside the repository: an engine that loads ${shownPath(path)} follows it to that file on this computer, which may hold secrets. Remove the link before running workers on this repository.`,
      ),
    );
  } else if (hit === undefined) draft.flags.push(flag('link-missing', `${shownPath(path)} is a link to ${shownText(target)}, which is not in the repository.`));
  else if (hit.mode === LINK_MODE) {
    draft.flags.push(flag('leads-to-link', `${shownPath(path)} is a link to ${shownPath(hit.path)}, which is a link itself; workers are not pointed through it.`));
  }
  if (linksAsText) {
    draft.flags.push(flag('link-as-text', `${shownPath(path)} is a link, and this repository checks links out as one-line text files (core.symlinks is off): an engine reading it gets only ${shownText(target)}.`));
  }
}

/** Reads the rule files (within the budget), then fills in what their text says. */
async function readDrafts(ctx: RepoContext, tree: Tree, drafts: readonly Draft[], linksAsText: boolean, budget: Budget): Promise<string | null> {
  const wanted: Draft[] = [];
  for (const draft of drafts) {
    if (draft.flags.length > 0) continue;
    const why = spend(budget, draft.blob.size);
    if (why === null) wanted.push(draft);
    else draft.flags.push(flag('unchecked', `${shownPath(draft.blob.path)} was not read (${why}), so it was not checked.`));
  }
  const read = await readBlobs(ctx, wanted.map((d) => d.blob));
  if (!read.ok) return read.problem;

  for (const draft of wanted) {
    const { path, mode } = draft.blob;
    const text = decodeUtf8(read.objects.get(draft.blob.id)?.content ?? Buffer.alloc(0));
    if (text === null) {
      draft.flags.push(flag('unchecked', `${shownPath(path)} is not UTF-8 text, so it was not checked.`));
      continue;
    }
    if (mode === LINK_MODE) {
      linkFlags(tree, draft, text, linksAsText);
      continue;
    }
    draft.text = text;
    draft.lineBreaks = bareLineBreaks(text);
    hiddenFlag(path, text, draft.flags);
    if (draft.name.family === 'claude') {
      draft.imports = resolveImports(tree, path, text, draft.flags);
      draft.importsOnly = importsOnly(text);
    }
    if (draft.importsOnly) {
      draft.flags.push(flag('pointer-only', `${shownPath(path)} only imports other files; engines that don't follow Claude's imports get nothing from it.`));
    } else {
      const named = text.trim();
      const target = named.length > 0 && named.length <= MAX_LINK_TARGET_CHARS && !/\s/.test(named) ? resolveRepoPath(folderOfFile(path), named) : null;
      const file = target === null ? undefined : regularFile(tree, target);
      if (file !== undefined && classifyRulePath(file.path) !== null) {
        draft.pointsTo = file.path;
        draft.flags.push(flag('pointer-only', `${shownPath(path)} holds only the name ${shownText(named)}: probably a link that was checked out as text and committed so.`));
      }
    }
  }
  return null;
}

/** The files Claude rule files import (not rule files themselves), and theirs, up to Claude's four hops. */
async function readImported(ctx: RepoContext, tree: Tree, drafts: readonly Draft[], budget: Budget): Promise<{ ok: true; imported: ImportDraft[] } | { ok: false; problem: string }> {
  const found = new Map<string, ImportDraft>();
  let hop: { path: string; by: string }[] = drafts.flatMap((d) => d.imports.filter((i) => i.exists).map((i) => ({ path: i.path as string, by: d.blob.path })));
  for (let depth = 1; depth <= MAX_IMPORT_HOPS && hop.length > 0; depth++) {
    const fresh: ImportDraft[] = [];
    for (const { path, by } of hop) {
      const known = found.get(tree.key(path));
      if (known !== undefined) {
        if (!known.importedBy.includes(by)) known.importedBy.push(by);
        continue;
      }
      const blob = regularFile(tree, path);
      if (blob === undefined || classifyRulePath(blob.path) !== null || isOddName(blob.path)) continue;
      const draft: ImportDraft = { blob, importedBy: [by], imports: [], flags: [] };
      found.set(tree.key(path), draft);
      const why = spend(budget, blob.size);
      if (why === null) fresh.push(draft);
      else draft.flags.push(flag('unchecked', `${shownPath(blob.path)} was not read (${why}), so it was not checked.`));
    }
    const read = await readBlobs(ctx, fresh.map((d) => d.blob));
    if (!read.ok) return read;
    hop = [];
    for (const draft of fresh) {
      const text = decodeUtf8(read.objects.get(draft.blob.id)?.content ?? Buffer.alloc(0));
      if (text === null) {
        draft.flags.push(flag('unchecked', `${shownPath(draft.blob.path)} is not UTF-8 text, so it was not checked.`));
        continue;
      }
      hiddenFlag(draft.blob.path, text, draft.flags);
      draft.imports = resolveImports(tree, draft.blob.path, text, draft.flags);
      if (depth < MAX_IMPORT_HOPS) hop.push(...draft.imports.filter((i) => i.exists).map((i) => ({ path: i.path as string, by: draft.blob.path })));
    }
  }
  return { ok: true, imported: [...found.values()] };
}

function sizeFlags(draft: Draft): void {
  const { kind, family } = draft.name;
  const { path, size, mode } = draft.blob;
  if (mode === LINK_MODE) return;
  const onWindows = size + (draft.lineBreaks ?? 0);
  const bytes = onWindows === size ? `${size} bytes` : `${size} bytes (${onWindows} with Windows line endings)`;
  if ((kind === 'AGENTS.md' || kind === 'AGENTS.override.md') && onWindows > CODEX_RULES_CAP) {
    draft.flags.push(flag('over-codex-cap', `${shownPath(path)} is ${bytes}; Codex loads at most ${CODEX_RULES_CAP} bytes of project rules, so Codex workers are told to read it in full.`));
  }
  if ((kind === 'AGENTS.md' || family === 'gemini') && onWindows > ANTIGRAVITY_RULES_CAP) {
    draft.flags.push(flag('over-antigravity-cap', `${shownPath(path)} is ${bytes}; Antigravity cuts rule files at ${ANTIGRAVITY_RULES_CAP} bytes, so its workers are told to read it in full.`));
  }
}

/** A CLAUDE.md beside an AGENTS.md, with other text and no import of it: engines follow different rules. */
function differsFlags(tree: Tree, drafts: readonly Draft[]): void {
  const agentsByFolder = new Map<string, Draft>();
  for (const d of drafts) if (d.name.kind === 'AGENTS.md' && d.text !== null) agentsByFolder.set(tree.key(d.name.folder), d);
  for (const claude of drafts) {
    if (claude.text === null || (claude.name.kind !== 'CLAUDE.md' && claude.name.kind !== '.claude/CLAUDE.md')) continue;
    const agents = agentsByFolder.get(tree.key(claude.name.folder));
    if (agents === undefined || agents.text === null) continue;
    const agentsKey = tree.key(agents.blob.path);
    if (claude.imports.some((i) => i.exists && tree.key(i.path as string) === agentsKey)) continue;
    if (claude.pointsTo !== null || sameText(claude.text, agents.text)) continue;
    claude.flags.push(
      flag(
        'differs-from-agents',
        `${shownPath(claude.blob.path)} and ${shownPath(agents.blob.path)} hold different text, and ${shownPath(claude.blob.path)} doesn't import ${shownPath(agents.blob.path)}: Claude workers follow both, Codex and Antigravity workers only ${shownPath(agents.blob.path)}.`,
      ),
    );
  }
}

/** The git folder of the user's checkout: the shared one for the main checkout, else its admin folder. */
function checkoutGitDir(ctx: RepoContext): string | null {
  const own = canonicalPath(join(ctx.repoRoot, '.git'));
  if (own !== null && samePath(own, ctx.commonDir, ctx.caseInsensitivePaths)) return ctx.commonDir;
  return findAdminDir(ctx.commonDir, ctx.repoRoot, ctx.caseInsensitivePaths);
}

/** Flags committed rule files whose copy in the user's checkout differs (line endings aside). */
async function compareCheckout(ctx: RepoContext, drafts: readonly Draft[]): Promise<void> {
  for (const draft of drafts) {
    if (draft.text === null) continue;
    const { path } = draft.blob;
    const local = await readFileCapped(join(ctx.repoRoot, ...path.split('/')), MAX_RULE_FILE_BYTES);
    if (!local.ok) {
      if (local.problem.code === 'missing') {
        draft.flags.push(flag('uncommitted-changes', `${shownPath(path)} is missing from your checkout; workers get the committed version.`));
      }
      continue;
    }
    const text = decodeUtf8(local.value);
    if (text === null || !sameText(text, draft.text)) {
      draft.flags.push(flag('uncommitted-changes', `Your copy of ${shownPath(path)} differs from the committed one; workers get the committed version. Commit your changes first if workers should follow them.`));
    }
  }
}

/** Rule files only in the user's checkout (untracked or ignored by git). */
async function localOnly(ctx: RepoContext, tree: Tree, problems: string[]): Promise<RuleFileEntry[]> {
  const gitDir = checkoutGitDir(ctx);
  if (gitDir === null) {
    problems.push(`Could not find git's folder for ${ctx.repoRoot}, so rule files that are only in your checkout are not listed.`);
    return [];
  }
  const status = await worktreeGit(
    ctx,
    { path: ctx.repoRoot, adminDir: gitDir },
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', ...ruleNamePathspecs()],
    { timeoutMs: LONG_GIT_TIMEOUT_MS },
  );
  if (status.code !== 0) {
    problems.push(`git status failed (${describeGitFailure(status)}), so rule files that are only in your checkout are not listed.`);
    return [];
  }
  const entries: RuleFileEntry[] = [];
  for (const dirty of parseStatusZ(status.stdout)) {
    if (dirty.state !== 'untracked' && dirty.state !== 'ignored') continue;
    const name = classifyRulePath(dirty.path);
    if (name === null || tree.blobs.has(tree.key(dirty.path))) continue;
    let size: number | null = null;
    if (!isOddName(dirty.path)) {
      try {
        size = (await lstat(join(ctx.repoRoot, ...dirty.path.split('/')))).size;
      } catch {
        size = null;
      }
    }
    const how = dirty.state === 'ignored' ? 'ignored by git' : 'not committed';
    entries.push({
      ...name,
      path: dirty.path,
      source: dirty.state,
      id: null,
      size,
      lineBreaks: null,
      link: null,
      pointsTo: null,
      imports: [],
      importsOnly: false,
      flags: [flag('not-in-worktree', `${shownPath(dirty.path)} is ${how}, so workers won't see it. Commit it first if workers should follow it.`)],
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------
// Personal rule files.

interface GlobalCandidate {
  readonly engine: EngineName;
  readonly path: string;
  readonly loaded: boolean | 'first-non-empty';
}

async function markdownFiles(folder: string, depth: number, found: string[]): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(folder)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (found.length >= MAX_GLOBAL_RULE_FILES) return;
    const path = join(folder, name);
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    if (info.isDirectory() && depth > 0) await markdownFiles(path, depth - 1, found);
    else if ((info.isFile() || info.isSymbolicLink()) && name.toLowerCase().endsWith('.md')) found.push(path);
  }
}

async function globalCandidates(home: string, env: NodeJS.ProcessEnv): Promise<GlobalCandidate[]> {
  const claude = envFolder(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude');
  const codex = envFolder(env, 'CODEX_HOME') ?? join(home, '.codex');
  const gemini = join(home, '.gemini');
  const claudeRules: string[] = [];
  await markdownFiles(join(claude, 'rules'), 3, claudeRules);
  const geminiRules: string[] = [];
  await markdownFiles(join(gemini, 'config', 'rules'), 0, geminiRules);
  return [
    // Claude workers run with `--setting-sources project`: the user's own CLAUDE.md and rules are left out.
    { engine: 'claude', path: join(claude, 'CLAUDE.md'), loaded: false },
    ...claudeRules.map((path) => ({ engine: 'claude' as const, path, loaded: false })),
    // Codex uses the first non-empty of the two.
    { engine: 'codex', path: join(codex, 'AGENTS.override.md'), loaded: 'first-non-empty' },
    { engine: 'codex', path: join(codex, 'AGENTS.md'), loaded: 'first-non-empty' },
    ...['AGENTS.md', 'GEMINI.md', join('config', 'AGENTS.md'), join('config', 'GEMINI.md')].map((name) => ({ engine: 'antigravity' as const, path: join(gemini, name), loaded: true })),
    ...geminiRules.map((path) => ({ engine: 'antigravity' as const, path, loaded: true })),
  ];
}

async function personalRuleFiles(home: string, env: NodeJS.ProcessEnv): Promise<GlobalRuleFile[]> {
  const files: GlobalRuleFile[] = [];
  let codexChosen = false;
  for (const candidate of await globalCandidates(home, env)) {
    let info;
    try {
      info = await lstat(candidate.path);
    } catch {
      continue;
    }
    const link = info.isSymbolicLink();
    if (!link && (!info.isFile() || info.size === 0)) continue;
    let loaded: boolean;
    if (candidate.loaded === 'first-non-empty') {
      loaded = !codexChosen;
      codexChosen = true;
    } else loaded = candidate.loaded;
    const flags: RuleFlag[] = [];
    if (!link) {
      const read = await readFileCapped(candidate.path, MAX_RULE_FILE_BYTES);
      const text = read.ok ? decodeUtf8(read.value) : null;
      if (text === null) flags.push(flag('unchecked', `${candidate.path} could not be read as text, so it was not checked.`));
      else hiddenFlag(candidate.path, text, flags);
    }
    files.push({ engine: candidate.engine, path: candidate.path, loadedByWorkers: loaded, size: link ? null : info.size, link, flags });
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------

/** Builds the rules manifest for a run's base commit. */
export async function buildRulesManifest(ctx: RepoContext, opts: ManifestOptions): Promise<ManifestResult> {
  if (!FULL_SHA.test(opts.baseSha)) return { ok: false, problem: `"${opts.baseSha}" is not a full commit id.` };
  const key = (path: string): string => {
    const normal = path.normalize('NFC');
    return ctx.caseInsensitivePaths ? normal.toLowerCase() : normal;
  };
  const problems: string[] = [];

  const listing = await repoGitRaw(ctx, ['ls-tree', '-r', '-z', '-l', '--full-tree', opts.baseSha], { timeoutMs: LONG_GIT_TIMEOUT_MS, maxStdoutBytes: MAX_LISTING_BYTES });
  if (listing.truncated === true) return { ok: false, problem: `The list of files in ${opts.baseSha.slice(0, 12)} is larger than ${MAX_LISTING_BYTES} bytes, too many for Orchestra to check.` };
  if (listing.code !== 0) return { ok: false, problem: `git ls-tree failed for ${opts.baseSha.slice(0, 12)}: ${describeGitFailure(listing)}` };
  const tree = parseLsTree(listing.stdout, key);
  const linksAsText = opts.linksAsText ?? (await linksCheckedOutAsText(ctx, problems));
  const budget: Budget = { maxFiles: opts.maxFiles ?? DEFAULT_MAX_RULE_FILES, maxBytes: opts.maxTotalBytes ?? MAX_TOTAL_READ_BYTES, files: 0, bytes: 0 };

  const drafts: Draft[] = tree.rules.map((blob) => ({
    blob,
    name: classifyRulePath(blob.path) as RuleName,
    text: null,
    lineBreaks: null,
    link: null,
    pointsTo: null,
    imports: [],
    importsOnly: false,
    flags: isOddName(blob.path) ? [flag('odd-name', `${shownPath(blob.path)} has a name a brief can't show safely or Windows can't open; workers are not pointed at it.`)] : [],
  }));
  const failed = await readDrafts(ctx, tree, drafts, linksAsText, budget);
  if (failed !== null) return { ok: false, problem: failed };
  const imported = await readImported(ctx, tree, drafts, budget);
  if (!imported.ok) return imported;
  for (const draft of drafts) {
    if (draft.flags.some((f) => f.code === 'odd-name')) continue;
    sizeFlags(draft);
    if (draft.name.kind === 'AGENTS.override.md') {
      draft.flags.push(flag('codex-only', `${shownPath(draft.blob.path)} is read by Codex only, instead of the AGENTS.md in its folder; other engines don't see it.`));
    }
    if (draft.name.nameCase) {
      draft.flags.push(flag('name-case', `${shownPath(draft.blob.path)} differs in letter case from the name engines look for: only engines on Windows and macOS find it.`));
    }
  }
  differsFlags(tree, drafts);
  await compareCheckout(ctx, drafts);

  const committed: RuleFileEntry[] = drafts.map((d) => ({
    ...d.name,
    path: d.blob.path,
    source: 'committed',
    id: d.blob.id,
    size: d.blob.size,
    lineBreaks: d.lineBreaks,
    link: d.link,
    pointsTo: d.pointsTo,
    imports: d.imports,
    importsOnly: d.importsOnly,
    flags: d.flags,
  }));
  const files = [...committed, ...(await localOnly(ctx, tree, problems))].sort(byPath);
  const importedFiles: ImportedFile[] = imported.imported
    .map((d) => ({ path: d.blob.path, id: d.blob.id, size: d.blob.size, importedBy: d.importedBy, imports: d.imports, flags: d.flags }))
    .sort(byPath);
  const globals = await personalRuleFiles(opts.home, opts.env);
  return { ok: true, manifest: { baseSha: opts.baseSha, linksAsText, files, imported: importedFiles, globals, problems } };
}
