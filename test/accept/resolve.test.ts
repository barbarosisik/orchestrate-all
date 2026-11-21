import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchLaunch, findProgramFile, resolveCommand } from '../../src/accept/resolve.js';

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-resolve-'));
  scratch.push(dir);
  return dir;
}

/** Creates an executable file (content doesn't matter: nothing is started here). */
function program(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

const WINDOWS_ENV = (bin: string, systemRoot: string): NodeJS.ProcessEnv => ({
  PATH: bin,
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
  SystemRoot: systemRoot,
});

describe('resolveCommand on this system', () => {
  it('finds a bare name in PATH, never in the folder the command runs in', () => {
    const worktree = tempDir();
    const bin = tempDir();
    const name = process.platform === 'win32' ? 'tool.exe' : 'tool';
    program(worktree, name);
    const real = program(bin, name);
    const result = resolveCommand(['tool', '--flag'], { cwd: worktree, env: { PATH: ['.', '', bin].join(delimiter), PATHEXT: '.EXE' } });
    expect(result).toEqual({ ok: true, launch: { program: real, args: ['--flag'], windowsVerbatimArguments: false } });
  });

  it('reads a name with a folder as a file of the project', () => {
    const worktree = tempDir();
    const name = process.platform === 'win32' ? 'check.exe' : 'check.sh';
    const file = program(join(worktree, 'scripts'), name);
    const result = resolveCommand([`scripts/${name}`], { cwd: worktree, env: { PATH: '' } });
    expect(result.ok && result.launch.program).toBe(file);
  });

  it('uses an absolute path as it is', () => {
    const result = resolveCommand([process.execPath, '-v'], { cwd: tempDir(), env: {} });
    expect(result.ok && result.launch).toEqual({ program: process.execPath, args: ['-v'], windowsVerbatimArguments: false });
  });

  it('reports an empty command and a program it cannot find', () => {
    const cwd = tempDir();
    expect(resolveCommand([], { cwd, env: {} })).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(resolveCommand([''], { cwd, env: {} })).toMatchObject({ ok: false, error: { code: 'empty' } });
    const missing = resolveCommand(['no-such-tool'], { cwd, env: { PATH: tempDir() } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(missing.ok ? '' : missing.error.message).toContain("PATH's folders");
    const missingFile = resolveCommand(['./nope.sh'], { cwd, env: {} });
    expect(missingFile.ok ? '' : missingFile.error.message).toContain('in the worktree');
  });
});

describe('resolveCommand for Windows', () => {
  const win = { platform: 'win32' as const };

  it('tries PATHEXT extensions in order, and only ones Windows can start', () => {
    const bin = tempDir();
    program(bin, 'tool.js');
    const exe = program(bin, 'tool.exe');
    program(bin, 'tool.cmd');
    const result = resolveCommand(['tool'], { cwd: tempDir(), env: WINDOWS_ENV(bin, tempDir()), ...win });
    expect(result.ok && result.launch.program).toBe(exe);
    const onlyScript = tempDir();
    program(onlyScript, 'other.js');
    expect(findProgramFile('other', { cwd: tempDir(), env: WINDOWS_ENV(onlyScript, tempDir()), ...win })).toBeNull();
  });

  it('keeps an extension the name already has', () => {
    const bin = tempDir();
    const cmd = program(bin, 'tool.cmd');
    program(bin, 'tool.cmd.exe');
    expect(findProgramFile('tool.cmd', { cwd: tempDir(), env: WINDOWS_ENV(bin, tempDir()), ...win })).toBe(cmd);
  });

  it("runs npm and npx with node and their real script, where Node's installer puts them", () => {
    const bin = tempDir();
    program(bin, 'npm.cmd');
    program(bin, 'npx.cmd');
    const node = program(bin, 'node.exe');
    const npmCli = program(join(bin, 'node_modules', 'npm', 'bin'), 'npm-cli.js');
    const npxCli = program(join(bin, 'node_modules', 'npm', 'bin'), 'npx-cli.js');
    const env = WINDOWS_ENV(bin, tempDir());
    expect(resolveCommand(['npm', 'test', '--', '--coverage'], { cwd: tempDir(), env, ...win })).toEqual({
      ok: true,
      launch: { program: node, args: [npmCli, 'test', '--', '--coverage'], windowsVerbatimArguments: false },
    });
    const npx = resolveCommand(['npx', 'vitest'], { cwd: tempDir(), env, ...win });
    expect(npx.ok && npx.launch.args).toEqual([npxCli, 'vitest']);
  });

  it('falls back to the running node when npm has no node.exe beside it', () => {
    const bin = tempDir();
    program(bin, 'npm.cmd');
    program(join(bin, 'node_modules', 'npm', 'bin'), 'npm-cli.js');
    const result = resolveCommand(['npm', 'test'], { cwd: tempDir(), env: WINDOWS_ENV(bin, tempDir()), ...win });
    expect(result.ok && result.launch.program).toBe(process.execPath);
  });

  it('runs other batch files through cmd.exe with every argument quoted', () => {
    const bin = tempDir();
    const gradlew = program(bin, 'gradlew.bat');
    const systemRoot = tempDir();
    const result = resolveCommand(['gradlew', 'test', '--tests', 'a b', 'x=1,y;z'], {
      cwd: tempDir(),
      env: WINDOWS_ENV(bin, systemRoot),
      ...win,
    });
    expect(result).toEqual({
      ok: true,
      launch: {
        program: join(systemRoot, 'System32', 'cmd.exe'),
        args: ['/d', '/s', '/c', `""${gradlew}" "test" "--tests" "a b" "x=1,y;z""`],
        windowsVerbatimArguments: true,
      },
    });
  });

  it('refuses arguments cmd.exe or the batch file could act on', () => {
    const bin = tempDir();
    program(bin, 'tool.cmd');
    const env = WINDOWS_ENV(bin, tempDir());
    for (const arg of ['a"b', '%PATH%', '!x!', 'a^b', 'a&calc', 'a|b', '<in', '>out', '(x)', 'line\nbreak', 'C:\\dir\\']) {
      const result = resolveCommand(['tool', arg], { cwd: tempDir(), env, ...win });
      expect(result.ok ? 'ok' : result.error.code, JSON.stringify(arg)).toBe('unsafe-argument');
    }
  });

  it('refuses a batch file whose path cmd.exe would act on, and needs SystemRoot', () => {
    const systemRoot = tempDir();
    expect(batchLaunch('C:\\a%b\\tool.cmd', [], { SystemRoot: systemRoot })).toMatchObject({
      ok: false,
      error: { code: 'unsafe-argument' },
    });
    const parens = batchLaunch('C:\\Program Files (x86)\\tool.cmd', [], { SystemRoot: systemRoot });
    expect(parens.ok).toBe(true);
    expect(batchLaunch('C:\\tool.cmd', [], {})).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(batchLaunch('C:\\tool.cmd', [], { SYSTEMROOT: 'Windows' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});
