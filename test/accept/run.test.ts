import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputCapture, runAcceptance, runCommand } from '../../src/accept/run.js';

const NODE = process.execPath;
const WINDOWS = process.platform === 'win32';
const scratch: string[] = [];
afterEach(() => {
  // Retries: on Windows a process that was just stopped may still hold its folder for a moment.
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-run-'));
  scratch.push(dir);
  return dir;
}

/** A node command running `code`. */
function node(code: string): string[] {
  return [NODE, '-e', code];
}

/** Code that starts a child node process which writes `file` after `ms`, without waiting for it. */
function leaveChildWriting(file: string, ms: number): string {
  const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(file)}, 'x'), ${ms})`;
  // unref(): the command itself doesn't wait for the child.
  return `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }).unref();`;
}

describe('OutputCapture', () => {
  it('keeps everything under the limit', () => {
    const capture = new OutputCapture(100);
    capture.add(Buffer.from('hello '));
    capture.add(Buffer.from('world'));
    expect(capture.result()).toEqual({ text: 'hello world', totalBytes: 11, truncated: false });
  });

  it('keeps the start and the end, and says how much was left out', () => {
    const capture = new OutputCapture(8);
    for (const part of ['ab', 'cdef', 'ghij', 'klmnop', 'qr']) capture.add(Buffer.from(part));
    const result = capture.result();
    expect(result.totalBytes).toBe(18);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('ab\n[... 10 bytes left out ...]\nmnopqr');
  });
});

describe('runCommand', () => {
  it('records a passing command: exit code, output and time', async () => {
    const result = await runCommand(tempDir(), node('console.log("hi"); console.error("warn")'));
    expect(result).toMatchObject({ status: 'passed', exitCode: 0, program: NODE, error: null });
    expect(result.stdout.text.trim()).toBe('hi');
    expect(result.stderr.text.trim()).toBe('warn');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failing command', async () => {
    const result = await runCommand(tempDir(), node('process.exit(3)'));
    expect(result).toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('runs in the given folder', async () => {
    const dir = tempDir();
    const result = await runCommand(dir, node('console.log(process.cwd())'));
    expect(realpathSync(result.stdout.text.trim())).toBe(realpathSync(dir));
  });

  it('finds a bare program name in PATH', async () => {
    const result = await runCommand(tempDir(), ['node', '-e', 'console.log(1 + 1)']);
    expect(result.status).toBe('passed');
    expect(result.stdout.text.trim()).toBe('2');
  });

  it('runs npm (on Windows through its real script, not npm.cmd)', async () => {
    const result = await runCommand(tempDir(), ['npm', '--version']);
    expect(result.status, result.stderr.text).toBe('passed');
    expect(result.stdout.text.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('hides secrets from the command and sets CI', async () => {
    const env = { ...process.env, SECRET_API_KEY: 'sk-123', GIT_DIR: '/evil' };
    const result = await runCommand(
      tempDir(),
      node('console.log(JSON.stringify([process.env.CI, process.env.SECRET_API_KEY ?? null, process.env.GIT_DIR ?? null]))'),
      { env },
    );
    expect(JSON.parse(result.stdout.text)).toEqual(['true', null, null]);
  });

  it('reports a command that could not be started', async () => {
    const result = await runCommand(tempDir(), ['definitely-not-a-program-xyz']);
    expect(result).toMatchObject({ status: 'not-started', program: null, exitCode: null });
    expect(result.error).toContain('was not found');
  });

  it('stops a command at its time limit', async () => {
    const started = Date.now();
    const result = await runCommand(tempDir(), node('setTimeout(() => {}, 60000)'), { timeoutMs: 500 });
    expect(result.status).toBe('timed-out');
    expect(result.error).toContain('Stopped after');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('stops the whole process tree at the time limit', async () => {
    const dir = tempDir();
    const marker = join(dir, 'grandchild-ran.txt');
    const code = `${leaveChildWriting(marker, 2500)} setTimeout(() => {}, 60000);`;
    const result = await runCommand(dir, node(code), { timeoutMs: 1000 });
    expect(result.status).toBe('timed-out');
    await delay(3000);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(WINDOWS)('stops processes a command leaves running when it exits', async () => {
    const dir = tempDir();
    const marker = join(dir, 'leftover-ran.txt');
    const result = await runCommand(dir, node(leaveChildWriting(marker, 1500)));
    expect(result.status).toBe('passed');
    await delay(2500);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a file that is found but is not a program, without throwing', async () => {
    const dir = tempDir();
    const file = join(dir, WINDOWS ? 'bad.exe' : 'bad');
    writeFileSync(file, 'this is not a program\n');
    chmodSync(file, 0o755);
    const result = await runCommand(dir, [file]);
    // macOS and Windows refuse to start it; Linux hands a file without "#!" to sh, which then fails.
    expect(['not-started', 'failed']).toContain(result.status);
    expect(result.program).toBe(file);
  });

  it("doesn't wait forever for output a process outside the command's tree keeps open", async () => {
    // The child starts its own process group, so it survives the command, and keeps stdout open.
    const code =
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], " +
      "{ detached: true, cwd: require('node:os').tmpdir(), stdio: ['ignore', 'inherit', 'inherit'] }); " +
      'console.log(c.pid); c.unref();';
    const result = await runCommand(tempDir(), node(code));
    try {
      expect(result.status).toBe('passed');
      expect(result.error).toContain('output stayed open');
    } finally {
      const pid = Number(result.stdout.text.trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
      }
    }
  });

  it('takes a time limit too long for a timer as the longest one, instead of stopping the command at once', async () => {
    for (const timeoutMs of [2 ** 31, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      const result = await runCommand(tempDir(), node('setTimeout(() => {}, 300)'), { timeoutMs });
      expect(result.status, String(timeoutMs)).toBe('passed');
    }
  });

  it('keeps output within the limit', async () => {
    const result = await runCommand(tempDir(), node('process.stdout.write("x".repeat(100000))'), { maxOutputBytes: 1000 });
    expect(result.stdout.totalBytes).toBe(100000);
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.text.length).toBeLessThan(1100);
    expect(result.stdout.text).toContain('bytes left out');
  });
});

describe.runIf(WINDOWS)('runCommand with a Windows batch file', () => {
  function echoArgs(dir: string): string {
    const file = join(dir, 'echo-args.cmd');
    writeFileSync(file, `@"${NODE}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    return file;
  }

  it('passes plain arguments through cmd.exe unchanged', async () => {
    const dir = tempDir();
    const result = await runCommand(dir, [echoArgs(dir), 'a b', 'c=d', 'e,f;g', '*.ts']);
    expect(result.status, result.stderr.text).toBe('passed');
    expect(JSON.parse(result.stdout.text)).toEqual(['a b', 'c=d', 'e,f;g', '*.ts']);
  });

  it('refuses an argument that could run another command', async () => {
    const dir = tempDir();
    const result = await runCommand(dir, [echoArgs(dir), 'x&echo INJECTED']);
    expect(result.status).toBe('not-started');
    expect(result.error).toContain("can't be passed safely");
  });
});

describe('runAcceptance', () => {
  it('runs every command, even after one fails', async () => {
    const dir = tempDir();
    const result = await runAcceptance(dir, [node('process.exit(1)'), node('console.log("second")')]);
    expect(result.passed).toBe(false);
    expect(result.commands.map((c) => c.status)).toEqual(['failed', 'passed']);
  });

  it('passes when every command passes, or when there are none', async () => {
    expect((await runAcceptance(tempDir(), [node(''), node('')])).passed).toBe(true);
    expect(await runAcceptance(tempDir(), [])).toEqual({ passed: true, commands: [] });
  });
});
