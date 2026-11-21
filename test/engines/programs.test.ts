import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineLaunch, ENGINE_COMMANDS } from '../../src/engines/programs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-prog-'));
  dirs.push(dir);
  return dir;
}

function runnable(path: string, content = '#!/bin/sh\n'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

describe('engineLaunch', () => {
  it('names the program each engine is started with', () => {
    expect(ENGINE_COMMANDS).toEqual({ claude: 'claude', codex: 'codex', antigravity: 'agy' });
  });

  it.skipIf(process.platform === 'win32')("finds an engine in PATH's absolute folders", () => {
    const bin = tempDir();
    const file = runnable(join(bin, 'codex'));
    const result = engineLaunch('codex', ['exec', '-'], { cwd: tempDir(), env: { PATH: bin } });
    expect(result).toEqual({ ok: true, launch: { program: file, args: ['exec', '-'], windowsVerbatimArguments: false } });
  });

  it('never looks in the folder the worker runs in, nor in relative PATH entries', () => {
    const worktree = tempDir();
    runnable(join(worktree, 'claude'));
    runnable(join(worktree, 'claude.exe'));
    const result = engineLaunch('claude', [], { cwd: worktree, env: { PATH: ['.', '', 'relative/bin'].join(delimiter) } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('"claude" was not found');
  });

  it("starts npm's Windows shims for Claude Code and Codex through node, so no argument passes through cmd.exe", () => {
    const bin = tempDir();
    runnable(join(bin, 'claude.cmd'));
    const claudeScript = runnable(join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
    runnable(join(bin, 'codex.cmd'));
    const codexScript = runnable(join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    const env = { PATH: bin, PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows' };
    const claude = engineLaunch('claude', ['--settings', 'C:\\Users\\A (x)\\s.json'], { cwd: tempDir(), env, platform: 'win32' });
    expect(claude).toMatchObject({ ok: true, launch: { args: [claudeScript, '--settings', 'C:\\Users\\A (x)\\s.json'], windowsVerbatimArguments: false } });
    const codex = engineLaunch('codex', ['exec', '-'], { cwd: tempDir(), env, platform: 'win32' });
    expect(codex).toMatchObject({ ok: true, launch: { args: [codexScript, 'exec', '-'] } });
  });

  it('uses an absolute program path from the config instead of PATH', () => {
    const elsewhere = tempDir();
    // Windows starts only files with a program extension (PATHEXT).
    const file = runnable(join(elsewhere, process.platform === 'win32' ? 'my-claude.exe' : 'my-claude'));
    const result = engineLaunch('claude', ['-p'], { cwd: tempDir(), env: { PATH: '' }, program: file });
    expect(result).toMatchObject({ ok: true, launch: { program: file, args: ['-p'] } });
  });

  it('refuses a configured program path that is not absolute (it would be looked up in the worktree)', () => {
    const worktree = tempDir();
    runnable(join(worktree, 'bin', 'claude'));
    const result = engineLaunch('claude', [], { cwd: worktree, env: { PATH: '' }, program: 'bin/claude' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('absolute');
  });

  it('reports a configured program that does not exist', () => {
    const result = engineLaunch('codex', [], { cwd: tempDir(), env: { PATH: '' }, program: join(tempDir(), 'nope') });
    expect(result.ok).toBe(false);
  });
});
