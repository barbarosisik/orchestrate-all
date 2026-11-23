import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_APPROVER } from '../../src/manager/approval.js';
import { RunManager } from '../../src/manager/manager.js';
import { listRuns, readBrief, readGate, readResult, readRunLog } from '../../src/store/run.js';
import {
  accept,
  fileIs,
  INTEGRITY,
  nodeCommand,
  reject,
  revise,
  setupManager,
  startPlan,
  taskOf,
  type ManagerSetup,
  type Scripts,
} from '../helpers/manager.js';

// Whole runs with real git and fake engines: slow on busy machines and Windows runners.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const setups: ManagerSetup[] = [];
afterEach(async () => {
  while (setups.length > 0) await setups.pop()?.cleanup();
});

async function setup(scripts: Scripts, opts: Parameters<typeof setupManager>[1] = {}): Promise<ManagerSetup> {
  const s = await setupManager(scripts, opts);
  setups.push(s);
  return s;
}

function orchestraBranches(s: ManagerSetup): string[] {
  const out = s.fx.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/orchestra/');
  return out === '' ? [] : out.split('\n');
}

describe('a run from approval to the finalize report', () => {
  it('runs every task in its own worktree, merges accepted work in dependency order and checks the result', async () => {
    const s = await setup({
      api: { files: { 'src/api/a.ts': 'api v2\n' }, summary: 'Rewrote the API.', interfaces: [{ name: 'getThing', location: 'src/api/a.ts' }] },
      web: { files: { 'src/web/w.ts': 'web v2\n' } },
      docs: { files: { 'docs/guide.md': 'guide v2\n' } },
    });
    const runId = await startPlan(s, [
      { id: 'api', owns: ['src/api/'], commands: [fileIs('src/api/a.ts', 'api v2\n')] },
      { id: 'web', owns: ['src/web/'], commands: [fileIs('src/web/w.ts', 'web v2\n')] },
      { id: 'docs', owns: ['docs/'], commands: [fileIs('src/api/a.ts', 'api v2\n')], dependsOn: ['api'] },
    ]);

    // The user approved exactly this plan, and saw its routing table.
    expect(s.approver.requests).toHaveLength(1);
    const asked = s.approver.requests[0];
    expect(asked?.kind).toBe('start');
    expect(asked?.text).toContain('- docs: Task docs [claude, test-model, after api]');
    expect(asked?.text).toContain('No rule files in the base commit');

    const reviewing = await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing' && taskOf(r, 'web').status === 'reviewing');
    expect(asked?.planHash).toBe(reviewing.planHash);
    expect(taskOf(reviewing, 'docs').status).toBe('waiting');
    expect(taskOf(reviewing, 'api').gate).toEqual({ passed: true, summary: '1/1 commands passed; integrity ok' });
    expect(reviewing.phase).toBe('working');

    // The worker's own account, compared with the real diff, and the gate, kept in the run folder.
    const result = await readResult(s.fx.home, runId, 'api', 0);
    expect(result.ok && result.value?.result?.summary).toBe('Rewrote the API.');
    expect(result.ok && result.value?.claims).toEqual({ unclaimed: [], notChanged: [] });
    const gate = await readGate(s.fx.home, runId, 'api', 0);
    expect(gate.ok && gate.value?.passed).toBe(true);

    // The state is saved before each log entry; the log has every step in order.
    const log = await readRunLog(s.fx.home, runId);
    const kinds = log.ok ? log.value.records.filter((r) => 'task' in r && r.task === 'api').map((r) => r.kind) : [];
    expect(kinds).toEqual(['task-status', 'worker', 'worker', 'integrity', 'agent-config', 'scope', 'commit', 'gate', 'task-status']);

    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    const docsUp = await s.waitFor(runId, (r) => taskOf(r, 'docs').status === 'reviewing');
    expect(taskOf(docsUp, 'api').status).toBe('merged');
    expect(taskOf(docsUp, 'docs').startSha).toBe(taskOf(docsUp, 'api').mergeCommit);
    const brief = await readBrief(s.fx.home, runId, 'docs', 0);
    expect(brief.ok && brief.value).toContain('<upstream task="api"');
    expect(brief.ok && brief.value).toContain('Rewrote the API.');
    expect(brief.ok && brief.value).toContain('getThing');
    expect(brief.ok && brief.value).toContain('src/api/a.ts');

    expect((await s.manager.submitReview(runId, 'web', accept())).ok).toBe(true);
    expect((await s.manager.submitReview(runId, 'docs', accept())).ok).toBe(true);
    const done = await s.waitFor(runId, (r) => r.phase === 'ready-to-finalize' || r.phase === 'finalize-problems');
    expect(done.phase).toBe('ready-to-finalize');
    expect(done.mergeOrder).toEqual(['api', 'web', 'docs']);
    expect(done.finalize?.ready).toBe(true);
    expect(done.integrationTip).toBe(s.fx.repo.git('rev-parse', `orchestra/${runId}/integration`));
    // The user's branch is untouched until they approve the finalize (step 13).
    expect(s.fx.repo.git('rev-parse', 'main')).toBe(s.fx.base);
  });
});

describe('moving a run along', () => {
  it('starts a dependent task as soon as the task it depends on is merged', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } }, docs: { files: { 'docs/guide.md': 'guide v2\n' } } });
    const runId = await startPlan(s, [
      { id: 'api', owns: ['src/api/'] },
      { id: 'docs', owns: ['docs/'], dependsOn: ['api'] },
    ]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    // Nothing else is going on: only the review moves the run along now.
    await s.manager.settled(runId);
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'docs').status === 'reviewing', 30_000);
    expect(taskOf(r, 'api').status).toBe('merged');
  });

  it('gives a worker place back whatever stops a round, so other tasks still run', async () => {
    const s = await setup(
      { a: { files: { 'src/api/a.ts': 'api v2\n' } }, b: { files: { 'src/web/w.ts': 'web v2\n' } } },
      { extra: { limits: { maxParallelWorkers: 1, commandTimeoutMs: 60_000, workerTimeoutMs: 60_000 } } },
    );
    const runId = await startPlan(s, [
      { id: 'a', owns: ['src/api/'] },
      { id: 'b', owns: ['src/web/'] },
    ]);
    await s.waitFor(runId, (r) => taskOf(r, 'a').status === 'reviewing' && taskOf(r, 'b').status === 'reviewing');
    // a's branch moves, so its next round can't get a worktree and stops before its worker.
    s.fx.repo.git('update-ref', `refs/heads/orchestra/${runId}/a`, s.fx.base);
    expect((await s.manager.submitReview(runId, 'a', revise('Again.'))).ok).toBe(true);
    await s.waitFor(runId, (r) => taskOf(r, 'a').status === 'failed');
    expect((await s.manager.submitReview(runId, 'b', revise('Again.'))).ok).toBe(true);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'b').status === 'reviewing' && taskOf(x, 'b').round === 1, 30_000);
    expect(taskOf(r, 'b').workers).toBe(2);
  });

  it('lists runs it could not reopen, and leaves them alone', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } });
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'] }]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    await s.manager.detach();
    writeFileSync(join(s.fx.home, 'runs', runId, 'state.json'), '{"damaged":');
    await s.restart();
    expect(s.manager.unreadableRuns().map((u) => u.runId)).toEqual([runId]);
    expect(s.manager.unreadableRuns()[0]?.problem).toContain('state.json');
    const refused = await s.manager.submitReview(runId, 'api', accept());
    expect(refused.ok ? 'ok' : refused.code).toBe('not-found');
  });
});

describe('approval', () => {
  it('starts nothing unless the user approves exactly this plan', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'x\n' } } });
    for (const answer of ['refuse', 'wrong-hash', 'throw'] as const) {
      s.approver.answer = answer;
      const started = await s.manager.startRun(s.plan([{ id: 'api', owns: ['src/api/'] }]));
      expect(started.ok ? 'ok' : started.code).toBe('not-approved');
    }
    expect(s.approver.requests).toHaveLength(3);
    const runs = await listRuns(s.fx.home);
    expect(runs.ok && runs.value.runs).toEqual([]);
    expect(orchestraBranches(s)).toEqual([]);
    expect(s.claude.calls().filter((c) => c.argv.includes('-p'))).toEqual([]);
  });

  it('refuses everything until the approval dialog exists', async () => {
    const s = await setup({});
    const manager = await s.open({ approver: NO_APPROVER });
    const started = await manager.startRun(s.plan([{ id: 'api', owns: ['src/api/'] }]));
    expect(started.ok ? 'ok' : started.message).toContain('step 13');
  });

  it('never asks about a plan that fails its checks', async () => {
    const s = await setup({});
    const plan = s.plan([{ id: 'api', owns: ['src/api/'] }]) as { tasks: Array<{ engine: string }> };
    (plan.tasks[0] as { engine: string }).engine = 'codex';
    const started = await s.manager.startRun(plan);
    expect(started.ok ? 'ok' : started.code).toBe('invalid-plan');
    expect(started.ok ? [] : (started.problems ?? []).map((p) => p.code)).toContain('engine-not-ready');
    expect(s.approver.requests).toEqual([]);
  });

  it('starts nothing once this process no longer holds the conductor lock', async () => {
    const s = await setup({});
    writeFileSync(s.lock.path, JSON.stringify({ ...s.lock.owner, nonce: 'f'.repeat(32) }));
    const started = await s.manager.startRun(s.plan([{ id: 'api', owns: ['src/api/'] }]));
    expect(started.ok ? 'ok' : started.code).toBe('lock-lost');
    const runs = await listRuns(s.fx.home);
    expect(runs.ok && runs.value.runs).toEqual([]);
  });
});

describe('reviews', () => {
  it('sends a task back for a revision round in a fresh worktree, with the reviewer\'s request in its brief', async () => {
    const s = await setup({
      'api@0': { files: { 'src/api/a.ts': 'api half\n' } },
      'api@1': { files: { 'src/api/a.ts': 'api v2\n' } },
    });
    const leftover = nodeCommand("require('fs').writeFileSync('src/api/leftover.txt','x')");
    const clean = nodeCommand("process.exit(require('fs').existsSync('src/api/leftover.txt')?1:0)");
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'], commands: [clean, fileIs('src/api/a.ts', 'api v2\n'), leftover] }]);
    const failed = await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    expect(taskOf(failed, 'api').review).toBe('gate-failed');
    const refused = await s.manager.submitReview(runId, 'api', accept());
    expect(refused.ok ? 'ok' : refused.code).toBe('below-threshold');
    expect((await s.manager.submitReview(runId, 'api', revise('Make it v2.'))).ok).toBe(true);
    const second = await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing' && taskOf(r, 'api').round === 1);
    // The command's leftover file from round 0 is not in round 1's worktree.
    expect(taskOf(second, 'api').review).toBe('awaiting-review');
    const brief = await readBrief(s.fx.home, runId, 'api', 1);
    expect(brief.ok && brief.value).toContain('round="1"');
    expect(brief.ok && brief.value).toContain('Make it v2.');
    expect(brief.ok && brief.value).toContain('Not done yet.');
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    const done = await s.waitFor(runId, (r) => r.phase === 'ready-to-finalize');
    expect(taskOf(done, 'api').status).toBe('merged');
  });

  it('cancels the tasks that depend on a rejected one', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } });
    const runId = await startPlan(s, [
      { id: 'api', owns: ['src/api/'] },
      { id: 'docs', owns: ['docs/'], dependsOn: ['api'] },
    ]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    expect((await s.manager.submitReview(runId, 'api', reject())).ok).toBe(true);
    const done = await s.waitFor(runId, (r) => r.phase === 'nothing-merged');
    expect(taskOf(done, 'api').status).toBe('rejected');
    expect(taskOf(done, 'docs')).toMatchObject({ status: 'cancelled', reason: 'It depends on "api", which was rejected.' });
    expect(s.claude.calls().filter((c) => c.stdin.includes('task="docs"'))).toEqual([]);
  });

  it('refuses reviews for tasks not waiting for one, and for unknown runs and tasks', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } });
    const runId = await startPlan(s, [
      { id: 'api', owns: ['src/api/'] },
      { id: 'docs', owns: ['docs/'], dependsOn: ['api'] },
    ]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    const early = await s.manager.submitReview(runId, 'docs', accept());
    expect(early.ok ? 'ok' : early.code).toBe('wrong-status');
    const unknownTask = await s.manager.submitReview(runId, 'nope', accept());
    expect(unknownTask.ok ? 'ok' : unknownTask.code).toBe('not-found');
    const unknownRun = await s.manager.submitReview('20990101-000000-zzzz', 'api', accept());
    expect(unknownRun.ok ? 'ok' : unknownRun.code).toBe('not-found');
    const malformed = await s.manager.submitReview(runId, 'api', { verdict: 'accept' });
    expect(malformed.ok ? 'ok' : malformed.code).toBe('invalid-review');
  });

  it('lets a worker that did not finish normally be revised or rejected, never accepted', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' }, exitCode: 1 } });
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'], commands: [fileIs('src/api/a.ts', 'api v2\n')] }]);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'reviewing');
    expect(taskOf(r, 'api').review).toBe('gate-failed');
    expect(taskOf(r, 'api').gate?.summary).toContain('did not finish normally');
    const refused = await s.manager.submitReview(runId, 'api', accept());
    expect(refused.ok).toBe(false);
  });

  it("notes a worker's claims that differ from the real diff", async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n', 'src/api/b.ts': 'b\n' }, claims: ['src/api/a.ts', 'src/api/c.ts'] } });
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'] }]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    const result = await readResult(s.fx.home, runId, 'api', 0);
    expect(result.ok && result.value?.claims).toEqual({ unclaimed: ['src/api/b.ts'], notChanged: ['src/api/c.ts'] });
    const log = await readRunLog(s.fx.home, runId);
    expect(log.ok && log.value.records.some((rec) => rec.kind === 'note' && rec.message.includes('differs from the real diff'))).toBe(true);
  });
});

describe("the conductor's checks after each worker", () => {
  it('fails a task whose worker changed files it does not own, and commits nothing', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n', 'src/web/sneaky.ts': 'x\n' } } });
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'] }]);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').reason).toContain('src/web/sneaky.ts');
    expect(taskOf(r, 'api').commit).toBeNull();
    expect(s.fx.repo.git('rev-parse', `orchestra/${runId}/api`)).toBe(s.fx.base);
  });

  it("fails a task whose worker changed the user's repository outside its worktree", async () => {
    const s = await setup({});
    s.claude.setScenario(
      (await import('../helpers/manager.js')).claudeScenario({
        api: { files: { 'src/api/a.ts': 'api v2\n' }, absolute: { [join(s.fx.repo.dir, '.git', 'config')]: '\n[core]\n\tfsmonitor = evil\n' } },
      }),
    );
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'] }]);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').reason).toContain('integrity check failed');
  });

  it("fails a task whose acceptance commands changed the user's repository outside the worktree", async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } });
    const config = join(s.fx.repo.dir, '.git', 'config');
    const tamper = nodeCommand(`require('fs').appendFileSync(${JSON.stringify(config)}, '\\n[core]\\n\\tfsmonitor = evil\\n')`);
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'], commands: [tamper] }]);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').reason).toContain('acceptance commands changed things outside its worktree');
  });

  it("fails a task whose worker changed the agents' own config folders", async () => {
    const s = await setup({});
    s.claude.setScenario(
      (await import('../helpers/manager.js')).claudeScenario({
        api: { files: { 'src/api/a.ts': 'api v2\n' }, absolute: { [join(s.userHome, '.claude', 'settings.json')]: '{"hooks":{}}' } },
      }),
    );
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'] }]);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'failed');
    expect(taskOf(r, 'api').reason).toContain("agents' own config folders changed");
  });

  it('reserves the files rule files import: no task may own one or change one', async () => {
    const files = { 'CLAUDE.md': 'Read @docs/rules.md first.\n', 'docs/rules.md': 'rules v1\n' };
    const s = await setup({ docs: { files: { 'docs/rules.md': 'rules v2\n', 'docs/guide.md': 'guide v2\n' } } }, { fixture: { files: { ...FILES_WITH(files) } } });
    const owning = await s.manager.startRun(s.plan([{ id: 'docs', owns: ['docs/rules.md'] }]));
    expect(owning.ok ? [] : (owning.problems ?? []).map((p) => p.code)).toContain('owns-reserved');
    const runId = await startPlan(s, [{ id: 'docs', owns: ['docs/'] }]);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'docs').status === 'failed');
    expect(taskOf(r, 'docs').reason).toContain('docs/rules.md');
    expect(taskOf(r, 'docs').reason).toContain('reserved');
  });
});

function FILES_WITH(extra: Record<string, string>): Record<string, string> {
  return { 'README.md': 'hello\n', '.gitignore': 'dist/\n', 'src/api/a.ts': 'api v1\n', 'src/web/w.ts': 'web v1\n', 'docs/guide.md': 'guide v1\n', ...extra };
}

describe('cancelling and discarding', () => {
  it('stops acceptance commands that are running when the run is cancelled', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } });
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'], commands: [nodeCommand('setInterval(() => {}, 1000)')] }]);
    for (let i = 0; i < 400; i++) {
      const log = await readRunLog(s.fx.home, runId);
      if (log.ok && log.value.records.some((r) => r.kind === 'commit')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const started = Date.now();
    expect((await s.manager.cancelRun(runId)).ok).toBe(true);
    const r = await s.waitFor(runId, (x) => taskOf(x, 'api').status === 'cancelled', 30_000);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(r.phase).toBe('nothing-merged');
  });

  it('stops a running worker and cancels unfinished tasks when the run is cancelled', async () => {
    const s = await setup({ api: { hang: true }, web: { files: { 'src/web/w.ts': 'web v2\n' } } });
    const runId = await startPlan(s, [
      { id: 'api', owns: ['src/api/'] },
      { id: 'web', owns: ['src/web/'] },
    ]);
    await s.waitFor(runId, (r) => taskOf(r, 'web').status === 'reviewing' && taskOf(r, 'api').workers === 1);
    expect((await s.manager.cancelRun(runId)).ok).toBe(true);
    await s.manager.settled(runId);
    const r = await s.waitFor(runId, (x) => x.tasks.every((t) => t.status === 'cancelled'));
    expect(r.phase).toBe('nothing-merged');
    expect((await s.manager.cancelRun('20990101-000000-zzzz')).ok).toBe(false);
  });

  it('runs no finalize checks for a run being discarded', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } }, web: { files: { 'src/web/w.ts': 'web v2\n' } } });
    const runId = await startPlan(s, [
      { id: 'api', owns: ['src/api/'] },
      { id: 'web', owns: ['src/web/'] },
    ]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing' && taskOf(r, 'web').status === 'reviewing');
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'merged');
    // Discarding cancels web, which would leave every task finished with api merged.
    expect((await s.manager.discardRun(runId)).ok).toBe(true);
    const log = await readRunLog(s.fx.home, runId);
    expect(log.ok && log.value.records.filter((rec) => rec.kind === 'finalize-check')).toEqual([]);
  });

  it('discards a run only with approval, removing its worktrees and branches but never the user\'s', async () => {
    const s = await setup({ api: { files: { 'src/api/a.ts': 'api v2\n' } } });
    const runId = await startPlan(s, [{ id: 'api', owns: ['src/api/'] }]);
    await s.waitFor(runId, (r) => taskOf(r, 'api').status === 'reviewing');
    expect((await s.manager.submitReview(runId, 'api', accept())).ok).toBe(true);
    await s.waitFor(runId, (r) => r.phase === 'ready-to-finalize');
    expect(orchestraBranches(s).length).toBe(2);
    s.approver.answer = 'refuse';
    const refused = await s.manager.discardRun(runId);
    expect(refused.ok ? 'ok' : refused.code).toBe('not-approved');
    expect(orchestraBranches(s).length).toBe(2);
    s.approver.answer = 'approve';
    const discarded = await s.manager.discardRun(runId);
    expect(discarded).toEqual({ ok: true, notes: [] });
    expect(s.approver.requests.at(-1)?.kind).toBe('discard');
    expect(orchestraBranches(s)).toEqual([]);
    expect(existsSync(join(s.fx.home, 'wt', runId))).toBe(false);
    expect((await s.manager.status(runId))?.status).toBe('discarded');
    expect(s.fx.repo.git('rev-parse', 'main')).toBe(s.fx.base);
    // A discarded run is not carried on by a new manager.
    const again = await RunManager.open({ home: s.fx.home, lock: s.lock, approver: s.approver, userHome: s.userHome, env: s.env, integrity: INTEGRITY });
    expect((await again.status(runId))?.phase).toBe('discarded');
    await again.close();
    expect(readdirSync(join(s.fx.home, 'runs'))).toEqual([runId]);
    // Discarding never runs the finalize checks again.
    const log = await readRunLog(s.fx.home, runId);
    expect(log.ok && log.value.records.filter((rec) => rec.kind === 'finalize-check')).toHaveLength(1);
  });
});
