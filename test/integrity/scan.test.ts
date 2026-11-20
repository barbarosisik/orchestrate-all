import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffRecords, fingerprintFolder, fingerprintPath, isEmptyDiff } from '../../src/integrity/fingerprint.js';
import { isGitName, scanForNestedGit } from '../../src/integrity/nested.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-scan-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(rel: string, content = 'x\n'): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('fingerprintPath', () => {
  it('tells files, folders and missing paths apart, and files by content', async () => {
    file('a.txt', 'one\n');
    file('b.txt', 'one\n');
    file('c.txt', 'two\n');
    expect(await fingerprintPath(join(root, 'missing'))).toBe('missing');
    expect(await fingerprintPath(root)).toBe('dir');
    expect(await fingerprintPath(join(root, 'a.txt'))).toMatch(/^file:[0-9a-f]{64}$/);
    expect(await fingerprintPath(join(root, 'a.txt'))).toBe(await fingerprintPath(join(root, 'b.txt')));
    expect(await fingerprintPath(join(root, 'a.txt'))).not.toBe(await fingerprintPath(join(root, 'c.txt')));
  });

  it.skipIf(process.platform === 'win32')('records a symlink by its target, without following it', async () => {
    file('target.txt');
    symlinkSync(join(root, 'target.txt'), join(root, 'link'));
    expect(await fingerprintPath(join(root, 'link'))).toBe(`link:${join(root, 'target.txt')}`);
  });
});

describe('fingerprintFolder', () => {
  it('covers the folder and everything below it', async () => {
    file('hooks/pre-commit');
    file('hooks/sub/deep');
    const record = await fingerprintFolder(join(root, 'hooks'), 'hooks');
    expect(Object.keys(record).sort()).toEqual(['hooks', 'hooks/pre-commit', 'hooks/sub', 'hooks/sub/deep']);
  });

  it('gives a single "missing" entry for a folder that does not exist', async () => {
    expect(await fingerprintFolder(join(root, 'nope'), 'info')).toEqual({ info: 'missing' });
  });
});

describe('diffRecords', () => {
  it('lists added, removed and changed keys', () => {
    const diff = diffRecords({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' });
    expect(diff).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] });
    expect(isEmptyDiff(diff)).toBe(false);
    expect(isEmptyDiff(diffRecords({ a: '1' }, { a: '1' }))).toBe(true);
  });
});

describe('scanForNestedGit', () => {
  it("ignores the worktree's own .git and ordinary files", async () => {
    file('.git', 'gitdir: /somewhere\n');
    file('src/a.ts');
    file('src/.gitignore');
    file('src/.github/workflows/ci.yml');
    expect(await scanForNestedGit(root)).toEqual({ findings: [], complete: true });
  });

  it('finds nested .git folders and files in any letter case', async () => {
    mkdirSync(join(root, 'vendor', 'lib', '.git'), { recursive: true });
    file('src/sub/.git', 'gitdir: /elsewhere\n');
    file('docs/.GIT', 'gitdir: /elsewhere\n');
    const scan = await scanForNestedGit(root);
    expect(scan.findings).toEqual([
      { path: 'docs/.GIT', kind: 'git-entry' },
      { path: 'src/sub/.git', kind: 'git-entry' },
      { path: 'vendor/lib/.git', kind: 'git-entry' },
    ]);
  });

  it('finds a folder laid out like a bare repository', async () => {
    file('build/cache/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(root, 'build/cache/objects'), { recursive: true });
    mkdirSync(join(root, 'build/cache/refs'), { recursive: true });
    expect((await scanForNestedGit(root)).findings).toEqual([{ path: 'build/cache', kind: 'repo-layout' }]);
  });

  it('finds a git folder split in two: HEAD with a commondir file, and objects and refs elsewhere', async () => {
    file('src/api/a/HEAD', 'ref: refs/heads/main\n');
    file('src/api/a/commondir', '../b\n');
    file('src/api/b/config', '[core]\n\tpager = evil\n');
    mkdirSync(join(root, 'src/api/b/objects'), { recursive: true });
    mkdirSync(join(root, 'src/api/b/refs'), { recursive: true });
    // "b" alone has no HEAD, so git won't use it; "a" is the way in.
    expect((await scanForNestedGit(root)).findings).toEqual([{ path: 'src/api/a', kind: 'repo-layout' }]);
  });

  it('finds .git names that Windows or macOS would treat as .git', async () => {
    const names = ['.g\u200cit', '.gi\ufefft'];
    // Windows itself can't create names ending in a dot or a space.
    if (process.platform !== 'win32') names.push('.git.', '.git ');
    names.forEach((name, i) => file(`d${i}/${name}/x`));
    expect((await scanForNestedGit(root)).findings.map((x) => x.kind)).toEqual(names.map(() => 'git-entry'));
  });

  it.skipIf(process.platform === 'win32')('does not follow symlinked folders', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orch-outside-'));
    try {
      mkdirSync(join(outside, 'repo', '.git'), { recursive: true });
      symlinkSync(outside, join(root, 'linked'), 'dir');
      expect(await scanForNestedGit(root)).toEqual({ findings: [], complete: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports an incomplete scan when it hits the entry limit', async () => {
    for (let i = 0; i < 5; i++) file(`f${i}.txt`);
    expect((await scanForNestedGit(root, 3)).complete).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an incomplete scan when a folder cannot be read',
    async () => {
      file('locked/a.txt');
      chmodSync(join(root, 'locked'), 0o000);
      try {
        expect((await scanForNestedGit(root)).complete).toBe(false);
      } finally {
        chmodSync(join(root, 'locked'), 0o755);
      }
    },
  );
});

describe('isGitName', () => {
  it('folds case, trailing dots and spaces, and characters macOS ignores', () => {
    for (const name of ['.git', '.GIT', '.Git.', '.git  ', '.g\u200cit', '\u200d.git', '.git\u206a']) {
      expect(isGitName(name)).toBe(true);
    }
    for (const name of ['git', '.gitignore', '.git-x', '..git', '.gi', 'x.git']) expect(isGitName(name)).toBe(false);
  });
});
