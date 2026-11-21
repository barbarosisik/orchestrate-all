import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorker, type WorkerOptions } from '../../src/engines/worker.js';
import { createRun, readOutput, readRunLog, type RunStore, type StoreOptions } from '../../src/store/run.js';
import type { TaskWorktree } from '../../src/worktree/manager.js';
import { fakeEnv, installFakeEngine } from '../helpers/fake-engine.js';
import { BASE, NOW, sampleReady, type SampleTask } from '../helpers/store.js';

const RUN = '20261121-120000-abcd';
const WINDOWS = process.platform === 'win32';
const scratch: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix = 'orch-worker-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const TASKS: SampleTask[] = [
  { id: 'api', engine: 'claude', model: 'opus' },
  { id: 'ui', engine: 'codex', model: 'gpt-6-codex' },
  { id: 'docs', engine: 'antigravity', model: 'gemini-4-neon' },
];

interface Setup {
  readonly store: RunStore;
  readonly home: string;
  readonly bin: string;
  worktree(taskId: string): TaskWorktree;
}

async function setup(opts: StoreOptions = {}): Promise<Setup> {
  const root = tempDir();
  const home = join(root, 'home');
  const created = await createRun(home, { runId: RUN, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true }, { now: () => NOW, ...opts });
  if (!created.ok) throw new Error(created.problem.message);
  stores.push(created.value);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return {
    store: created.value,
    home,
    bin,
    worktree(taskId: string): TaskWorktree {
      const path = join(home, 'wt', RUN, taskId);
      mkdirSync(path, { recursive: true });
      return { runId: RUN, taskId, path, branch: `orchestra/${RUN}/${taskId}`, ref: '', startSha: BASE, adminDir: '', lockReason: '', worktreeConfig: 'missing' };
    },
  };
}

const CLAUDE_OK = [
  { type: 'system', subtype: 'init', session_id: 's-1', permissionMode: 'acceptEdits', apiKeySource: 'none', mcp_servers: [], tools: ['Read', 'Edit'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'All done.',
    session_id: 's-1',
    total_cost_usd: 0.5,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
    permission_denials: [],
  },
];

function options(s: Setup, taskId: string, extra: Partial<WorkerOptions> = {}): WorkerOptions {
  return { store: s.store, worktree: s.worktree(taskId), round: 0, brief: `Brief for ${taskId}.`, env: fakeEnv(s.bin), now: () => NOW, ...extra };
}

async function outputText(s: Setup, taskId: string, round: number, stream: 'stdout' | 'stderr', opts: StoreOptions = {}): Promise<string | null> {
  const read = await readOutput(s.home, RUN, taskId, round, stream, opts);
  if (!read.ok) throw new Error(read.problem.message);
  return read.value === null ? null : read.value.data.toString('utf8');
}

describe('runWorker with Claude Code', () => {
  it('runs the worker locked down, saves its output and records the run in the store', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK, stderr: 'diagnostics\n' } });
    const env = fakeEnv(s.bin, { ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp', GIT_DIR: '/x' });
    const outcome = await runWorker(options(s, 'api', { env }));

    expect(outcome.status).toBe('completed');
    expect(outcome.error).toBeNull();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.engine).toBe('claude');
    expect(outcome.model).toBe('opus');
    expect(outcome.report.result).toBe('All done.');
    expect(outcome.report.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: null, costUsd: 0.5 });
    expect(outcome.storeProblems).toEqual([]);

    const [call] = fake.calls();
    expect(call?.stdin).toBe('Brief for api.');
    expect(realpathSync(call?.cwd ?? '')).toBe(realpathSync(s.worktree('api').path));
    expect(call?.argv.slice(0, 8)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--permission-mode', 'acceptEdits']);
    expect(call?.argv).toContain('--strict-mcp-config');
    expect(call?.argv.slice(-3)).toEqual(['--disallowedTools', 'Bash', 'Monitor']);
    expect(JSON.parse(call?.settings ?? '')).toEqual({ disableAllHooks: true });
    for (const name of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GIT_DIR']) expect(call?.env[name], name).toBeUndefined();
    expect(call?.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');

    const task = s.store.state.tasks.find((t) => t.id === 'api');
    expect(task?.workers).toEqual([
      {
        round: 0,
        engine: 'claude',
        model: 'opus',
        startedAt: NOW.toISOString(),
        endedAt: NOW.toISOString(),
        exitCode: 0,
        error: null,
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: null, costUsd: 0.5 },
      },
    ]);

    const stdout = await outputText(s, 'api', 0, 'stdout');
    expect(stdout?.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['system', 'assistant', 'result']);
    expect(await outputText(s, 'api', 0, 'stderr')).toBe('diagnostics\n');

    const log = await readRunLog(s.home, RUN);
    expect(log.ok && log.value.records.filter((r) => r.kind === 'worker').map((r) => (r.kind === 'worker' ? [r.event, r.exitCode] : []))).toEqual([
      ['started', null],
      ['finished', 0],
    ]);
  });

  it('keeps the shell tools when the run allows them', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    await runWorker(options(s, 'api', { shell: true }));
    expect(fake.calls()[0]?.argv).not.toContain('--disallowedTools');
  });

  it('fails a run the engine reports as unfinished, with its reason', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', {
      run: { stdout: [CLAUDE_OK[0] as object, { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }], exitCode: 1 },
    });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBe('Claude stopped at its turn limit.');
    const run = s.store.state.tasks.find((t) => t.id === 'api')?.workers[0];
    expect(run?.exitCode).toBe(1);
    expect(run?.error).toBe('Claude stopped at its turn limit.');
  });

  it('says how a run ended before the conditions it could not confirm', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { exitCode: 7 } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.error).toBe(
      'Claude Code exited with code 7. Claude did not report how it started (no init event), so its billing and permission mode could not be checked.',
    );
  });

  it('fails a run that reports success without an init event (its billing was never confirmed)', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: [CLAUDE_OK[2] as object] } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.report.billing).toBe('unknown');
    expect(outcome.error).toBe('Claude did not report how it started (no init event), so its billing and permission mode could not be checked.');
  });

  it('fails a run that exits 0 without a final result', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: [CLAUDE_OK[0] as object] } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('Claude Code ended without a final result.');
  });

  it('fails a run that says "success" but exits with an error code', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK, exitCode: 3 } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('Claude Code exited with code 3.');
  });

  it('fails a run that broke one of its conditions, even when it reports success', async () => {
    const s = await setup();
    const init = { ...(CLAUDE_OK[0] as object), apiKeySource: 'ANTHROPIC_API_KEY' };
    installFakeEngine(s.bin, 'claude', { run: { stdout: [init, ...CLAUDE_OK.slice(1)] } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.report.billing).toBe('api');
    expect(outcome.error).toBe('Claude ran on ANTHROPIC_API_KEY instead of your subscription.');
  });

  it('keeps reading after an over-long line and still finds the result', async () => {
    const s = await setup({ maxOutputBytes: 64 * 1024 });
    installFakeEngine(s.bin, 'claude', { run: { fillerBytes: 9 * 1024 * 1024, stdout: CLAUDE_OK } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('completed');
    expect(outcome.report.unreadableLines).toBe(1);
    expect(outcome.output.stdout?.truncated).toBe(true);
    const stdout = await outputText(s, 'api', 0, 'stdout', { maxOutputBytes: 64 * 1024 });
    expect(stdout).toContain('bytes left out by Orchestra');
    expect(stdout).toContain('"All done."');
  });
});

describe('runWorker with Codex and Antigravity', () => {
  it('runs Codex in its sandbox with the brief on stdin', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'codex', {
      run: {
        stdout: [
          { type: 'thread.started', thread_id: 't-1' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } },
        ],
      },
    });
    const env = fakeEnv(s.bin, { CODEX_API_KEY: 'sk-codex', OPENAI_API_KEY: 'sk-openai' });
    const outcome = await runWorker(options(s, 'ui', { env }));
    expect(outcome.status).toBe('completed');
    expect(outcome.report.tokens).toEqual({ input: 10, output: 2, cacheRead: 4, cacheWrite: null, reasoning: 1, costUsd: null });
    const [call] = fake.calls();
    expect(call?.stdin).toBe('Brief for ui.');
    expect(call?.argv).toContain('workspace-write');
    expect(call?.argv.at(-1)).toBe('-');
    expect(realpathSync(call?.argv[call.argv.indexOf('--cd') + 1] ?? '')).toBe(realpathSync(s.worktree('ui').path));
    expect(call?.env.CODEX_API_KEY).toBeUndefined();
    expect(call?.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('runs Antigravity on the API key, with the brief as a stream-json line', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'antigravity', {
      run: { stdout: [{ event: 'init', conversation_id: 'c-1' }, { event: 'result', result: { status: 'SUCCESS', response: 'ok', usage: { input_tokens: 3, output_tokens: 4 } } }] },
    });
    const env = fakeEnv(s.bin, { GEMINI_API_KEY: 'AIza-key', GOOGLE_API_KEY: 'AIza-other' });
    const outcome = await runWorker(options(s, 'docs', { env }));
    expect(outcome.status).toBe('completed');
    const [call] = fake.calls();
    expect(JSON.parse(call?.stdin ?? '')).toEqual({ event: 'user', message: { content: 'Brief for docs.' } });
    expect(call?.env.GEMINI_API_KEY).toBe('AIza-key');
    expect(call?.env.GOOGLE_API_KEY).toBeUndefined();
  });
});

describe('runWorker limits', () => {
  it('stops a worker at its time limit, with everything it started', async () => {
    const s = await setup();
    const marker = join(tempDir(), 'child-ran.txt');
    installFakeEngine(s.bin, 'claude', { run: { hang: true, leaveChild: { marker, afterMs: 2500 } } });
    const started = Date.now();
    const outcome = await runWorker(options(s, 'api', { timeoutMs: 1500 }));
    expect(outcome.status).toBe('timed-out');
    expect(outcome.error).toBe('Claude Code was stopped after its time limit (2 s).');
    expect(Date.now() - started).toBeLessThan(20_000);
    await delay(3000);
    expect(existsSync(marker)).toBe(false);
    expect(s.store.state.tasks.find((t) => t.id === 'api')?.workers[0]?.error).toContain('time limit');
  });

  it('stops a worker when the run is cancelled', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { hang: true } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const outcome = await runWorker(options(s, 'api', { signal: controller.signal }));
    expect(outcome.status).toBe('cancelled');
    expect(outcome.error).toBe('Claude Code was stopped because the run was cancelled.');
  });

  it.skipIf(WINDOWS)('stops processes a worker leaves running when it exits', async () => {
    const s = await setup();
    const marker = join(tempDir(), 'leftover-ran.txt');
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK, leaveChild: { marker, afterMs: 1500 } } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('completed');
    await delay(2500);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('runWorker refuses to start', () => {
  it('when the run is already cancelled, recording nothing', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const controller = new AbortController();
    controller.abort();
    const outcome = await runWorker(options(s, 'api', { signal: controller.signal }));
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toContain('cancelled');
    expect(fake.calls()).toEqual([]);
    expect(s.store.state.tasks.find((t) => t.id === 'api')?.workers).toEqual([]);
  });

  it("when the engine's program is not found", async () => {
    const s = await setup();
    const outcome = await runWorker(options(s, 'api', { env: fakeEnv(s.bin) }));
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toContain('"claude" was not found');
    expect(s.store.state.tasks.find((t) => t.id === 'api')?.workers).toEqual([]);
  });

  it("when the worktree is another run's", async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const outcome = await runWorker({ ...options(s, 'api'), worktree: { ...s.worktree('api'), runId: '20261121-120000-ffff' } });
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toContain('belongs to run 20261121-120000-ffff');
    expect(fake.calls()).toEqual([]);
  });

  it("takes the engine and model from the plan, never from the caller", async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    // "ui" is planned for Codex, which is not installed here: Claude is never started in its place.
    const outcome = await runWorker(options(s, 'ui'));
    expect(outcome).toMatchObject({ status: 'not-started', engine: 'codex', model: 'gpt-6-codex' });
    expect(outcome.error).toContain('"codex" was not found');
  });

  it("when the folder is not the task's own worktree folder", async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const elsewhere = tempDir();
    const outcome = await runWorker({ ...options(s, 'api'), worktree: { ...s.worktree('api'), path: elsewhere } });
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toBe(`${elsewhere} is not the worktree folder of task "api".`);
    // Another task's folder is refused too.
    const other = await runWorker({ ...options(s, 'api'), worktree: { ...s.worktree('api'), path: s.worktree('ui').path } });
    expect(other.status).toBe('not-started');
    expect(fake.calls()).toEqual([]);
  });

  it('when the task is not in the plan', async () => {
    const s = await setup();
    const outcome = await runWorker({ ...options(s, 'api'), worktree: { ...s.worktree('api'), taskId: 'nope' } });
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toContain('no task "nope"');
  });

  it.skipIf(WINDOWS)('when the worktree folder is a link', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const wt = s.worktree('api');
    const real = tempDir();
    rmSync(wt.path, { recursive: true });
    symlinkSync(real, wt.path);
    const outcome = await runWorker({ ...options(s, 'api'), worktree: wt });
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toContain('not a real folder');
  });

  it.skipIf(WINDOWS)("when a folder on the way to the worktree is a link", async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const wt = s.worktree('api');
    const runFolder = join(s.home, 'wt', RUN);
    const elsewhere = tempDir();
    mkdirSync(join(elsewhere, 'api'));
    rmSync(runFolder, { recursive: true });
    symlinkSync(elsewhere, runFolder);
    const outcome = await runWorker({ ...options(s, 'api'), worktree: wt });
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toBe(`${runFolder} is not a real folder (a link or a file), so no worker runs there.`);
    expect(fake.calls()).toEqual([]);
  });

  it('when the store is closed', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    await s.store.close();
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('not-started');
  });

  it('when the round is not a valid round', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const outcome = await runWorker(options(s, 'api', { round: -1 }));
    expect(outcome.status).toBe('not-started');
  });
});

describe('runWorker endings', () => {
  it('fails a run whose result is marked as an error without a reason', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: [CLAUDE_OK[0] as object, { ...(CLAUDE_OK[2] as object), is_error: true }] } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('Claude Code reported that it did not finish.');
  });

  it.skipIf(WINDOWS)('reports a worker stopped by a signal', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: [CLAUDE_OK[0] as object], killSelf: 'SIGTERM' } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome).toMatchObject({ status: 'failed', exitCode: null, signal: 'SIGTERM', error: 'Claude Code was stopped by SIGTERM.' });
  });

  it('reports a configured program that is not a program, without throwing', async () => {
    const s = await setup();
    const file = join(tempDir(), WINDOWS ? 'claude.exe' : 'claude');
    writeFileSync(file, 'this is not a program\n');
    chmodSync(file, 0o755);
    const outcome = await runWorker(options(s, 'api', { programs: { claude: file } }));
    // macOS and Windows refuse to start it; Linux hands a file without "#!" to sh, which then fails.
    expect(['not-started', 'failed']).toContain(outcome.status);
    const run = s.store.state.tasks.find((t) => t.id === 'api')?.workers[0];
    expect(run?.endedAt).not.toBeNull();
    expect(run?.error).toBe(outcome.error);
  });
});

describe('runWorker timing', () => {
  it('honours a cancel that comes while the run is being prepared, without starting the engine', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { hang: true } });
    const controller = new AbortController();
    // `now` is first asked for just before the run is recorded: cancel right there.
    const now = (): Date => {
      controller.abort();
      return NOW;
    };
    const started = Date.now();
    const outcome = await runWorker(options(s, 'api', { signal: controller.signal, now, timeoutMs: 20_000 }));
    expect(outcome.status).toBe('cancelled');
    expect(outcome.error).toBe('The run was cancelled before Claude Code started.');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fake.calls()).toEqual([]);
    expect(s.store.state.tasks.find((t) => t.id === 'api')?.workers[0]?.error).toBe('The run was cancelled before Claude Code started.');
  });

  it('takes a time limit too long for a timer as the longest one, and a nonsense one as the default', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK, delayMs: 300 } });
    for (const timeoutMs of [2 ** 31, Number.POSITIVE_INFINITY, Number.NaN, -5, 0]) {
      expect((await runWorker(options(s, 'api', { timeoutMs }))).status, String(timeoutMs)).toBe('completed');
    }
  });

  it.skipIf(WINDOWS)('keeps a clean ending when a process outside its group holds the output past the time limit', async () => {
    const s = await setup();
    const pidFile = join(tempDir(), 'holder.pid');
    const lines = CLAUDE_OK.map((l) => JSON.stringify(l));
    // Prints a complete run and exits 0, leaving a process in a session of its own that keeps stdout open for 8 s.
    const body =
      '#!/usr/bin/env node\n' +
      "const cp = require('child_process'); const fs = require('fs');\n" +
      "process.stdin.resume(); process.stdin.on('end', () => {\n" +
      "  const g = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });\n" +
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); g.unref();\n` +
      `  for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + '\\n');\n` +
      '});\n';
    writeFileSync(join(s.bin, 'claude'), body);
    chmodSync(join(s.bin, 'claude'), 0o755);
    try {
      const outcome = await runWorker(options(s, 'api', { timeoutMs: 1500 }));
      expect(outcome.status).toBe('completed');
      expect(outcome.mayStillBeRunning).toBe(true);
      expect(outcome.notes).toEqual(['Its output stayed open after it exited (a process it started may still be running).']);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('says nothing may still be running after a clean run', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.mayStillBeRunning).toBe(false);
    expect(outcome.notes).toEqual([]);
  });

  it('fails a run whose engine reports working in another folder', async () => {
    const s = await setup();
    const elsewhere = tempDir();
    installFakeEngine(s.bin, 'claude', { run: { stdout: [{ ...(CLAUDE_OK[0] as object), cwd: elsewhere }, ...CLAUDE_OK.slice(1)] } });
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe(`Claude worked in ${elsewhere}, not in the task's worktree.`);
  });
});

describe('runWorker and the store', () => {
  it('never starts a worker it cannot record', async () => {
    const s = await setup();
    const fake = installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    const full = Array.from({ length: 1000 }, () => ({ round: 0, engine: 'claude' as const, model: 'opus', startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), exitCode: 0, error: null, tokens: null }));
    const filled = await s.store.updateTask('api', { workers: full });
    expect(filled.ok).toBe(true);
    const outcome = await runWorker(options(s, 'api'));
    expect(outcome.status).toBe('not-started');
    expect(outcome.error).toContain('could not be recorded, so it was not started');
    expect(fake.calls()).toEqual([]);
  });

  it('reports what it could not save when the store is closed while the worker runs', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK, delayMs: 1500 } });
    const running = runWorker(options(s, 'api'));
    await delay(500);
    await s.store.close();
    const outcome = await running;
    expect(outcome.status).toBe('completed');
    expect(outcome.storeProblems.some((p) => p.includes('could not be recorded'))).toBe(true);
    expect(outcome.storeProblems.some((p) => p.includes('log could not be written'))).toBe(true);
  });
});

describe('runWorker in later rounds', () => {
  it('adds one worker run per round and reports billing variables it refused to pass', async () => {
    const s = await setup();
    installFakeEngine(s.bin, 'claude', { run: { stdout: CLAUDE_OK } });
    await runWorker(options(s, 'api'));
    const second = await runWorker(options(s, 'api', { round: 1, allowEnv: ['ANTHROPIC_API_KEY', 'HTTPS_PROXY'] }));
    expect(second.refusedEnv).toEqual(['ANTHROPIC_API_KEY']);
    expect(s.store.state.tasks.find((t) => t.id === 'api')?.workers.map((w) => w.round)).toEqual([0, 1]);
    expect(await outputText(s, 'api', 1, 'stdout')).toContain('All done.');
  });
});
