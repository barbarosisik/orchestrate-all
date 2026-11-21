import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { absolutePathFolders, isRunnableFile, pathValue } from '../../src/os/path-search.js';

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-search-'));
  scratch.push(dir);
  return dir;
}

describe('pathValue', () => {
  it('reads PATH whatever its spelling', () => {
    expect(pathValue({ PATH: 'a' })).toBe('a');
    expect(pathValue({ Path: 'b' })).toBe('b');
    expect(pathValue({})).toBe('');
  });
});

describe('absolutePathFolders', () => {
  it('keeps absolute folders in order, unquoted, and drops empty, "." and relative entries', () => {
    const a = tempDir();
    const b = join(tempDir(), 'with space');
    expect(absolutePathFolders({ PATH: [a, '', '.', 'rel', `"${b}"`].join(delimiter) })).toEqual([a, b]);
  });
});

describe('isRunnableFile', () => {
  it('accepts a program file and refuses folders and missing files', () => {
    const dir = tempDir();
    const file = join(dir, 'tool');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    mkdirSync(join(dir, 'folder'));
    expect(isRunnableFile(file)).toBe(true);
    expect(isRunnableFile(join(dir, 'folder'))).toBe(false);
    expect(isRunnableFile(join(dir, 'missing'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a file that is not executable', () => {
    const file = join(tempDir(), 'tool');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    expect(isRunnableFile(file)).toBe(false);
  });
});
