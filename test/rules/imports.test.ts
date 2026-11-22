import { describe, expect, it } from 'vitest';
import { claudeImports, importsOnly, resolveRepoPath } from '../../src/rules/imports.js';

describe('Claude @imports', () => {
  it('finds imports relative to the file that has them', () => {
    expect(claudeImports('@AGENTS.md\n\nSee @docs/style.md for style.\n', 'CLAUDE.md')).toEqual([
      { raw: 'AGENTS.md', path: 'AGENTS.md', external: false },
      { raw: 'docs/style.md', path: 'docs/style.md', external: false },
    ]);
    expect(claudeImports('@../AGENTS.md', '.claude/CLAUDE.md')).toEqual([{ raw: '../AGENTS.md', path: 'AGENTS.md', external: false }]);
    expect(claudeImports('@./notes.md', 'web/CLAUDE.md')).toEqual([{ raw: './notes.md', path: 'web/notes.md', external: false }]);
  });

  it('marks imports outside the repository as external', () => {
    expect(claudeImports('@~/.claude/my.md @/etc/rules.md @C:/rules.md @../../up.md', 'web/CLAUDE.md')).toEqual([
      { raw: '~/.claude/my.md', path: null, external: true },
      { raw: '/etc/rules.md', path: null, external: true },
      { raw: 'C:/rules.md', path: null, external: true },
      { raw: '../../up.md', path: null, external: true },
    ]);
  });

  it('skips code blocks, code spans, mentions and e-mail addresses', () => {
    const text = [
      'Ask @alice before releasing; mail ops@example.com.',
      'Run `npm i @types/node`.',
      '```',
      '@not/an/import.md',
      '```',
      '~~~md',
      '@also/not.md',
      '~~~',
      '@real.md',
    ].join('\n');
    expect(claudeImports(text, 'CLAUDE.md')).toEqual([{ raw: 'real.md', path: 'real.md', external: false }]);
  });

  it('lists each import once and strips sentence punctuation', () => {
    expect(claudeImports('Read @AGENTS.md. Then @AGENTS.md again, and (@docs/a.md).', 'CLAUDE.md').map((i) => i.path)).toEqual([
      'AGENTS.md',
      'docs/a.md',
    ]);
  });

  it('tells a file that holds only imports', () => {
    expect(importsOnly('@AGENTS.md\n')).toBe(true);
    expect(importsOnly('\n<!-- shared rules -->\n@AGENTS.md\n@docs/x.md\n\n')).toBe(true);
    expect(importsOnly('@AGENTS.md\n\nUse tabs.\n')).toBe(false);
    expect(importsOnly('')).toBe(false);
  });

  it('resolves repository paths and refuses ones that leave it', () => {
    expect(resolveRepoPath('a/b', '../c.md')).toBe('a/c.md');
    expect(resolveRepoPath('', 'x//y/./z.md')).toBe('x/y/z.md');
    expect(resolveRepoPath('a', '../../c.md')).toBeNull();
    expect(resolveRepoPath('', '/abs.md')).toBeNull();
    expect(resolveRepoPath('', 'C:\\abs.md')).toBeNull();
    expect(resolveRepoPath('', '\\\\server\\share\\x.md')).toBeNull();
    expect(resolveRepoPath('a', 'b\\c.md')).toBe('a/b/c.md');
    expect(resolveRepoPath('', '.')).toBeNull();
  });
});
