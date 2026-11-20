import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalPath, isInsidePath, samePath } from '../../src/repo/canonical.js';

const root = mkdtempSync(join(tmpdir(), 'orch-canon-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('canonicalPath', () => {
  it('resolves to an absolute real path without a trailing separator', () => {
    const dir = join(root, 'a');
    mkdirSync(dir);
    expect(canonicalPath(`${dir}/`)).toBe(canonicalPath(dir));
  });

  it('returns null for a path that does not exist', () => {
    expect(canonicalPath(join(root, 'missing'))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('follows symlinks', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(canonicalPath(link)).toBe(canonicalPath(target));
  });
});

describe('samePath', () => {
  it('compares case-insensitively when asked', () => {
    expect(samePath('C:\\Repo\\App', 'c:\\repo\\app', true)).toBe(true);
    expect(samePath('/repo/App', '/repo/app', false)).toBe(false);
  });

  it('treats slashes alike and ignores a trailing separator', () => {
    expect(samePath('C:/repo/app/', 'C:\\repo\\app', true)).toBe(true);
  });


  it('treats the two Unicode forms of a name alike', () => {
    expect(samePath('/repo/caf\u00e9', '/repo/cafe\u0301', false)).toBe(true);
  });
});

describe('isInsidePath', () => {
  it('accepts the folder itself and anything below it', () => {
    expect(isInsidePath('/home/wt', '/home/wt', false)).toBe(true);
    expect(isInsidePath('/home/wt/run/api', '/home/wt', false)).toBe(true);
  });

  it('compares whole segments, never a bare prefix', () => {
    expect(isInsidePath('/repo-evil/x', '/repo', false)).toBe(false);
    expect(isInsidePath('/home', '/home/wt', false)).toBe(false);
  });

  it('follows the case rule and Windows separators', () => {
    expect(isInsidePath('C:\\Users\\Me\\Repo\\src', 'c:/users/me/repo', true)).toBe(true);
    expect(isInsidePath('/Repo/src', '/repo', false)).toBe(false);
  });

  it('handles roots', () => {
    expect(isInsidePath('/anything', '/', false)).toBe(true);
    expect(isInsidePath('C:\\x', 'C:\\', true)).toBe(true);
  });
});
