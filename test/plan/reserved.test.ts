import { describe, expect, it } from 'vitest';
import { parseOwnsEntry, type OwnsEntry } from '../../src/plan/paths.js';
import { compilePatterns, literalPattern } from '../../src/plan/reserved.js';
import { DEFAULT_RESERVED_PATTERNS, FORBIDDEN_PATTERNS } from '../../src/config/defaults.js';

function entry(raw: string): OwnsEntry {
  const result = parseOwnsEntry(raw);
  if (!result.ok) throw new Error(`bad test path ${raw}`);
  return result.entry;
}

describe('compilePatterns', () => {
  it('matches a bare file name at any depth', () => {
    const m = compilePatterns(['package.json']);
    expect(m.match(entry('package.json'))).toBe('package.json');
    expect(m.match(entry('packages/web/package.json'))).toBe('package.json');
    expect(m.match(entry('src/package.json.ts'))).toBeNull();
  });

  it('matches case-insensitively', () => {
    const m = compilePatterns(['CLAUDE.md']);
    expect(m.match(entry('claude.md'))).toBe('CLAUDE.md');
    expect(m.match(entry('docs/Claude.MD'))).toBe('CLAUDE.md');
  });

  it('supports * inside a name', () => {
    const m = compilePatterns(['*.lock', 'tsconfig*.json', '.env*']);
    expect(m.match(entry('yarn.lock'))).toBe('*.lock');
    expect(m.match(entry('crates/x/Cargo.lock'))).toBe('*.lock');
    expect(m.match(entry('tsconfig.build.json'))).toBe('tsconfig*.json');
    expect(m.match(entry('.env.local'))).toBe('.env*');
    expect(m.match(entry('src/environment.ts'))).toBeNull();
  });

  it('* does not cross folders', () => {
    const m = compilePatterns(['src/*.ts']);
    expect(m.match(entry('src/a.ts'))).toBe('src/*.ts');
    expect(m.match(entry('src/deep/a.ts'))).toBeNull();
  });

  it('a pattern with a slash is anchored at the repo root', () => {
    const m = compilePatterns(['config/app.json']);
    expect(m.match(entry('config/app.json'))).toBe('config/app.json');
    expect(m.match(entry('pkg/config/app.json'))).toBeNull();
  });

  it('a folder pattern covers the folder and everything inside it', () => {
    const m = compilePatterns(['.github/']);
    expect(m.match(entry('.github/workflows/ci.yml'))).toBe('.github/');
    expect(m.match(entry('.github/'))).toBe('.github/');
    expect(m.match(entry('.github/workflows/'))).toBe('.github/');
  });

  it('treats a trailing /** like a folder pattern', () => {
    const m = compilePatterns(['.claude/**']);
    expect(m.match(entry('.claude/settings.json'))).toBe('.claude/**');
    expect(m.match(entry('.claude/'))).toBe('.claude/**');
  });

  it('an unanchored folder pattern matches that folder at any depth', () => {
    const m = compilePatterns(['.vscode/']);
    expect(m.match(entry('packages/web/.vscode/settings.json'))).toBe('.vscode/');
  });

  it('a folder pattern does not match a file with the same name', () => {
    const m = compilePatterns(['.husky/']);
    expect(m.match(entry('docs/.husky'))).toBeNull();
  });

  it('an anchored folder pattern only matches at the root', () => {
    const m = compilePatterns(['tools/generated/']);
    expect(m.match(entry('tools/generated/a.ts'))).toBe('tools/generated/');
    expect(m.match(entry('pkg/tools/generated/a.ts'))).toBeNull();
  });

  it('** matches across folders', () => {
    const m = compilePatterns(['docs/**/secret.md']);
    expect(m.match(entry('docs/a/b/secret.md'))).toBe('docs/**/secret.md');
    expect(m.match(entry('docs/secret.md'))).toBe('docs/**/secret.md');
  });

  it('a file pattern also catches a parent folder with that name', () => {
    const m = compilePatterns(['.env*']);
    expect(m.match(entry('.env.d/x.conf'))).toBe('.env*');
  });

  it('escapes regex characters in patterns', () => {
    const m = compilePatterns(['a+b(c).md']);
    expect(m.match(entry('a+b(c).md'))).toBe('a+b(c).md');
    expect(m.match(entry('aab(c).md'))).toBeNull();
  });

  it('accepts backslashes in patterns', () => {
    const m = compilePatterns(['.github\\']);
    expect(m.match(entry('.github/x.yml'))).toBe('.github\\');
  });

  it('ignores empty patterns', () => {
    const m = compilePatterns(['', '  ']);
    expect(m.match(entry('a.ts'))).toBeNull();
  });

  it('a leading slash anchors a pattern at the root, as in .gitignore', () => {
    const m = compilePatterns(['/notes.md']);
    expect(m.match(entry('notes.md'))).toBe('/notes.md');
    expect(m.match(entry('docs/notes.md'))).toBeNull();
  });

  it('reads a bracket around one character as that character, never as a wildcard', () => {
    const m = compilePatterns(['/a[*]b[?][[].md']);
    expect(m.match(raw('a*b?[.md'))).toBe('/a[*]b[?][[].md');
    expect(m.match(raw('axbyz.md'))).toBeNull();
    expect(m.match(raw('a*b?x.md'))).toBeNull();
  });

  it('keeps longer brackets literal, as before', () => {
    const m = compilePatterns(['[ab].md']);
    expect(m.match(raw('[ab].md'))).toBe('[ab].md');
    expect(m.match(entry('a.md'))).toBeNull();
  });
});

/** A file entry for any path git can hold, even one an owned-path entry can't name (wildcards, spaces). */
function raw(path: string): OwnsEntry {
  return { path, key: path.toLowerCase().normalize('NFC'), isFolder: false };
}

describe('literalPattern', () => {
  it.each([
    'notes.md',
    'docs/rules/style.md',
    'docs/a*b.md',
    'docs/what?.md',
    'docs/[draft].md',
    'docs/**',
    'docs/x.md ',
    'docs/ lead.md',
    'docs/tab\t',
    'Docs/ÄÖ.md',
  ])('matches exactly %j', (path) => {
    const pattern = literalPattern(path);
    expect(pattern).not.toBeNull();
    const m = compilePatterns([pattern as string]);
    expect(m.match(raw(path))).toBe(pattern);
    expect(m.match(raw(`other/${path}`))).toBeNull();
  });

  it('matches what the file system would also call that file (letter case, composed letters)', () => {
    const m = compilePatterns([literalPattern('Docs/Cafe\u0301.md') as string]);
    expect(m.match(raw('docs/café.md'))).not.toBeNull();
  });

  it('never matches more than the one path', () => {
    const m = compilePatterns([literalPattern('docs/a*b?.md') as string]);
    expect(m.match(raw('docs/axbyz.md'))).toBeNull();
    expect(m.match(raw('docs/axby.md'))).toBeNull();
    expect(m.match(raw('docs/a*b?.md/inner'))).not.toBeNull();
    expect(compilePatterns([literalPattern('docs/**') as string]).match(raw('docs/x.md'))).toBeNull();
    expect(compilePatterns([literalPattern('docs/x.md ') as string]).match(raw('docs/x.md'))).toBeNull();
  });

  it('refuses what it cannot write as a pattern', () => {
    expect(literalPattern('docs\\x.md')).toBeNull();
    expect(literalPattern('')).toBeNull();
    expect(literalPattern('docs/')).toBeNull();
    expect(literalPattern('/abs.md')).toBeNull();
  });
});

describe('default pattern lists', () => {
  const reserved = compilePatterns(DEFAULT_RESERVED_PATTERNS);
  const forbidden = compilePatterns(FORBIDDEN_PATTERNS);

  it.each([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
    '.gitignore',
    '.gitattributes',
    '.github/workflows/ci.yml',
    '.env',
    '.env.production',
    '.claude/settings.json',
    '.mcp.json',
    '.codex/config.toml',
    '.agents/skills/x/SKILL.md',
    '.gemini/settings.json',
    '.vscode/settings.json',
    '.husky/pre-commit',
    'CLAUDE.md',
    'packages/api/AGENTS.md',
    'GEMINI.md',
    'CLAUDE.local.md',
    '.orchestra/x',
  ])('reserves %s', (p) => {
    expect(reserved.match(entry(p))).not.toBeNull();
  });

  it.each(['src/app.ts', 'README.md', 'docs/guide.md', 'test/a.test.ts'])('does not reserve %s', (p) => {
    expect(reserved.match(entry(p))).toBeNull();
  });

  it.each(['.git', '.git/config', '.git/hooks/pre-commit', 'sub/.git', 'sub/.git/HEAD'])('forbids %s', (p) => {
    expect(forbidden.match(entry(p))).not.toBeNull();
  });

  it('does not forbid .gitignore', () => {
    expect(forbidden.match(entry('.gitignore'))).toBeNull();
  });
});
