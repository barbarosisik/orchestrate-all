import { describe, expect, it } from 'vitest';
import { rulesForTask, type RulesForTaskOptions } from '../../src/rules/applicable.js';
import type { RuleFileEntry, RuleFlagCode, RulesManifest } from '../../src/rules/manifest.js';
import { classifyRulePath } from '../../src/rules/names.js';
import type { EngineName } from '../../src/plan/schema.js';

interface FileSpec {
  readonly size?: number;
  readonly link?: { target: string; resolved: string | null };
  readonly pointsTo?: string;
  readonly imports?: readonly string[];
  readonly importsOnly?: boolean;
  readonly source?: RuleFileEntry['source'];
  readonly flags?: readonly RuleFlagCode[];
}

function file(path: string, spec: FileSpec = {}): RuleFileEntry {
  const name = classifyRulePath(path);
  if (name === null) throw new Error(`${path} is not a rule file`);
  return {
    ...name,
    path,
    source: spec.source ?? 'committed',
    id: spec.source === undefined || spec.source === 'committed' ? 'a'.repeat(40) : null,
    size: spec.size ?? 100,
    link: spec.link ?? null,
    pointsTo: spec.pointsTo ?? null,
    imports: (spec.imports ?? []).map((p) => (p.startsWith('~') ? { raw: p, path: null, external: true, exists: false } : { raw: p, path: p.replace(/^missing:/, ''), external: false, exists: !p.startsWith('missing:') })),
    importsOnly: spec.importsOnly ?? false,
    flags: (spec.flags ?? []).map((code) => ({ code, message: code })),
  };
}

function manifest(files: readonly RuleFileEntry[], linksAsText = false): RulesManifest {
  // Sorted by path, as buildRulesManifest gives them.
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { baseSha: 'b'.repeat(40), linksAsText, files: sorted, globals: [], problems: [] };
}

const NEW_CLAUDE: RulesForTaskOptions = { claudeVersion: '2.1.300' };
const OLD_CLAUDE: RulesForTaskOptions = { claudeVersion: '2.1.97' };

function paths(m: RulesManifest, engine: EngineName, owns: readonly string[] = ['src/x.ts'], opts: RulesForTaskOptions = NEW_CLAUDE): string[] {
  return rulesForTask(m, { owns }, engine, opts).pointers.map((p) => p.path);
}

describe('rules for a task', () => {
  it('has nothing to point at in a project without rule files', () => {
    for (const engine of ['claude', 'codex', 'antigravity'] as const) {
      expect(rulesForTask(manifest([]), { owns: ['a.ts'] }, engine)).toEqual({ any: false, pointers: [] });
    }
  });

  it('relies on each engine loading a root AGENTS.md, except Claude before 2.1.277', () => {
    const m = manifest([file('AGENTS.md')]);
    expect(paths(m, 'codex')).toEqual([]);
    expect(paths(m, 'antigravity')).toEqual([]);
    expect(paths(m, 'claude')).toEqual([]);
    expect(rulesForTask(m, { owns: [] }, 'claude', OLD_CLAUDE).pointers).toEqual([{ path: 'AGENTS.md', folder: '', reason: 'not-loaded', via: null }]);
    expect(paths(m, 'claude', ['a.ts'], {})).toEqual(['AGENTS.md']);
    expect(rulesForTask(m, { owns: [] }, 'claude', NEW_CLAUDE).any).toBe(true);
  });

  it('points Codex and Antigravity at a CLAUDE.md when no AGENTS.md is beside it', () => {
    const m = manifest([file('CLAUDE.md')]);
    expect(paths(m, 'claude')).toEqual([]);
    expect(paths(m, 'codex')).toEqual(['CLAUDE.md']);
    expect(paths(m, 'antigravity')).toEqual(['CLAUDE.md']);
  });

  it('treats an AGENTS.md imported by a CLAUDE.md as loaded by Claude', () => {
    const m = manifest([file('CLAUDE.md', { imports: ['AGENTS.md'], importsOnly: true }), file('AGENTS.md')]);
    for (const engine of ['claude', 'codex', 'antigravity'] as const) expect(paths(m, engine, ['a.ts'], OLD_CLAUDE)).toEqual([]);
  });

  it('points Claude at an AGENTS.md beside a CLAUDE.md that does not import it, and others at AGENTS.md only', () => {
    const m = manifest([file('CLAUDE.md'), file('AGENTS.md')]);
    expect(paths(m, 'claude')).toEqual(['AGENTS.md']);
    expect(paths(m, 'codex')).toEqual([]);
    expect(paths(m, 'antigravity')).toEqual([]);
  });

  it('points at nested rule files for the folders a task owns, compared ignoring case', () => {
    const m = manifest([file('AGENTS.md'), file('src/api/AGENTS.md'), file('web/AGENTS.md')]);
    expect(rulesForTask(m, { owns: ['src/api/handler.ts'] }, 'codex').pointers).toEqual([
      { path: 'src/api/AGENTS.md', folder: 'src/api', reason: 'not-loaded', via: null },
    ]);
    expect(paths(m, 'antigravity', ['src/api/handler.ts'])).toEqual(['src/api/AGENTS.md']);
    expect(paths(m, 'claude', ['src/api/handler.ts'])).toEqual([]);
    expect(paths(m, 'claude', ['src/api/handler.ts'], OLD_CLAUDE)).toEqual(['AGENTS.md', 'src/api/AGENTS.md']);
    expect(paths(m, 'codex', ['docs/'])).toEqual([]);
    expect(paths(m, 'codex', ['src/'])).toEqual(['src/api/AGENTS.md']);
    expect(paths(m, 'codex', ['SRC/API/x.ts'])).toEqual(['src/api/AGENTS.md']);
    expect(paths(m, 'codex', ['src/api'])).toEqual([]);
    expect(paths(m, 'codex', ['src/api/'])).toEqual(['src/api/AGENTS.md']);
  });

  it('gives a read-only task the rule files at the top only', () => {
    const m = manifest([file('CLAUDE.md'), file('src/CLAUDE.md')]);
    expect(paths(m, 'codex', [])).toEqual(['CLAUDE.md']);
  });

  it("follows Codex's AGENTS.override.md and never points other engines at it", () => {
    const m = manifest([file('AGENTS.override.md'), file('AGENTS.md'), file('pkg/AGENTS.override.md'), file('pkg/AGENTS.md')]);
    expect(paths(m, 'codex', ['a.ts'])).toEqual([]);
    expect(paths(m, 'codex', ['pkg/x.ts'])).toEqual(['pkg/AGENTS.override.md']);
    expect(paths(m, 'antigravity', ['pkg/x.ts'])).toEqual(['pkg/AGENTS.md']);
    expect(paths(m, 'claude', ['pkg/x.ts'], OLD_CLAUDE)).toEqual(['AGENTS.md', 'pkg/AGENTS.md']);
  });

  it('uses AGENTS.md at the top when AGENTS.override.md is empty', () => {
    const m = manifest([file('AGENTS.override.md', { size: 0 }), file('AGENTS.md')]);
    expect(paths(m, 'codex', ['a.ts'])).toEqual([]);
    const nested = manifest([file('AGENTS.override.md', { size: 0 }), file('src/AGENTS.md')]);
    expect(paths(nested, 'codex', ['src/a.ts'])).toEqual(['src/AGENTS.md']);
  });

  it('tells engines to read in full what they would cut', () => {
    const m = manifest([file('AGENTS.md', { size: 40_000 }), file('GEMINI.md', { size: 30_000 })]);
    expect(rulesForTask(m, { owns: [] }, 'codex').pointers).toEqual([{ path: 'AGENTS.md', folder: '', reason: 'too-long', via: null }]);
    expect(rulesForTask(m, { owns: [] }, 'antigravity').pointers.map((p) => [p.path, p.reason])).toEqual([
      ['AGENTS.md', 'too-long'],
      ['GEMINI.md', 'too-long'],
    ]);
    expect(paths(m, 'claude', [])).toEqual([]);
  });

  it('points at what a link leads to when links are checked out as text', () => {
    const files = [file('CLAUDE.md', { link: { target: 'AGENTS.md', resolved: 'AGENTS.md' } }), file('AGENTS.md')];
    expect(rulesForTask(manifest(files, true), { owns: [] }, 'claude').pointers).toEqual([{ path: 'AGENTS.md', folder: '', reason: 'link-target', via: 'CLAUDE.md' }]);
    expect(paths(manifest(files, true), 'codex', [])).toEqual([]);
    // Real links: Claude reads AGENTS.md through CLAUDE.md, whatever its version.
    expect(paths(manifest(files, false), 'claude', [], OLD_CLAUDE)).toEqual([]);
  });

  it('points at the file behind a linked AGENTS.md only when links are text', () => {
    const files = [file('AGENTS.md', { link: { target: 'docs/shared.md', resolved: 'docs/shared.md' } })];
    expect(rulesForTask(manifest(files, true), { owns: [] }, 'codex').pointers).toEqual([{ path: 'docs/shared.md', folder: '', reason: 'link-target', via: 'AGENTS.md' }]);
    expect(paths(manifest(files, false), 'codex', [])).toEqual([]);
    expect(paths(manifest([file('AGENTS.md', { link: { target: '../x.md', resolved: null } })], true), 'codex', [])).toEqual([]);
  });

  it('points at the rule file a one-line pointer names', () => {
    const m = manifest([file('sub/CLAUDE.md', { pointsTo: 'sub/AGENTS.md' }), file('sub/AGENTS.md')]);
    expect(rulesForTask(m, { owns: ['sub/x.ts'] }, 'claude').pointers).toEqual([{ path: 'sub/AGENTS.md', folder: 'sub', reason: 'link-target', via: 'sub/CLAUDE.md' }]);
    expect(paths(m, 'codex', ['sub/x.ts'])).toEqual(['sub/AGENTS.md']);
  });

  it("points other engines at a CLAUDE.md's imports that exist in the repository", () => {
    const m = manifest([file('CLAUDE.md', { imports: ['docs/style.md', 'missing:docs/gone.md', '~/.claude/me.md'] })]);
    expect(rulesForTask(m, { owns: [] }, 'codex').pointers).toEqual([
      { path: 'CLAUDE.md', folder: '', reason: 'not-loaded', via: null },
      { path: 'docs/style.md', folder: '', reason: 'import', via: 'CLAUDE.md' },
    ]);
    expect(paths(m, 'claude', [])).toEqual([]);
    const only = manifest([file('CLAUDE.md', { imports: ['docs/a.md'], importsOnly: true })]);
    expect(paths(only, 'antigravity', [])).toEqual(['docs/a.md']);
  });

  it('points Claude and Codex at a GEMINI.md when it is all a folder has', () => {
    const m = manifest([file('GEMINI.md'), file('.agents/rules/style.md')]);
    expect(paths(m, 'claude', [])).toEqual(['.agents/rules/style.md', 'GEMINI.md']);
    expect(paths(m, 'codex', [])).toEqual(['.agents/rules/style.md', 'GEMINI.md']);
    expect(paths(m, 'antigravity', [])).toEqual([]);
  });

  it("leaves another engine's own rules out where an AGENTS.md is in charge", () => {
    const m = manifest([file('AGENTS.md'), file('.claude/rules/x.md'), file('GEMINI.md')]);
    expect(paths(m, 'codex', [])).toEqual([]);
    expect(paths(manifest([file('.claude/rules/x.md')]), 'codex', [])).toEqual(['.claude/rules/x.md']);
  });

  it('never points at files workers do not have, or at odd names', () => {
    const m = manifest([
      file('CLAUDE.local.md', { source: 'ignored' }),
      file('pkg/AGENTS.md', { source: 'untracked' }),
      file('a<b/AGENTS.md', { flags: ['odd-name'] }),
      file('CLAUDE.md', { imports: ['docs/<x>.md'] }),
    ]);
    expect(paths(m, 'codex', ['pkg/', 'a<b/'])).toEqual(['CLAUDE.md']);
    expect(rulesForTask(manifest([file('CLAUDE.local.md', { source: 'ignored' })]), { owns: [] }, 'codex').any).toBe(false);
    // An odd-named rule file leads nowhere either, not even to the files it imports.
    const oddImporter = manifest([file('q`/CLAUDE.md', { imports: ['docs/style.md'], flags: ['odd-name'] })]);
    expect(paths(oddImporter, 'codex', ['q`/x.ts'])).toEqual([]);
  });

  it('lists each file once, the top folder first', () => {
    const m = manifest([file('CLAUDE.md', { imports: ['AGENTS.md'] }), file('AGENTS.md', { size: 40_000 }), file('src/CLAUDE.md'), file('src/a/CLAUDE.md')]);
    expect(rulesForTask(m, { owns: ['src/a/x.ts'] }, 'codex').pointers.map((p) => [p.path, p.reason])).toEqual([
      ['AGENTS.md', 'too-long'],
      ['src/CLAUDE.md', 'not-loaded'],
      ['src/a/CLAUDE.md', 'not-loaded'],
    ]);
  });
});
