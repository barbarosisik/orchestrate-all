import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRulesManifest, type ManifestOptions, type RuleFileEntry, type RulesManifest } from '../../src/rules/manifest.js';
import { makeFixture, type Fixture } from '../helpers/fixture.js';
import type { TmpRepo } from '../helpers/tmprepo.js';

const WINDOWS = process.platform === 'win32';
const fixtures: Fixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(files: Record<string, string>): Fixture {
  const f = makeFixture({ files });
  fixtures.push(f);
  return f;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-rules-'));
  dirs.push(dir);
  return dir;
}

function put(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function manifestOf(f: Fixture, opts: Partial<ManifestOptions> = {}): Promise<RulesManifest> {
  const result = await buildRulesManifest(f.ctx, { baseSha: f.base, home: tempDir(), env: {}, ...opts });
  if (!result.ok) throw new Error(result.problem);
  return result.manifest;
}

function entry(m: RulesManifest, path: string): RuleFileEntry {
  const found = m.files.find((e) => e.path === path);
  if (found === undefined) throw new Error(`${path} is not in the manifest: ${m.files.map((e) => e.path).join(', ')}`);
  return found;
}

function codes(e: RuleFileEntry): string[] {
  return e.flags.map((flag) => flag.code);
}

type Item = string | { readonly link: string };

/** Commits a tree made with git plumbing (links and names a checkout can't hold), without checking it out. */
function plumbingCommit(repo: TmpRepo, files: Record<string, Item>): string {
  interface Folder {
    readonly entries: Map<string, Folder | { mode: string; id: string }>;
  }
  const root: Folder = { entries: new Map() };
  for (const [path, item] of Object.entries(files)) {
    const parts = path.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.entries.get(part);
      if (next === undefined || !('entries' in next)) {
        next = { entries: new Map() };
        folder.entries.set(part, next);
      }
      folder = next;
    }
    const content = typeof item === 'string' ? item : item.link;
    const id = repo.gitInput(content, 'hash-object', '-w', '--stdin');
    folder.entries.set(parts[parts.length - 1] as string, { mode: typeof item === 'string' ? '100644' : '120000', id });
  }
  const write = (folder: Folder): string => {
    const lines = [...folder.entries].map(([name, child]) =>
      'entries' in child ? `040000 tree ${write(child)}\t${name}` : `${child.mode} blob ${child.id}\t${name}`,
    );
    return repo.gitInput(`${lines.join('\n')}\n`, 'mktree');
  };
  return repo.git('commit-tree', write(root), '-m', 'plumbing');
}

describe('rules manifest: files in the base commit', () => {
  it('lists every rule file with its kind, folder, size and id, and nothing else', async () => {
    const f = setup({
      'README.md': 'hello\n',
      'AGENTS.md': '# Rules\n',
      'src/api/AGENTS.md': 'api rules\n',
      'src/index.ts': 'export {};\n',
      'web/CLAUDE.md': 'web rules\n',
      '.claude/rules/style.md': 'style\n',
      'GEMINI.md': 'gemini\n',
    });
    const m = await manifestOf(f);
    expect(m.baseSha).toBe(f.base);
    expect(m.problems).toEqual([]);
    expect(m.files.map((e) => e.path)).toEqual(['.claude/rules/style.md', 'AGENTS.md', 'GEMINI.md', 'src/api/AGENTS.md', 'web/CLAUDE.md']);
    const agents = entry(m, 'AGENTS.md');
    expect(agents).toMatchObject({
      kind: 'AGENTS.md',
      family: 'shared',
      folder: '',
      source: 'committed',
      size: 8,
      link: null,
      pointsTo: null,
      imports: [],
      importsOnly: false,
      flags: [],
    });
    expect(agents.id).toMatch(/^[0-9a-f]{40}$/);
    expect(entry(m, 'src/api/AGENTS.md').folder).toBe('src/api');
    expect(entry(m, 'web/CLAUDE.md')).toMatchObject({ kind: 'CLAUDE.md', family: 'claude', folder: 'web' });
  });

  it('reads the base commit, not what the checkout holds now', async () => {
    const f = setup({ 'AGENTS.md': 'rules\n' });
    f.repo.write('CLAUDE.md', 'later\n');
    f.repo.commitAll('later');
    const m = await manifestOf(f);
    expect(m.files.map((e) => e.path)).toEqual(['AGENTS.md']);
  });

  it('flags hidden characters', async () => {
    const f = setup({ 'AGENTS.md': 'Be careful.‮ secret\n', 'GEMINI.md': 'fine\n' });
    const m = await manifestOf(f);
    const flag = entry(m, 'AGENTS.md').flags.find((x) => x.code === 'hidden-unicode');
    expect(flag?.message).toContain('U+202E');
    expect(codes(entry(m, 'GEMINI.md'))).toEqual([]);
  });

  it("lists a CLAUDE.md's imports and flags missing and outside ones", async () => {
    const f = setup({
      'CLAUDE.md': '@AGENTS.md\n@docs/style.md\n@docs/missing.md\n@~/.claude/mine.md\nMore text.\n',
      'AGENTS.md': 'shared\n',
      'docs/style.md': 'style\n',
    });
    const e = entry(await manifestOf(f), 'CLAUDE.md');
    expect(e.imports).toEqual([
      { raw: 'AGENTS.md', path: 'AGENTS.md', external: false, exists: true },
      { raw: 'docs/style.md', path: 'docs/style.md', external: false, exists: true },
      { raw: 'docs/missing.md', path: 'docs/missing.md', external: false, exists: false },
      { raw: '~/.claude/mine.md', path: null, external: true, exists: false },
    ]);
    expect(e.importsOnly).toBe(false);
    expect(codes(e)).toEqual(expect.arrayContaining(['import-missing', 'import-outside']));
    expect(codes(e)).not.toContain('pointer-only');
  });

  it('flags a CLAUDE.md that only imports, or only names another rule file', async () => {
    const f = setup({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': 'shared\n', 'sub/CLAUDE.md': 'AGENTS.md\n', 'sub/AGENTS.md': 'sub\n', 'x/CLAUDE.md': 'README.md\n', 'x/README.md': 'hi\n' });
    const m = await manifestOf(f);
    expect(entry(m, 'CLAUDE.md')).toMatchObject({ importsOnly: true, pointsTo: null });
    expect(codes(entry(m, 'CLAUDE.md'))).toContain('pointer-only');
    expect(entry(m, 'sub/CLAUDE.md')).toMatchObject({ importsOnly: false, pointsTo: 'sub/AGENTS.md' });
    expect(codes(entry(m, 'sub/CLAUDE.md'))).toContain('pointer-only');
    // Only another rule file counts: a CLAUDE.md that says "README.md" is just short.
    expect(entry(m, 'x/CLAUDE.md').pointsTo).toBeNull();
  });

  it('flags files over the size Codex or Antigravity load', async () => {
    const f = setup({
      'AGENTS.md': 'x'.repeat(33_000),
      'GEMINI.md': 'x'.repeat(25_000),
      'sub/AGENTS.md': 'x'.repeat(30_000),
      'c/CLAUDE.md': 'x'.repeat(40_000),
    });
    const m = await manifestOf(f);
    expect(codes(entry(m, 'AGENTS.md'))).toEqual(expect.arrayContaining(['over-codex-cap', 'over-antigravity-cap']));
    expect(codes(entry(m, 'GEMINI.md'))).toEqual(['over-antigravity-cap']);
    expect(codes(entry(m, 'sub/AGENTS.md'))).toEqual(['over-antigravity-cap']);
    expect(codes(entry(m, 'c/CLAUDE.md'))).toEqual([]);
  });

  it('flags AGENTS.override.md as Codex-only and names in another letter case', async () => {
    const f = setup({ 'AGENTS.override.md': 'codex\n', 'lib/Agents.md': 'lib\n' });
    const m = await manifestOf(f);
    expect(codes(entry(m, 'AGENTS.override.md'))).toEqual(['codex-only']);
    expect(codes(entry(m, 'lib/Agents.md'))).toEqual(['name-case']);
  });

  it('flags a CLAUDE.md whose text differs from the AGENTS.md beside it', async () => {
    const f = setup({
      'CLAUDE.md': 'Use tabs.\n',
      'AGENTS.md': 'Use spaces.\n',
      'same/CLAUDE.md': 'One rule.\r\n',
      'same/AGENTS.md': 'One rule.\n',
      'imp/.claude/CLAUDE.md': '@../AGENTS.md\nClaude notes.\n',
      'imp/AGENTS.md': 'Shared.\n',
    });
    const m = await manifestOf(f);
    expect(codes(entry(m, 'CLAUDE.md'))).toEqual(['differs-from-agents']);
    expect(codes(entry(m, 'same/CLAUDE.md'))).toEqual([]);
    expect(codes(entry(m, 'imp/.claude/CLAUDE.md'))).toEqual([]);
  });

  it('records links, resolved inside the repository, and flags ones checked out as text', async () => {
    const f = setup({ 'README.md': 'hi\n' });
    const base = plumbingCommit(f.repo, {
      'AGENTS.md': 'shared\n',
      'CLAUDE.md': { link: 'AGENTS.md' },
      'sub/GEMINI.md': { link: '../../outside.md' },
      'web/CLAUDE.md': { link: 'gone.md' },
    });
    const asText = await manifestOf(f, { baseSha: base, linksAsText: true });
    expect(asText.linksAsText).toBe(true);
    expect(entry(asText, 'CLAUDE.md').link).toEqual({ target: 'AGENTS.md', resolved: 'AGENTS.md' });
    expect(codes(entry(asText, 'CLAUDE.md'))).toEqual(['link-as-text']);
    expect(entry(asText, 'sub/GEMINI.md').link).toEqual({ target: '../../outside.md', resolved: null });
    expect(codes(entry(asText, 'sub/GEMINI.md'))).toContain('link-outside');
    expect(entry(asText, 'web/CLAUDE.md').link).toEqual({ target: 'gone.md', resolved: null });
    expect(codes(entry(asText, 'web/CLAUDE.md'))).toContain('link-missing');

    const real = await manifestOf(f, { baseSha: base, linksAsText: false });
    expect(codes(entry(real, 'CLAUDE.md'))).toEqual([]);
  });

  it("reads whether links are checked out as text from the repository's config", async () => {
    const f = setup({ 'AGENTS.md': 'x\n' });
    f.repo.git('config', 'core.symlinks', 'false');
    expect((await manifestOf(f)).linksAsText).toBe(true);
    f.repo.git('config', 'core.symlinks', 'true');
    expect((await manifestOf(f)).linksAsText).toBe(false);
    f.repo.git('config', '--unset', 'core.symlinks');
    expect((await manifestOf(f)).linksAsText).toBe(WINDOWS);
  });

  it('never points at names that are odd in a brief or on Windows', async () => {
    const f = setup({ 'README.md': 'hi\n' });
    const base = plumbingCommit(f.repo, { 'a<b/AGENTS.md': 'x\n', 'c:d/CLAUDE.md': 'y\n', 'AGENTS.md': 'ok\n' });
    const m = await manifestOf(f, { baseSha: base });
    expect(codes(entry(m, 'a<b/AGENTS.md'))).toEqual(['odd-name']);
    expect(codes(entry(m, 'c:d/CLAUDE.md'))).toEqual(['odd-name']);
  });

  it('reads at most maxFiles rule files and flags the rest as unchecked', async () => {
    const f = setup({ 'a/AGENTS.md': 'one\n', 'b/AGENTS.md': 'two\n', 'c/AGENTS.md': 'three ‮\n' });
    const m = await manifestOf(f, { maxFiles: 2 });
    expect(codes(entry(m, 'a/AGENTS.md'))).toEqual([]);
    expect(codes(entry(m, 'c/AGENTS.md'))).toEqual(['unchecked']);
  });

  it('refuses a base commit that is not in the repository', async () => {
    const f = setup({ 'AGENTS.md': 'x\n' });
    const missing = await buildRulesManifest(f.ctx, { baseSha: 'f'.repeat(40), home: tempDir(), env: {} });
    expect(missing.ok).toBe(false);
    const bad = await buildRulesManifest(f.ctx, { baseSha: '--output=x', home: tempDir(), env: {} });
    expect(bad).toEqual({ ok: false, problem: '"--output=x" is not a full commit id.' });
  });
});

describe("rules manifest: the user's checkout", () => {
  it('flags committed rule files whose copy in the checkout differs, ignoring line endings', async () => {
    const f = setup({ 'AGENTS.md': 'committed\n', 'c/CLAUDE.md': 'one\ntwo\n', 'GEMINI.md': 'g\n' });
    writeFileSync(join(f.repo.dir, 'AGENTS.md'), 'edited\n');
    writeFileSync(join(f.repo.dir, 'c', 'CLAUDE.md'), 'one\r\ntwo\r\n');
    unlinkSync(join(f.repo.dir, 'GEMINI.md'));
    const m = await manifestOf(f);
    expect(codes(entry(m, 'AGENTS.md'))).toEqual(['uncommitted-changes']);
    expect(codes(entry(m, 'c/CLAUDE.md'))).toEqual([]);
    const gone = entry(m, 'GEMINI.md').flags.find((x) => x.code === 'uncommitted-changes');
    expect(gone?.message).toContain('missing');
  });

  it('lists rule files that are only in the checkout, untracked or ignored', async () => {
    const f = setup({ '.gitignore': 'CLAUDE.local.md\n', 'AGENTS.md': 'x\n' });
    f.repo.write('CLAUDE.local.md', 'mine\n');
    f.repo.write('pkg/AGENTS.md', 'new\n');
    f.repo.write('notes.md', 'not a rule file\n');
    const m = await manifestOf(f);
    expect(entry(m, 'CLAUDE.local.md')).toMatchObject({ source: 'ignored', id: null, size: 5, kind: 'CLAUDE.local.md' });
    expect(codes(entry(m, 'CLAUDE.local.md'))).toEqual(['not-in-worktree']);
    expect(entry(m, 'pkg/AGENTS.md')).toMatchObject({ source: 'untracked', id: null, folder: 'pkg' });
    expect(m.files.some((e) => e.path === 'notes.md')).toBe(false);
  });
});

describe('rules manifest: personal rule files', () => {
  it("lists each engine's personal rule files and whether workers load them", async () => {
    const f = setup({ 'AGENTS.md': 'x\n' });
    const home = tempDir();
    put(join(home, '.claude', 'CLAUDE.md'), 'personal\n');
    put(join(home, '.claude', 'rules', 'mine.md'), 'mine\n');
    put(join(home, '.codex', 'AGENTS.override.md'), '');
    put(join(home, '.codex', 'AGENTS.md'), 'codex ​ rules\n');
    put(join(home, '.gemini', 'GEMINI.md'), 'g\n');
    put(join(home, '.gemini', 'config', 'rules', 'r.md'), 'r\n');
    put(join(home, '.gemini', 'notes.txt'), 'not a rule file\n');
    const m = await manifestOf(f, { home });
    expect(m.globals.map((g) => [g.engine, g.path, g.loadedByWorkers])).toEqual([
      ['claude', join(home, '.claude', 'CLAUDE.md'), false],
      ['claude', join(home, '.claude', 'rules', 'mine.md'), false],
      ['codex', join(home, '.codex', 'AGENTS.md'), true],
      ['antigravity', join(home, '.gemini', 'GEMINI.md'), true],
      ['antigravity', join(home, '.gemini', 'config', 'rules', 'r.md'), true],
    ]);
    const codex = m.globals.find((g) => g.engine === 'codex');
    expect(codex?.flags.map((x) => x.code)).toEqual(['hidden-unicode']);
    expect(codex?.size).toBe(Buffer.byteLength('codex ​ rules\n'));
  });

  it('follows CODEX_HOME and CLAUDE_CONFIG_DIR, and a non-empty override wins', async () => {
    const f = setup({ 'AGENTS.md': 'x\n' });
    const home = tempDir();
    const codexHome = tempDir();
    const claudeDir = tempDir();
    put(join(codexHome, 'AGENTS.override.md'), 'override\n');
    put(join(codexHome, 'AGENTS.md'), 'plain\n');
    put(join(claudeDir, 'CLAUDE.md'), 'c\n');
    put(join(home, '.codex', 'AGENTS.md'), 'not used: CODEX_HOME moves it\n');
    const m = await manifestOf(f, { home, env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir } });
    expect(m.globals.map((g) => [g.engine, g.path, g.loadedByWorkers])).toEqual([
      ['claude', join(claudeDir, 'CLAUDE.md'), false],
      ['codex', join(codexHome, 'AGENTS.override.md'), true],
      ['codex', join(codexHome, 'AGENTS.md'), false],
    ]);
  });

  it.skipIf(WINDOWS)('does not open a personal rule file that is a link', async () => {
    const f = setup({ 'AGENTS.md': 'x\n' });
    const home = tempDir();
    const elsewhere = join(tempDir(), 'real.md');
    put(elsewhere, 'hidden ‮\n');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    symlinkSync(elsewhere, join(home, '.gemini', 'GEMINI.md'));
    const m = await manifestOf(f, { home });
    expect(m.globals).toEqual([
      { engine: 'antigravity', path: join(home, '.gemini', 'GEMINI.md'), loadedByWorkers: true, size: null, link: true, flags: [] },
    ]);
  });
});
