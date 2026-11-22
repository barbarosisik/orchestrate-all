import { describe, expect, it } from 'vitest';
import { DEFAULT_RESERVED_PATTERNS } from '../../src/config/defaults.js';
import { parseOwnsEntry } from '../../src/plan/paths.js';
import { compilePatterns } from '../../src/plan/reserved.js';
import { classifyRulePath, ruleNamePathspecs } from '../../src/rules/names.js';

describe('rule file names', () => {
  it.each([
    ['AGENTS.md', 'AGENTS.md', 'shared', ''],
    ['src/api/AGENTS.md', 'AGENTS.md', 'shared', 'src/api'],
    ['AGENTS.override.md', 'AGENTS.override.md', 'codex', ''],
    ['pkg/AGENTS.override.md', 'AGENTS.override.md', 'codex', 'pkg'],
    ['CLAUDE.md', 'CLAUDE.md', 'claude', ''],
    ['web/CLAUDE.md', 'CLAUDE.md', 'claude', 'web'],
    ['.claude/CLAUDE.md', '.claude/CLAUDE.md', 'claude', ''],
    ['web/.claude/CLAUDE.md', '.claude/CLAUDE.md', 'claude', 'web'],
    ['CLAUDE.local.md', 'CLAUDE.local.md', 'claude', ''],
    ['.claude/rules/style.md', '.claude/rules', 'claude', ''],
    ['.claude/rules/frontend/react.md', '.claude/rules', 'claude', ''],
    ['web/.claude/rules/x.md', '.claude/rules', 'claude', 'web'],
    ['.claude/rules/CLAUDE.md', '.claude/rules', 'claude', ''],
    ['GEMINI.md', 'GEMINI.md', 'gemini', ''],
    ['lib/GEMINI.md', 'GEMINI.md', 'gemini', 'lib'],
    ['.agents/AGENTS.md', '.agents/AGENTS.md', 'gemini', ''],
    ['.agents/GEMINI.md', '.agents/GEMINI.md', 'gemini', ''],
    ['lib/.agents/AGENTS.md', '.agents/AGENTS.md', 'gemini', 'lib'],
    ['.agents/rules/style.md', '.agents/rules', 'gemini', ''],
    ['.agent/rules/style.md', '.agents/rules', 'gemini', ''],
  ])('%s is a rule file (%s)', (path, kind, family, folder) => {
    expect(classifyRulePath(path)).toEqual({ kind, family, folder, nameCase: false });
  });

  it.each([
    'README.md',
    'docs/agents.txt',
    'AGENTS.md.bak',
    'MY-AGENTS.md',
    '.claude/settings.json',
    '.claude/rules/notes.txt',
    '.claude/skills/x/SKILL.md',
    '.agents/rules/deep/style.md',
    '.agents/skills/x/SKILL.md',
    '.agents/README.md',
    'CLAUDE.local.md/inner.md',
  ])('%s is not a rule file', (path) => {
    expect(classifyRulePath(path)).toBeNull();
  });

  it('matches names in any letter case, and says when the case differs', () => {
    expect(classifyRulePath('Agents.md')).toEqual({ kind: 'AGENTS.md', family: 'shared', folder: '', nameCase: true });
    expect(classifyRulePath('src/claude.MD')).toEqual({ kind: 'CLAUDE.md', family: 'claude', folder: 'src', nameCase: true });
    expect(classifyRulePath('.Claude/rules/x.md')).toEqual({ kind: '.claude/rules', family: 'claude', folder: '', nameCase: true });
    // The rule file's own name inside a rules folder is free; only the extension is checked.
    expect(classifyRulePath('.claude/rules/Style.MD')).toEqual({ kind: '.claude/rules', family: 'claude', folder: '', nameCase: false });
  });

  it('keeps the folder as stored', () => {
    expect(classifyRulePath('Src/Api/AGENTS.md')?.folder).toBe('Src/Api');
  });

  it('reserves every kind of rule file, so no ordinary task can change one during a run', () => {
    const reserved = compilePatterns(DEFAULT_RESERVED_PATTERNS);
    const samples = [
      'AGENTS.md',
      'src/AGENTS.md',
      'pkg/AGENTS.override.md',
      'web/CLAUDE.md',
      'web/.claude/CLAUDE.md',
      'CLAUDE.local.md',
      'web/.claude/rules/x.md',
      'lib/GEMINI.md',
      'lib/.agents/AGENTS.md',
      'lib/.agents/rules/x.md',
      'lib/.agent/rules/x.md',
      'Lib/Agents.md',
    ];
    for (const path of samples) {
      expect(classifyRulePath(path), path).not.toBeNull();
      const parsed = parseOwnsEntry(path);
      if (!parsed.ok) throw new Error(path);
      expect(reserved.match(parsed.entry), path).not.toBeNull();
    }
  });

  it('gives git pathspecs that cover every kind', () => {
    const specs = ruleNamePathspecs();
    expect(specs.every((s) => s.startsWith(':(glob,icase)'))).toBe(true);
    expect(specs.some((s) => s.endsWith('**/AGENTS.md'))).toBe(true);
    expect(specs.some((s) => s.endsWith('**/.claude/rules/**/*.md'))).toBe(true);
  });
});
