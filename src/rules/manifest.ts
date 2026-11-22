/**
 * The rules manifest (step 11, research §4.5): every agent rule file the run's workers could follow, built before
 * planning. The orchestrator gets this list, not the rule text; the user sees what workers will and won't see;
 * and each brief points its worker at the rule files its engine won't load by itself (applicable.ts).
 *
 * What is listed:
 * - every rule file (names.ts) in the base commit, which is what every worker's worktree holds: path, kind,
 *   folder, size, blob id, whether it is stored as a link (and where the link leads, inside the repository
 *   only), and a CLAUDE.md's `@imports`;
 * - rule files that are only in the user's checkout (untracked or ignored by git): workers never see them;
 * - the user's personal rule files, per engine, and whether workers load them.
 *
 * What is flagged (each with a plain message): a link that worktrees check out as a one-line text file
 * (core.symlinks off, as on most Windows clones); a link or import leading out of the repository or nowhere; a
 * CLAUDE.md that holds only imports or only another rule file's name; files over what Codex (32 KiB) or
 * Antigravity (24,000 bytes) load; hidden characters; AGENTS.override.md (Codex only); a CLAUDE.md whose text
 * differs from the AGENTS.md beside it; a name in another letter case; a copy in the user's checkout that
 * differs from the committed one; names a brief can't show safely.
 *
 * Read-only and bounded: rule files are read from git's object store (each one checked against its id), at most
 * `maxFiles` of them and 1 MiB each; the user's copies and personal files are opened without following links.
 * Credentials are never opened: only rule files are read.
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { envFolder } from '../engines/agent-config.js';
import { repoGit, repoGitRaw, worktreeGit, type RepoContext } from '../git/context.js';
import { readVerifiedObjects } from '../git/objects.js';
import { describeGitFailure, LONG_GIT_TIMEOUT_MS } from '../git/run.js';
import { windowsPathIssue } from '../plan/paths.js';
import type { EngineName } from '../plan/schema.js';
import { canonicalPath, samePath } from '../repo/canonical.js';
import { parseStatusZ } from '../repo/status.js';
import { readFileCapped } from '../store/files.js';
import { findAdminDir } from '../worktree/links.js';
import { findHidden } from './hidden.js';
import { claudeImports, importsOnly, resolveRepoPath, type RuleImport } from './imports.js';
import { classifyRulePath, ruleNamePathspecs, type RuleName } from './names.js';

/** Codex stops adding project rule files once they reach this many bytes together. */
export const CODEX_RULES_CAP = 32 * 1024;
/** Antigravity cuts each rule file at this many bytes. */
export const ANTIGRAVITY_RULES_CAP = 24_000;
export const DEFAULT_MAX_RULE_FILES = 500;
/** Larger rule files are listed but not read. */
export const MAX_RULE_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024;
const MAX_GLOBAL_RULE_FILES = 200;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Characters that make a name unsafe to show in a brief or to open on Windows. */
const ODD_NAME = /[\u0000-\u001f\u007f<>`\\:�]/;

export const RULE_FLAG_CODES = [
  'not-in-worktree',
  'uncommitted-changes',
  'link-as-text',
  'link-outside',
  'link-missing',
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
  /** The imported file is in the base commit. */
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
  /** Stored as a link: what it points to as written, and resolved (null when outside the repository or missing). */
  readonly link: { readonly target: string; readonly resolved: string | null } | null;
  /** A plain file whose whole text names another rule file (a link checked out as text and committed so). */
  readonly pointsTo: string | null;
  readonly imports: readonly ManifestImport[];
  /** A Claude rule file that holds nothing but imports. */
  readonly importsOnly: boolean;
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
  /** Rule files read at most; the rest are listed unchecked. Defaults to DEFAULT_MAX_RULE_FILES. */
  readonly maxFiles?: number;
  /** Bytes of rule files read at most, all together (tests; defaults to 16 MiB). */
  readonly maxTotalBytes?: number;
}

export type ManifestResult = { ok: true; manifest: RulesManifest } | { ok: false; problem: string };

interface TreeBlob {
  readonly mode: string;
  readonly id: string;
  readonly size: number;
  readonly path: string;
}

interface Draft {
  readonly blob: TreeBlob;
  readonly name: RuleName;
  text: string | null;
  link: RuleFileEntry['link'];
  pointsTo: string | null;
  imports: ManifestImport[];
  importsOnly: boolean;
  flags: RuleFlag[];
}

function flag(code: RuleFlagCode, message: string): RuleFlag {
  return { code, message };
}

function folderOfFile(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A path as messages show it: quoted, with escapes, when its name is odd. */
export function shownPath(path: string): string {
  return isOddName(path) ? JSON.stringify(path) : path;
}

/**
 * True for names a brief can't show safely or Windows can't open: control characters, < > ` \\ : and the other
 * characters Windows refuses, device names (CON, AUX.md, ...), short names, names ending in a dot or space, and
 * empty or dot segments. Such files are listed but never read from the checkout or pointed at.
 */
export function isOddName(path: string): boolean {
  return ODD_NAME.test(path) || windowsPathIssue(path) !== null || path.split('/').some((s) => s === '.' || s === '..');
}

function sameText(a: string, b: string): boolean {
  const plain = (text: string): string => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return plain(a) === plain(b);
}

function decodeUtf8(content: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

/** Every blob of the tree (as keys), and the rule files among them. */
function parseLsTree(output: Buffer, key: (path: string) => string): { rules: TreeBlob[]; keys: Set<string> } {
  const rules: TreeBlob[] = [];
  const keys = new Set<string>();
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
    const path = record.subarray(tab + 1).toString('utf8');
    keys.add(key(path));
    if (classifyRulePath(path) !== null) rules.push({ mode: header[1] as string, id: header[3] as string, size: Number(header[4]), path });
  }
  rules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { rules, keys };
}

async function linksCheckedOutAsText(ctx: RepoContext, problems: string[]): Promise<boolean> {
  const result = await repoGit(ctx, ['config', '--type=bool', '--get', 'core.symlinks']);
  if (result.code === 0) return result.stdout.trim() === 'false';
  // Unset: git's default is true, except that Git for Windows checks links out as text unless told otherwise.
  if (result.code !== 1) problems.push(`core.symlinks could not be read (${describeGitFailure(result)}).`);
  return process.platform === 'win32';
}

/** Reads the drafts' blobs (bounded), then fills in what their text says. */
async function readDrafts(
  ctx: RepoContext,
  drafts: Draft[],
  keys: Set<string>,
  key: (path: string) => string,
  linksAsText: boolean,
  maxFiles: number,
  maxTotal: number,
): Promise<string | null> {
  const wanted: Draft[] = [];
  let total = 0;
  for (const draft of drafts) {
    if (draft.flags.length > 0) continue;
    const size = draft.blob.size;
    if (wanted.length >= maxFiles || size > MAX_RULE_FILE_BYTES || total + size > maxTotal) {
      const why =
        size > MAX_RULE_FILE_BYTES
          ? `it is larger than ${MAX_RULE_FILE_BYTES} bytes`
          : wanted.length >= maxFiles
            ? `the run reads at most ${maxFiles} rule files`
            : `the run reads at most ${maxTotal} bytes of rule files`;
      draft.flags.push(flag('unchecked', `${draft.blob.path} was not read (${why}), so it was not checked.`));
      continue;
    }
    wanted.push(draft);
    total += size;
  }
  const read = await readVerifiedObjects(ctx, [...new Set(wanted.map((d) => d.blob.id))]);
  if (!read.ok) return `The rule files could not be read from git: ${read.problem.message}`;

  for (const draft of wanted) {
    const { path, mode } = draft.blob;
    const content = read.objects.get(draft.blob.id)?.content ?? Buffer.alloc(0);
    const text = decodeUtf8(content);
    if (text === null) {
      draft.flags.push(flag('unchecked', `${path} is not UTF-8 text, so it was not checked.`));
      continue;
    }
    if (mode === '120000') {
      const resolved = resolveRepoPath(folderOfFile(path), text);
      const found = resolved !== null && keys.has(key(resolved));
      draft.link = { target: text, resolved: found ? resolved : null };
      if (resolved === null) draft.flags.push(flag('link-outside', `${path} is a link to ${text}, outside the repository: workers can't follow it.`));
      else if (!found) draft.flags.push(flag('link-missing', `${path} is a link to ${text}, which is not in the repository.`));
      if (linksAsText) {
        draft.flags.push(
          flag('link-as-text', `${path} is a link, and this repository checks links out as one-line text files (core.symlinks is off): an engine reading ${path} gets only "${text}".`),
        );
      }
      continue;
    }
    draft.text = text;
    const hidden = findHidden(text);
    if (hidden.count > 0) {
      draft.flags.push(flag('hidden-unicode', `${path} has ${hidden.count} hidden character(s) (${hidden.codes.join(', ')}): text a reader can't see but a model reads. Check it before running workers.`));
    }
    if (draft.name.family === 'claude') {
      draft.imports = claudeImports(text, path).map((i) => ({ ...i, exists: i.path !== null && keys.has(key(i.path)) }));
      draft.importsOnly = importsOnly(text);
      const outside = draft.imports.filter((i) => i.external).map((i) => i.raw);
      const missing = draft.imports.filter((i) => !i.external && !i.exists).map((i) => i.raw);
      if (outside.length > 0) draft.flags.push(flag('import-outside', `${path} imports ${outside.join(', ')}, outside the repository: workers on other engines can't read it.`));
      if (missing.length > 0) draft.flags.push(flag('import-missing', `${path} imports ${missing.join(', ')}, which is not in the repository.`));
    }
    if (draft.importsOnly) {
      draft.flags.push(flag('pointer-only', `${path} only imports other files; engines that don't follow Claude's imports get nothing from it.`));
    } else {
      const named = text.trim();
      const target = named.length > 0 && !/\s/.test(named) ? resolveRepoPath(folderOfFile(path), named) : null;
      if (target !== null && keys.has(key(target)) && classifyRulePath(target) !== null) {
        draft.pointsTo = target;
        draft.flags.push(flag('pointer-only', `${path} holds only the name "${named}": probably a link that was checked out as text and committed so.`));
      }
    }
  }
  return null;
}

function sizeFlags(draft: Draft): void {
  const { kind, family } = draft.name;
  const { path, size, mode } = draft.blob;
  if (mode === '120000') return;
  if ((kind === 'AGENTS.md' || kind === 'AGENTS.override.md') && size > CODEX_RULES_CAP) {
    draft.flags.push(flag('over-codex-cap', `${path} is ${size} bytes; Codex loads at most ${CODEX_RULES_CAP} bytes of project rules, so Codex workers are told to read it in full.`));
  }
  if ((kind === 'AGENTS.md' || family === 'gemini') && size > ANTIGRAVITY_RULES_CAP) {
    draft.flags.push(flag('over-antigravity-cap', `${path} is ${size} bytes; Antigravity cuts rule files at ${ANTIGRAVITY_RULES_CAP} bytes, so its workers are told to read it in full.`));
  }
}

/** A CLAUDE.md beside an AGENTS.md, with other text and no import of it: engines follow different rules. */
function differsFlags(drafts: readonly Draft[], key: (path: string) => string): void {
  for (const claude of drafts) {
    if (claude.text === null || (claude.name.kind !== 'CLAUDE.md' && claude.name.kind !== '.claude/CLAUDE.md')) continue;
    const agents = drafts.find((d) => d.name.kind === 'AGENTS.md' && key(d.name.folder) === key(claude.name.folder) && d.text !== null);
    if (agents === undefined || agents.text === null) continue;
    const agentsKey = key(agents.blob.path);
    if (claude.imports.some((i) => i.path !== null && key(i.path) === agentsKey)) continue;
    if (claude.pointsTo !== null || sameText(claude.text, agents.text)) continue;
    claude.flags.push(
      flag('differs-from-agents', `${claude.blob.path} and ${agents.blob.path} hold different text, and ${claude.blob.path} doesn't import ${agents.blob.path}: Claude workers follow both, Codex and Antigravity workers only ${agents.blob.path}.`),
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
        draft.flags.push(flag('uncommitted-changes', `${path} is missing from your checkout; workers get the committed version.`));
      }
      continue;
    }
    const text = decodeUtf8(local.value);
    if (text === null || !sameText(text, draft.text)) {
      draft.flags.push(flag('uncommitted-changes', `Your copy of ${path} differs from the committed one; workers get the committed version. Commit your changes first if workers should follow them.`));
    }
  }
}

/** Rule files only in the user's checkout (untracked or ignored by git). */
async function localOnly(ctx: RepoContext, keys: Set<string>, key: (path: string) => string, problems: string[]): Promise<RuleFileEntry[]> {
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
    if (name === null || keys.has(key(dirty.path))) continue;
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
      else {
        const hidden = findHidden(text);
        if (hidden.count > 0) flags.push(flag('hidden-unicode', `${candidate.path} has ${hidden.count} hidden character(s) (${hidden.codes.join(', ')}).`));
      }
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

  const listing = await repoGitRaw(ctx, ['ls-tree', '-r', '-z', '-l', '--full-tree', opts.baseSha], { timeoutMs: LONG_GIT_TIMEOUT_MS });
  if (listing.code !== 0) return { ok: false, problem: `git ls-tree failed for ${opts.baseSha.slice(0, 12)}: ${describeGitFailure(listing)}` };
  const { rules, keys } = parseLsTree(listing.stdout, key);
  const linksAsText = opts.linksAsText ?? (await linksCheckedOutAsText(ctx, problems));

  const drafts: Draft[] = rules.map((blob) => ({
    blob,
    name: classifyRulePath(blob.path) as RuleName,
    text: null,
    link: null,
    pointsTo: null,
    imports: [],
    importsOnly: false,
    flags: isOddName(blob.path) ? [flag('odd-name', `${shownPath(blob.path)} has a name a brief can't show safely or Windows can't open; workers are not pointed at it.`)] : [],
  }));
  const failed = await readDrafts(ctx, drafts, keys, key, linksAsText, opts.maxFiles ?? DEFAULT_MAX_RULE_FILES, opts.maxTotalBytes ?? MAX_TOTAL_READ_BYTES);
  if (failed !== null) return { ok: false, problem: failed };
  for (const draft of drafts) {
    if (draft.flags.some((f) => f.code === 'odd-name')) continue;
    sizeFlags(draft);
    if (draft.name.kind === 'AGENTS.override.md') {
      draft.flags.push(flag('codex-only', `${draft.blob.path} is read by Codex only, instead of the AGENTS.md in its folder; other engines don't see it.`));
    }
    if (draft.name.nameCase) {
      draft.flags.push(flag('name-case', `${draft.blob.path} differs in letter case from the name engines look for: only engines on Windows and macOS find it.`));
    }
  }
  differsFlags(drafts, key);
  await compareCheckout(ctx, drafts);

  const committed: RuleFileEntry[] = drafts.map((d) => ({
    ...d.name,
    path: d.blob.path,
    source: 'committed',
    id: d.blob.id,
    size: d.blob.size,
    link: d.link,
    pointsTo: d.pointsTo,
    imports: d.imports,
    importsOnly: d.importsOnly,
    flags: d.flags,
  }));
  const files = [...committed, ...(await localOnly(ctx, keys, key, problems))].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const globals = await personalRuleFiles(opts.home, opts.env);
  return { ok: true, manifest: { baseSha: opts.baseSha, linksAsText, files, globals, problems } };
}
