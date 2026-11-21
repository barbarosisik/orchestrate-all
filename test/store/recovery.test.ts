/**
 * The crash-recovery round trip (step 9 for step 12): a run goes through the real steps, the store records
 * each one, the conductor "crashes" in the middle of a review, and everything needed to carry on comes back
 * from the run folder alone: the ready plan, the repository context, each task's review state and the
 * finalize input.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultValidationContext } from '../../src/config/defaults.js';
import { finalizeChecks, type FinalizeInput } from '../../src/finalize/check.js';
import { mergeTask, startIntegration } from '../../src/merge/integration.js';
import { preparePlan } from '../../src/plan/prepare.js';
import type { Task } from '../../src/plan/schema.js';
import type { ReadyPlan } from '../../src/repo/checks.js';
import { newTaskReview, recordGate, recordReview, startRevision, type TaskReview, type Transition } from '../../src/review/state.js';
import { finalizeEntry, gateEntry, mergeEntry, reviewEntry } from '../../src/store/entries.js';
import { createRun, loadRun, openRun, readFinalizeReport, readRunLog, type RunStore } from '../../src/store/run.js';
import { contextOf, finalizeInputOf, readyPlanOf, taskReviewOf, withTask } from '../../src/store/state.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';
import { node, taskCommit } from '../helpers/run.js';
import { passingReview } from '../helpers/store.js';

const f = fixtures();
const stores: RunStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  f.cleanupAll();
});

const RUN = '20261121-120000-rcvr';
const integrity = { globalGitFiles: [] };

async function approvedPlan(fx: Fixture): Promise<ReadyPlan> {
  const exists = (path: string): string[] => node(`require('fs').accessSync(${JSON.stringify(path)})`);
  const task = (id: string, owns: string, file: string, dependsOn: string[] = []): Omit<Task, 'kind' | 'mode'> & { kind: 'work'; mode: 'write' } => ({
    id,
    title: `Write ${file}`,
    kind: 'work',
    mode: 'write',
    brief: `Create ${file}.`,
    engine: 'claude',
    model: 'test-model',
    owns: [owns],
    dependsOn,
    acceptance: { commands: [exists(file)], criteria: [`${file} exists`, 'matches the project rules'] },
  });
  const prepared = await preparePlan(
    {
      version: 1,
      goal: 'Add an API and its docs',
      repo: fx.repo.dir,
      targetBranch: 'main',
      orchestrator: { engine: 'claude', model: 'opus' },
      tasks: [task('api', 'src/api/', 'src/api/a.ts'), task('docs', 'docs/', 'docs/api.md', ['api'])],
    },
    defaultValidationContext(['claude']),
  );
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.errors));
  return prepared.ready;
}

function must(step: Transition): TaskReview {
  if (!step.ok) throw new Error(step.error.message);
  return step.state;
}

/** Records a review transition the way the run manager will: state first, then the decision in the log. */
async function review(store: RunStore, taskId: string, before: TaskReview, input: unknown): Promise<TaskReview> {
  const result = recordReview(before, input);
  const after = must(result);
  const status = after.status === 'accepted' ? 'accepted' : 'reviewing';
  expect((await store.updateTask(taskId, { status, review: after })).ok).toBe(true);
  expect((await store.appendLog(reviewEntry(before, result))).ok).toBe(true);
  return after;
}

async function gate(store: RunStore, taskId: string, state: TaskReview, commit: string): Promise<TaskReview> {
  const summary = { passed: true, summary: '1/1 commands passed; integrity ok' };
  const after = must(recordGate(state, summary));
  expect((await store.updateTask(taskId, { status: 'reviewing', commit, review: after })).ok).toBe(true);
  expect((await store.appendLog(gateEntry(taskId, after.attempts.at(-1)?.round ?? 0, summary))).ok).toBe(true);
  return after;
}

async function merge(store: RunStore, fx: Fixture, task: Task, commit: string, start: string): Promise<void> {
  const tip = store.state.integrationTip as string;
  const result = await mergeTask(fx.ctx, { runId: RUN, task, start, commit, expectedTip: tip });
  if (!result.ok) throw new Error(result.error.message);
  const saved = await store.update((s) => ({
    ...withTask(s, task.id, { status: 'merged', mergeCommit: result.merged ? result.tip : null }),
    mergeOrder: [...s.mergeOrder, task.id],
    integrationTip: result.tip,
  }));
  if (!saved.ok) throw new Error(saved.problem.message);
  expect((await store.appendLog(mergeEntry(task.id, result))).ok).toBe(true);
}

describe('crash recovery from the run store', () => {
  it('rebuilds the finalize input and every review state, and the run carries on to a ready finalize', async () => {
    const fx = f.make({ files: { 'README.md': 'hello\n' } });
    const ready = await approvedPlan(fx);
    const [apiTask, docsTask] = ready.plan.tasks as [Task, Task];
    const created = await createRun(fx.home, { runId: RUN, ready, hooks: fx.ctx.hooks, caseInsensitivePaths: fx.ctx.caseInsensitivePaths });
    if (!created.ok) throw new Error(created.problem.message);
    const store = created.value;
    stores.push(store);
    const ctx = contextOf(store.record, fx.home);
    expect(ctx).toEqual(fx.ctx);

    const started = await startIntegration(ctx, RUN, fx.base);
    if (!started.ok) throw new Error(started.error.message);
    expect((await store.update((s) => ({ ...s, integrationTip: started.tip }))).ok).toBe(true);

    // Task "api": a failed first attempt, a revision, then accepted and merged.
    expect((await store.updateTask('api', {
      status: 'working',
      startSha: fx.base,
      workers: [{ round: 0, engine: 'claude', model: 'test-model', startedAt: '2026-11-21T12:00:00.000Z', endedAt: '2026-11-21T12:05:00.000Z', exitCode: 0, error: null, tokens: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 100, reasoning: null, costUsd: 0.04 } }],
    })).ok).toBe(true);
    let apiReview = newTaskReview(apiTask, { maxRevisionRounds: 2 });
    apiReview = must(recordGate(apiReview, { passed: false, summary: '0/1 commands passed' }));
    expect((await store.updateTask('api', { status: 'reviewing', review: apiReview })).ok).toBe(true);
    apiReview = await review(store, 'api', apiReview, passingReview(apiTask.acceptance.criteria, 'revise'));
    apiReview = must(startRevision(apiReview));
    expect((await store.updateTask('api', { status: 'working', review: apiReview })).ok).toBe(true);
    const apiCommit = await taskCommit(fx, RUN, apiTask, fx.base, { 'src/api/a.ts': 'export const a = 1;\n' });
    apiReview = await gate(store, 'api', apiReview, apiCommit);
    apiReview = await review(store, 'api', apiReview, passingReview(apiTask.acceptance.criteria));
    expect((await store.saveDiff(ctx, 'api', 1, fx.base, apiCommit)).ok).toBe(true);
    await merge(store, fx, apiTask, apiCommit, fx.base);

    // Task "docs" starts from the integration tip (it depends on "api"); the crash comes while it awaits review.
    const docsStart = store.state.integrationTip as string;
    expect((await store.updateTask('docs', { status: 'working', startSha: docsStart })).ok).toBe(true);
    const docsCommit = await taskCommit(fx, RUN, docsTask, docsStart, { 'docs/api.md': '# API\n' });
    const docsReview = await gate(store, 'docs', newTaskReview(docsTask, { maxRevisionRounds: 2 }), docsCommit);

    // The crash: nothing is closed or flushed, and the last log line is half-written.
    const logPath = join(store.folder, 'log.jsonl');
    writeFileSync(logPath, '{"v":1,"at":"2026-11-21T12:', { flag: 'a' });
    const inMemory = { state: store.state, record: store.record };
    stores.pop();
    await store.close();

    // A new conductor reads the run folder.
    const loaded = await loadRun(fx.home, RUN);
    if (!loaded.ok) throw new Error(loaded.problem.message);
    const { record, state } = loaded.value;
    expect(record).toEqual(inMemory.record);
    expect(state).toEqual(inMemory.state);
    expect(readyPlanOf(record)).toEqual(ready);
    expect(contextOf(record, fx.home)).toEqual(fx.ctx);
    expect(taskReviewOf(state, 'api')).toEqual(apiReview);
    expect(taskReviewOf(state, 'docs')).toEqual(docsReview);
    expect(finalizeInputOf(record, state)).toEqual({
      runId: RUN,
      targetBranch: 'main',
      baseSha: fx.base,
      integrationTip: docsStart,
      merged: [{ task: { id: 'api', title: apiTask.title, engine: 'claude', model: 'test-model', acceptance: apiTask.acceptance }, commit: apiCommit, mergeCommit: docsStart }],
    } satisfies FinalizeInput);
    const log = await readRunLog(fx.home, RUN);
    expect(log.ok && log.value?.partialLastLine).toBe(true);
    expect(log.ok && log.value?.records.map((r) => r.kind)).toEqual([
      'run-created', 'review', 'gate', 'review', 'merge', 'gate',
    ]);

    // It carries on from the recovered review state: accept "docs", merge it, finalize.
    const reopened = await openRun(fx.home, RUN);
    if (!reopened.ok) throw new Error(reopened.problem.message);
    const resumed = reopened.value.store;
    stores.push(resumed);
    expect(reopened.value.notes.join(' ')).toMatch(/partial last line/);
    const recoveredDocs = taskReviewOf(resumed.state, 'docs') as TaskReview;
    await review(resumed, 'docs', recoveredDocs, passingReview(docsTask.acceptance.criteria));
    await merge(resumed, fx, docsTask, docsCommit, docsStart);

    const input = finalizeInputOf(resumed.record, resumed.state) as FinalizeInput;
    expect(input.merged.map((m) => [m.task.id, m.commit])).toEqual([['api', apiCommit], ['docs', docsCommit]]);
    const report = await finalizeChecks(contextOf(resumed.record, fx.home), input, { integrity });
    expect(report.problems).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.target?.changes.map((c) => `${c.status} ${c.path}`)).toEqual(['A docs/api.md', 'A src/api/a.ts']);

    // The report comes back with every command's output; only the integrity baseline is left out.
    expect((await resumed.saveFinalizeReport(report)).ok).toBe(true);
    expect((await resumed.appendLog(finalizeEntry(report))).ok).toBe(true);
    const finalGate = report.acceptance?.gate;
    if (!finalGate) throw new Error('no gate');
    const { baseline: _baseline, ...withoutBaseline } = finalGate.integrity;
    expect(await readFinalizeReport(fx.home, RUN)).toEqual({ ok: true, value: { ...report, acceptance: { ...report.acceptance, gate: { ...finalGate, integrity: withoutBaseline } } } });
    const finalLog = await readRunLog(fx.home, RUN);
    expect(finalLog.ok && finalLog.value?.records.map((r) => r.kind).slice(-5)).toEqual(['gate', 'log-repaired', 'review', 'merge', 'finalize-check']);
  });
});
