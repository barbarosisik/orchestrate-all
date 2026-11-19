import { describe, expect, it } from 'vitest';
import { parseOwnsEntry, type OwnsEntry } from '../../src/plan/paths.js';
import { compilePatterns } from '../../src/plan/reserved.js';
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
