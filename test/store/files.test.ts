import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPath } from '../../src/repo/canonical.js';
import {
  appendFileSafe,
  ensureRealFolder,
  folderProblem,
  isRetryable,
  isTempName,
  readFileCapped,
  removeTempEntries,
  removeTree,
  tempName,
  writeFileAtomic,
} from '../../src/store/files.js';

const WINDOWS = process.platform === 'win32';
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-files-'));
  scratch.push(dir);
  return dir;
}

function codeError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('writeFileAtomic', () => {
  it('writes and replaces a file, leaving no temporary file behind', async () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    expect(await writeFileAtomic(file, 'one')).toEqual({ ok: true, value: undefined });
    expect(await writeFileAtomic(file, Buffer.from('two'))).toEqual({ ok: true, value: undefined });
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it.skipIf(WINDOWS)('makes files only the user can read', async () => {
    const file = join(tempDir(), 'state.json');
    await writeFileAtomic(file, 'secret-ish');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the previous file when the rename fails, and removes its temporary file', async () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    await writeFileAtomic(file, 'old');
    const failed = await writeFileAtomic(file, 'new', {
      rename: () => Promise.reject(codeError('EIO')),
    });
    expect(failed.ok ? 'ok' : failed.problem.code).toBe('io');
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('retries a rename while another program holds the file', async () => {
    const file = join(tempDir(), 'state.json');
    let calls = 0;
    const { rename } = await import('node:fs/promises');
    const result = await writeFileAtomic(file, 'held', {
      retry: { attempts: 3, delayMs: 1 },
      rename: async (from, to) => {
        calls += 1;
        if (calls < 3) throw codeError('EBUSY');
        await rename(from, to);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe('held');
  });

  it('gives up after the retries', async () => {
    const dir = tempDir();
    const result = await writeFileAtomic(join(dir, 'state.json'), 'x', {
      retry: { attempts: 2, delayMs: 1 },
      rename: () => Promise.reject(codeError('EBUSY')),
    });
    expect(result.ok ? 'ok' : result.problem.message).toMatch(/EBUSY/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses to replace a folder or a link', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'folder'));
    const folder = await writeFileAtomic(join(dir, 'folder'), 'x');
    expect(folder.ok ? 'ok' : folder.problem.code).toBe('not-a-file');
    symlinkSync(join(dir, 'folder'), join(dir, 'link'), 'junction');
    const link = await writeFileAtomic(join(dir, 'link'), 'x');
    expect(link.ok ? 'ok' : link.problem.code).toBe('link');
  });

  it('refuses data over the size limit before writing anything', async () => {
    const dir = tempDir();
    const result = await writeFileAtomic(join(dir, 'big.json'), 'x'.repeat(11), { maxBytes: 10 });
    expect(result.ok ? 'ok' : result.problem.code).toBe('too-large');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a folder that does not exist', async () => {
    const result = await writeFileAtomic(join(tempDir(), 'missing', 'state.json'), 'x');
    expect(result.ok ? 'ok' : result.problem.code).toBe('io');
  });
});

describe('isRetryable', () => {
  it('retries what Windows reports for a file held open, and only "busy" elsewhere', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) expect(isRetryable(codeError(code), 'win32')).toBe(true);
    expect(isRetryable(codeError('EBUSY'), 'linux')).toBe(true);
    expect(isRetryable(codeError('EPERM'), 'linux')).toBe(false);
    expect(isRetryable(codeError('ENOENT'), 'win32')).toBe(false);
    expect(isRetryable('not an error', 'win32')).toBe(false);
  });
});

describe('readFileCapped', () => {
  it('reads a regular file', async () => {
    const file = join(tempDir(), 'a.json');
    writeFileSync(file, 'hello');
    const result = await readFileCapped(file, 100);
    expect(result.ok ? result.value.toString('utf8') : result.problem.code).toBe('hello');
  });

  it('reports a missing file, a folder and a file over the limit', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'big'), 'x'.repeat(101));
    const code = async (path: string): Promise<string> => {
      const result = await readFileCapped(path, 100);
      return result.ok ? 'ok' : result.problem.code;
    };
    expect(await code(join(dir, 'nothing'))).toBe('missing');
    expect(await code(dir)).toBe('not-a-file');
    expect(await code(join(dir, 'big'))).toBe('too-large');
  });

  it('refuses a link to a folder (a junction on Windows)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'junction');
    const result = await readFileCapped(join(dir, 'link'), 100);
    expect(result.ok ? 'ok' : result.problem.code).toBe('link');
  });

  it.skipIf(WINDOWS)('refuses a symlink to a file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'secret'), 'user data');
    symlinkSync(join(dir, 'secret'), join(dir, 'state.json'));
    const result = await readFileCapped(join(dir, 'state.json'), 100);
    expect(result.ok ? 'ok' : result.problem.code).toBe('link');
  });

  it.skipIf(WINDOWS)('refuses a named pipe instead of hanging on it', async () => {
    const pipe = join(tempDir(), 'state.json');
    execFileSync('mkfifo', [pipe]);
    const result = await readFileCapped(pipe, 100);
    expect(result.ok ? 'ok' : result.problem.code).toBe('not-a-file');
  });
});

describe('appendFileSafe', () => {
  it('appends to an existing file', async () => {
    const file = join(tempDir(), 'log.jsonl');
    writeFileSync(file, 'a\n');
    expect((await appendFileSafe(file, 'b\n', { sync: true })).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('a\nb\n');
  });

  it('creates the file only when asked', async () => {
    const dir = tempDir();
    const missing = await appendFileSafe(join(dir, 'log.jsonl'), 'x');
    expect(missing.ok ? 'ok' : missing.problem.code).toBe('missing');
    expect((await appendFileSafe(join(dir, 'out'), 'x', { create: true })).ok).toBe(true);
    expect(readFileSync(join(dir, 'out'), 'utf8')).toBe('x');
  });

  it('refuses a file with a second name (a hard link), so nothing lands in another file', async () => {
    const dir = tempDir();
    const users = join(dir, 'users-file');
    writeFileSync(users, 'precious\n');
    linkSync(users, join(dir, 'log.jsonl'));
    const result = await appendFileSafe(join(dir, 'log.jsonl'), 'junk\n');
    expect(result.ok ? 'ok' : result.problem.code).toBe('link');
    expect(readFileSync(users, 'utf8')).toBe('precious\n');
  });

  it.skipIf(WINDOWS)('refuses a symlink', async () => {
    const dir = tempDir();
    const users = join(dir, 'users-file');
    writeFileSync(users, 'precious\n');
    symlinkSync(users, join(dir, 'log.jsonl'));
    const result = await appendFileSafe(join(dir, 'log.jsonl'), 'junk\n', { create: true });
    expect(result.ok ? 'ok' : result.problem.code).toBe('link');
    expect(readFileSync(users, 'utf8')).toBe('precious\n');
  });

  it('refuses a folder', async () => {
    const result = await appendFileSafe(tempDir(), 'x');
    expect(result.ok ? 'ok' : result.problem.code).toBe('not-a-file');
  });
});

describe('folders', () => {
  it('accepts a real folder and creates a missing one', async () => {
    const dir = tempDir();
    expect(await folderProblem(dir)).toBeNull();
    expect((await folderProblem(join(dir, 'new')))?.code).toBe('missing');
    expect(await ensureRealFolder(join(dir, 'new'))).toBeNull();
    expect(await ensureRealFolder(join(dir, 'new'))).toBeNull();
    expect(lstatSync(join(dir, 'new')).isDirectory()).toBe(true);
  });

  it('refuses a link (a junction on Windows) and a file in place of a folder', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'runs'), 'junction');
    writeFileSync(join(dir, 'file'), 'x');
    expect((await ensureRealFolder(join(dir, 'runs')))?.code).toBe('link');
    expect((await ensureRealFolder(join(dir, 'file')))?.code).toBe('not-a-folder');
  });

  it('reports a folder it cannot create', async () => {
    expect((await ensureRealFolder(join(tempDir(), 'no', 'parent')))?.code).toBe('io');
  });
});

describe('removeTree', () => {
  it('removes a folder tree', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'run', 'tasks', 'api'), { recursive: true });
    writeFileSync(join(dir, 'run', 'tasks', 'api', 'out'), 'x');
    writeFileSync(join(dir, 'run', 'state.json'), 'x');
    await removeTree(join(dir, 'run'));
    expect(existsSync(join(dir, 'run'))).toBe(false);
    await removeTree(join(dir, 'run'));
  });

  it("never deletes through a link inside the tree: the link goes, the user's files stay", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'users'));
    writeFileSync(join(dir, 'users', 'precious.txt'), 'keep me');
    mkdirSync(join(dir, 'run', 'tasks'), { recursive: true });
    symlinkSync(join(dir, 'users'), join(dir, 'run', 'tasks', 'api'), 'junction');
    await removeTree(join(dir, 'run'));
    expect(existsSync(join(dir, 'run'))).toBe(false);
    expect(readFileSync(join(dir, 'users', 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('stops when the folder is not where the caller checked it (a link swapped in on the way)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'users', 'run1'), { recursive: true });
    writeFileSync(join(dir, 'users', 'run1', 'precious.txt'), 'keep me');
    mkdirSync(join(dir, 'real-runs'));
    // The caller checked <dir>/runs as a real folder; then it was swapped for a link to the user's files.
    symlinkSync(join(dir, 'users'), join(dir, 'runs'), 'junction');
    const expected = join(canonicalPath(dir) ?? dir, 'runs', 'run1');
    await expect(removeTree(join(dir, 'runs', 'run1'), { expected })).rejects.toThrow(/moved while it was being deleted/);
    expect(readFileSync(join(dir, 'users', 'run1', 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('removes a link given as the tree itself, not what it points to', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'users'));
    writeFileSync(join(dir, 'users', 'precious.txt'), 'keep me');
    symlinkSync(join(dir, 'users'), join(dir, 'run'), 'junction');
    await removeTree(join(dir, 'run'));
    expect(existsSync(join(dir, 'run'))).toBe(false);
    expect(readFileSync(join(dir, 'users', 'precious.txt'), 'utf8')).toBe('keep me');
  });
});

describe('temporary files', () => {
  it('names temporary files so that readers can tell them apart', () => {
    const name = tempName('state.json');
    expect(name).toMatch(/^\.state\.json\.[0-9a-f]{12}\.tmp$/);
    expect(isTempName(name)).toBe(true);
    expect(tempName('state.json')).not.toBe(name);
    for (const other of ['state.json', '.state.json.tmp', 'state.json.0123456789ab.tmp', '.x.0123456789AB.tmp']) {
      expect(isTempName(other)).toBe(false);
    }
  });

  it('removes leftover temporary files and folders only', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), 'keep');
    writeFileSync(join(dir, tempName('state.json')), 'stray');
    mkdirSync(join(dir, tempName('run1')));
    writeFileSync(join(dir, '.hidden'), 'keep');
    const result = await removeTempEntries(dir);
    expect(result).toEqual({ removed: 2, problems: [] });
    expect(readdirSync(dir).sort()).toEqual(['.hidden', 'state.json']);
  });

  it('reports a folder it cannot list', async () => {
    const result = await removeTempEntries(join(tempDir(), 'missing'));
    expect(result.removed).toBe(0);
    expect(result.problems).toHaveLength(1);
  });
});
