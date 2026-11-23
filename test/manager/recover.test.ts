import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitStep } from '../../src/manager/manager.js';
import { identifyProcess, lookupProcess } from '../../src/os/process-identity.js';
import { loadRun, readRunLog } from '../../src/store/run.js';
import { accept, claudeScenario, fileIs, setupManager, startPlan, taskOf, type ManagerSetup, type Scripts } from '../helpers/manager.js';

const WINDOWS = process.platform === 'win32';
// Whole runs with real git and fake engines: slow on busy machines and Windows runners.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const setups: ManagerSetup[] = [];
afterEach(async () => {
  while (setups.length > 0) await setups.pop()?.cleanup();
});

async function setup(scripts: Scripts, extra: Parameters<typeof setupManager>[1] = {}): Promise<ManagerSetup> {
  const s = await setupManager(scripts, extra);
  setups.push(s);
  return s;
}

/** A hook that makes Orchestra "die" right after a git step: it never returns, and nothing after it happens. */
function crashAfter(step: GitStep, taskId: string | null) {
  let signal: () => void = () => undefined;
  const happened = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const hook = (at: GitStep, _runId: string, task: string | null): Promise<void> | void => {
    if (at === step && task === taskId) {
      signal();
      return new Promise<void>(() => undefined);
    }
  };
  return { hook, happened };
}

const API = { id: 'api', owns: ['src/api/'], commands: [fileIs('src/api/a.ts', 'api v2\n')] };
const WORK: Scripts = { api: { files: { 'src/api/a.ts': 'api v2\n' } } };

async function notes(s: ManagerSetup, runId: string): Promise<string[]> {
  const log = await readRunLog(s.fx.home, runId);
  return log.ok ? log.value.records.flatMap((r) => (r.kind === 'note' ? [r.message] : [])) : [];
}

describe('carrying on after a crash, with git one step ahead', () => {
  it('records a task commit git made before Orchestra stopped, and ends the interrupted round', async () => {
    const crash = crashAfter('commit', 'api');
    const s = await setup(WORK, { extra: { afterGitStep: crash.hook } });
    const runId = await startPlan(s, [API]);
    await crash.happened;
    const before = await loadRun(s.fx.home, runId);
    expect(before.ok && before.value.state.tasks[0]?.commit).toBeNull();
    await s.restart({ extra: { afterGitStep: undefined } });
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').commit).toBe(s.fx.repo.git('rev-parse', `orchestra/${runId}/api`));
    expect(taskOf(r, 'api').reason).toContain('Orchestra stopped while round 0 of this task was going');
    expect(taskOf(r, 'api').workers).toBe(1);
    expect((await notes(s, runId)).join(' ')).toContain('Recorded the commit of task "api"');
  });

  it('records a merge git made before Orchestra stopped', async () => {
    const crash = crashAfter('merge', 'api');
    const s = await setup(WORK, { extra: { afterGitStep: crash.hook } });
    const runId = await startPlan(s, [API]);
    await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    await crash.happened;
    await s.restart({ extra: { afterGitStep: undefined } });
    const r = await s.waitFor(runId, (x) => x.phase === 'ready-to-finalize');
    expect(taskOf(r, 'api').status).toBe('merged');
    expect(r.integrationTip).toBe(s.fx.repo.git('rev-parse', `orchestra/${runId}/integration`));
    expect((await notes(s, runId)).join(' ')).toContain('Recorded the merge of task "api"');
  });

  it('refuses a merge commit with the right parents that does not hold what merging gives', async () => {
    const crash = crashAfter('merge', 'api');
    const s = await setup(WORK, { extra: { afterGitStep: crash.hook } });
    const runId = await startPlan(s, [API]);
    await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    const commit = taskOf((await s.manager.status(runId)) ?? (null as never), 'api').commit as string;
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    await crash.happened;
    await s.manager.detach();
    // Same parents as Orchestra's merge, other content: the base commit's tree.
    const forged = s.fx.repo.git('commit-tree', `${s.fx.base}^{tree}`, '-p', s.fx.base, '-p', commit, '-m', 'forged');
    s.fx.repo.git('update-ref', `refs/heads/orchestra/${runId}/integration`, forged);
    await s.restart({ extra: { afterGitStep: undefined } });
    const r = await s.waitFor(runId, (x) => x.phase === 'paused');
    expect(taskOf(r, 'api').status).toBe('accepted');
    expect(r.problems.join(' ')).toContain('integration branch');
  });

  it('removes a worktree made just before Orchestra stopped, and starts the task again', async () => {
    const crash = crashAfter('worktree', 'api');
    const s = await setup(WORK, { extra: { afterGitStep: crash.hook } });
    const runId = await startPlan(s, [API]);
    await crash.happened;
    await s.restart({ extra: { afterGitStep: undefined } });
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    expect(taskOf(r, 'api').gate?.passed).toBe(true);
    expect((await notes(s, runId)).join(' ')).toContain('made just before Orchestra stopped');
  });

  it('records the integration branch made before Orchestra stopped', async () => {
    const crash = crashAfter('integration', null);
    const s = await setup(WORK, { extra: { afterGitStep: crash.hook } });
    const runId = await startPlan(s, [API]);
    await crash.happened;
    await s.restart({ extra: { afterGitStep: undefined } });
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    expect(r.integrationTip).toBe(s.fx.base);
  });
});

describe('carrying on after a crash', () => {
  it('stops a worker that outlived Orchestra, after checking it is that worker, and ends its round', async () => {
    const s = await setup({ api: { hang: true } });
    const runId = await startPlan(s, [API]);
    let pid: number | null = null;
    for (let i = 0; i < 400 && pid === null; i++) {
      const loaded = await loadRun(s.fx.home, runId);
      pid = loaded.ok ? (loaded.value.state.tasks[0]?.workers[0]?.process?.pid ?? null) : null;
      if (pid === null) await new Promise((r) => setTimeout(r, 25));
    }
    expect(pid).not.toBeNull();
    // The fake has read its brief (and so chose to hang) before the scenario changes for the next start.
    for (let i = 0; i < 400 && !s.claude.calls().some((c) => c.stdin.includes('task="api"')); i++) await new Promise((r) => setTimeout(r, 25));
    expect((await lookupProcess(pid as number)).state).toBe('running');
    s.claude.setScenario(claudeScenario(WORK));
    // On Windows the worker's Job Object goes with Orchestra; here the process lives on, so the worker is stopped first.
    await s.restart({ stopWorkers: WINDOWS });
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').workers).toBe(1);
    expect(taskOf(r, 'api').reason).toContain('could not be completed');
    expect((await lookupProcess(pid as number)).state).toBe('gone');
    const loaded = await loadRun(s.fx.home, runId);
    const first = loaded.ok ? loaded.value.state.tasks[0]?.workers[0] : undefined;
    expect(first?.endedAt).not.toBeNull();
    expect(first?.error).toContain('Orchestra stopped while this worker ran');
    if (!WINDOWS) expect(first?.error).toContain('still running and was stopped');
  });

  it.skipIf(WINDOWS)("never stops a process a forged record names, when it is not working in the task's worktree", async () => {
    const s = await setup({ api: { hang: true } });
    const runId = await startPlan(s, [API]);
    await s.waitFor(runId, (x) => taskOf(x, 'api').workers === 1);
    await s.manager.detach({ stopWorkers: true });
    await new Promise((r) => setTimeout(r, 200));
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, cwd: tmpdir() });
    try {
      const identity = await identifyProcess(victim.pid as number);
      const file = join(s.fx.home, 'runs', runId, 'state.json');
      const state = JSON.parse(readFileSync(file, 'utf8'));
      state.tasks[0].workers[0] = { ...state.tasks[0].workers[0], endedAt: null, process: identity };
      writeFileSync(file, JSON.stringify(state));
      s.claude.setScenario(claudeScenario(WORK));
      await s.restart();
      const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
      expect(taskOf(r, 'api').workers).toBe(1);
      expect(victim.exitCode).toBeNull();
      expect((await lookupProcess(victim.pid as number)).state).toBe('running');
    } finally {
      victim.kill('SIGKILL');
    }
  });

  it('starts the worker of a round that had not started it yet', async () => {
    const s = await setup(WORK);
    const runId = await startPlan(s, [API]);
    // The engine check before the worker takes a while: Orchestra stops during it.
    s.claude.setScenario({ ...claudeScenario(WORK), replies: { ...claudeScenario(WORK).replies, '--version': { stdout: ['2.1.330 (Claude Code)'], delayMs: 4_000 } } });
    await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'working');
    await s.restart({ stopWorkers: true });
    s.claude.setScenario(claudeScenario(WORK));
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    expect(taskOf(r, 'api').workers).toBe(1);
    expect(taskOf(r, 'api').gate?.passed).toBe(true);
  });

  it('keeps a task waiting for its review, and takes the review after the restart', async () => {
    const s = await setup(WORK);
    const runId = await startPlan(s, [API]);
    await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    await s.restart();
    expect(taskOf((await s.manager.status(runId)) ?? (null as never), 'api').status).toBe('reviewing');
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    const r = await s.waitFor(runId, (x) => x.phase === 'ready-to-finalize');
    expect(taskOf(r, 'api').status).toBe('merged');
    // A finished run's finalize report is shown again after a restart, not computed again.
    await s.restart();
    expect((await s.manager.status(runId))?.phase).toBe('ready-to-finalize');
    const log = await readRunLog(s.fx.home, runId);
    expect(log.ok && log.value.records.filter((rec) => rec.kind === 'finalize-check')).toHaveLength(1);
  });

  it('fails a task whose branch moved while Orchestra was stopped', async () => {
    const s = await setup(WORK);
    const runId = await startPlan(s, [API]);
    await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    await s.manager.detach();
    s.fx.repo.git('update-ref', `refs/heads/orchestra/${runId}/api`, s.fx.base);
    await s.restart();
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').reason).toContain('moved');
  });

  it('pauses a run whose integration branch moved while Orchestra was stopped', async () => {
    const s = await setup(WORK);
    const runId = await startPlan(s, [API]);
    await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    await s.manager.detach();
    const other = s.fx.repo.git('commit-tree', `${s.fx.base}^{tree}`, '-p', s.fx.base, '-m', 'elsewhere');
    s.fx.repo.git('update-ref', `refs/heads/orchestra/${runId}/integration`, other);
    await s.restart();
    const r = await s.waitFor(runId, (x) => x.phase === 'paused');
    expect(r.problems.join(' ')).toContain('integration branch');
    const refused = await s.manager.submitReview(runId, 'api', accept());
    expect(refused.ok ? 'ok' : refused.code).toBe('paused');
  });

  it('refuses a commit on the task branch that Orchestra could not have made', async () => {
    const crash = crashAfter('commit', 'api');
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } }, { extra: { afterGitStep: crash.hook } });
    const runId = await startPlan(s, [API]);
    await crash.happened;
    await s.manager.detach();
    // Replaced by a commit that also changes a file the task does not own.
    s.fx.repo.write('src/web/w.ts', 'sneaky\n');
    s.fx.repo.write('src/api/a.ts', 'api v2\n');
    const tree = s.fx.repo.git('write-tree');
    s.fx.repo.git('add', '-A');
    const sneaky = s.fx.repo.git('commit-tree', s.fx.repo.git('write-tree'), '-p', s.fx.base, '-m', 'sneaky');
    expect(tree).not.toBe('');
    s.fx.repo.git('update-ref', `refs/heads/orchestra/${runId}/api`, sneaky);
    s.fx.repo.git('checkout', '--', '.');
    await s.restart({ extra: { afterGitStep: undefined } });
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').reason).toContain("can't account for");
  });
});
