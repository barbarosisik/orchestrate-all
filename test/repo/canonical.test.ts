import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalPath, isAllowedRepo, samePath } from '../../src/repo/canonical.js';

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
});

describe('isAllowedRepo', () => {
  const allowed = join(root, 'allowed');
  mkdirSync(allowed);

  it('accepts a listed repo', () => {
    expect(isAllowedRepo(allowed, [allowed])).toBe(true);
  });

  it('accepts a listed repo written with a trailing separator', () => {
    expect(isAllowedRepo(allowed, [`${allowed}/`])).toBe(true);
  });

  it('rejects a repo that is not listed, even inside a listed one', () => {
    const inner = join(allowed, 'inner');
    mkdirSync(inner);
    expect(isAllowedRepo(inner, [allowed])).toBe(false);
  });

  it('ignores allowlist entries that do not exist', () => {
    expect(isAllowedRepo(allowed, [join(root, 'nope')])).toBe(false);
  });

  it('rejects everything with an empty allowlist', () => {
    expect(isAllowedRepo(allowed, [])).toBe(false);
  });
});
