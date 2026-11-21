import { describe, expect, it } from 'vitest';
import { newTaskReview, recordGate, recordReview, type TaskReview } from '../../src/review/state.js';
import { planRecordProblems, reviewProblem, stateProblems } from '../../src/store/consistency.js';
import type { RunState } from '../../src/store/schema.js';
import {
  contextOf,
  finalizeInputOf,
  newRunState,
  readyPlanOf,
  taskReviewOf,
  withTask,
} from '../../src/store/state.js';
import { acceptedReview, awaitingReview, BASE, NOW, SHA, sampleReady, sampleRecord } from '../helpers/store.js';

const RUN = '20261121-120000-abcd';

describe('planRecordProblems', () => {
  it('accepts the record of an approved plan', () => {
    expect(planRecordProblems(sampleRecord(RUN, [{ id: 'api' }]), RUN)).toEqual([]);
  });

  it('refuses a plan changed after approval, another run, and bad task ids', () => {
    const record = sampleRecord(RUN, [{ id: 'api' }]);
    const widened = { ...record, plan: { ...record.plan, tasks: [{ ...record.plan.tasks[0]!, owns: ['/'] }] } };
    expect(planRecordProblems(widened, RUN).join(' ')).toMatch(/does not match its hash/);
    expect(planRecordProblems(record, '20261121-120000-zzzz').join(' ')).toMatch(/belongs to run/);
    const twice = sampleRecord(RUN, [{ id: 'api' }, { id: 'api' }, { id: 'integration' }]);
    const text = planRecordProblems(twice, RUN).join(' ');
    expect(text).toMatch(/used more than once: api/);
    expect(text).toMatch(/Not valid task ids: integration/);
  });

  it('refuses a run setup changed after approval: hooks, repository, letter case or review settings', () => {
    const record = sampleRecord(RUN, [{ id: 'api' }]);
    for (const changed of [
      { ...record, hooks: 'on' as const },
      { ...record, gitCommonDir: '/elsewhere/.git' },
      { ...record, caseInsensitivePaths: false },
      { ...record, review: { ...record.review, maxRevisionRounds: 9 } },
    ]) {
      expect(planRecordProblems(changed, RUN).join(' ')).toMatch(/run setup .* does not match its hash/);
    }
  });
});

describe('reviewProblem', () => {
  it('accepts review states made by the review transitions', () => {
    expect(reviewProblem(newTaskReview({ id: 'api', acceptance: { criteria: ['works'] } }, { maxRevisionRounds: 2 }))).toBeNull();
    expect(reviewProblem(acceptedReview('api'))).toBeNull();
    expect(reviewProblem(acceptedReview('api', ['works', 'fast'], true))).toBeNull();
  });

  it('refuses a review state marked accepted without passing the gate and an accepting review', () => {
    const fresh = newTaskReview({ id: 'api', acceptance: { criteria: ['works'] } }, { maxRevisionRounds: 2 });
    expect(reviewProblem({ ...fresh, status: 'accepted' })).toMatch(/not what its gates and reviews lead to/);
    const accepted = acceptedReview('api');
    const failedGate: TaskReview = {
      ...accepted,
      attempts: [{ ...accepted.attempts[0]!, gate: { passed: false, summary: 'failed' } }],
    };
    expect(reviewProblem(failedGate)).toMatch(/review of round 0 was refused/);
    const noGate: TaskReview = { ...accepted, attempts: [{ ...accepted.attempts[0]!, gate: null }] };
    expect(reviewProblem(noGate)).toMatch(/refused/);
  });

  it('refuses more revisions than allowed and an invalid limit', () => {
    const revised = acceptedReview('api', ['works'], true);
    expect(reviewProblem({ ...revised, maxRevisionRounds: 0 })).toMatch(/refused/);
    expect(reviewProblem({ ...revised, maxRevisionRounds: -1 })).toMatch(/whole number/);
  });
});

function mergedState(): { record: ReturnType<typeof sampleRecord>; state: RunState } {
  const record = sampleRecord(RUN, [{ id: 'api' }, { id: 'ui', dependsOn: ['api'] }, { id: 'docs' }]);
  let state = newRunState(record, NOW);
  state = withTask(state, 'api', { status: 'merged', startSha: BASE, commit: SHA('1'), review: acceptedReview('api'), mergeCommit: SHA('2') });
  state = withTask(state, 'ui', { status: 'merged', startSha: SHA('2'), commit: SHA('3'), review: acceptedReview('ui'), mergeCommit: null });
  state = withTask(state, 'docs', { status: 'reviewing', startSha: BASE, commit: SHA('4'), review: awaitingReview('docs') });
  return { record, state: { ...state, mergeOrder: ['api', 'ui'], integrationTip: SHA('2') } };
}

describe('stateProblems', () => {
  it('accepts a new run and a run with merged tasks', () => {
    const record = sampleRecord(RUN, [{ id: 'api' }]);
    expect(stateProblems(record, newRunState(record, NOW))).toEqual([]);
    const { record: r2, state } = mergedState();
    expect(stateProblems(r2, state)).toEqual([]);
  });

  it('refuses a state from another run, plan, branch or base commit', () => {
    const record = sampleRecord(RUN, [{ id: 'api' }]);
    const state = newRunState(record, NOW);
    const text = stateProblems(record, {
      ...state,
      runId: '20261121-120000-zzzz',
      planHash: `sha256:${'0'.repeat(64)}`,
      targetBranch: 'other',
      baseSha: SHA('9'),
    }).join(' ');
    expect(text).toMatch(/belongs to run/);
    expect(text).toMatch(/different plan/);
    expect(text).toMatch(/target branch is "other"/);
    expect(text).toMatch(/base commit/);
  });

  it("refuses tasks that aren't the plan's, in its order", () => {
    const record = sampleRecord(RUN, [{ id: 'api' }, { id: 'ui' }]);
    const state = newRunState(record, NOW);
    expect(stateProblems(record, { ...state, tasks: [...state.tasks].reverse() }).join(' ')).toMatch(/are not the plan's/);
  });

  it('refuses merge records that disagree with each other', () => {
    const { record, state } = mergedState();
    const problems = (s: RunState): string => stateProblems(record, s).join(' ');
    expect(problems(withTask(state, 'docs', { status: 'merged', review: acceptedReview('docs') }))).toMatch(/merged but not in the merge order/);
    expect(problems({ ...state, mergeOrder: ['api', 'ui', 'docs'] })).toMatch(/in the merge order but is reviewing/);
    expect(problems(withTask(state, 'api', { review: null }))).toMatch(/merged without an accepted review/);
    expect(problems(withTask(state, 'docs', { mergeCommit: SHA('5') }))).toMatch(/has a merge commit but is reviewing/);
    expect(problems({ ...state, mergeOrder: ['ui', 'api'] })).toMatch(/"ui" was merged before "api"/);
    expect(problems({ ...state, mergeOrder: ['api', 'api', 'ui'] })).toMatch(/more than once/);
    expect(problems({ ...state, mergeOrder: ['api', 'ui', 'nope'] })).toMatch(/not in the plan: nope/);
  });

  it('requires the integration tip to be the last merge commit, or the base commit', () => {
    const { record, state } = mergedState();
    expect(stateProblems(record, { ...state, integrationTip: SHA('3') }).join(' ')).toMatch(/is not the last merge/);
    expect(stateProblems(record, { ...state, integrationTip: null }).join(' ')).toMatch(/no integration tip/);
    const fresh = newRunState(record, NOW);
    expect(stateProblems(record, { ...fresh, integrationTip: BASE })).toEqual([]);
    expect(stateProblems(record, { ...fresh, integrationTip: SHA('7') }).join(' ')).toMatch(/is not the last merge/);
  });

  it('checks start commits, review criteria and the final commit', () => {
    const { record, state } = mergedState();
    const text = (s: RunState): string => stateProblems(record, s).join(' ');
    expect(text(withTask(state, 'docs', { startSha: SHA('8') }))).toMatch(/did not start from the base commit/);
    expect(text(withTask(state, 'docs', { review: acceptedReview('docs', ['other']) }))).toMatch(/other criteria/);
    expect(text(withTask(state, 'docs', { review: acceptedReview('api') }))).toMatch(/holds the review state of "api"/);
    expect(text({ ...state, status: 'finalized' })).toMatch(/without a final commit/);
    expect(text({ ...state, finalCommit: SHA('6') })).toMatch(/running but has a final commit/);
    expect(stateProblems(record, { ...state, status: 'finalized', finalCommit: SHA('6') })).toEqual([]);
  });

  it('lists at most ten problems', () => {
    const record = sampleRecord(RUN, Array.from({ length: 12 }, (_, i) => ({ id: `t${i}` })));
    let state = newRunState(record, NOW);
    for (const t of state.tasks) state = withTask(state, t.id, { mergeCommit: SHA('5') });
    const problems = stateProblems(record, state);
    expect(problems).toHaveLength(11);
    expect(problems[10]).toMatch(/and \d+ more/);
  });
});

describe('states the steps cannot produce', () => {
  const record = sampleRecord(RUN, [{ id: 'api' }, { id: 'ui', dependsOn: ['api'] }]);
  const fresh = newRunState(record, NOW);
  const text = (s: RunState): string => stateProblems(record, s).join(' ');

  it("refuses a review that uses another threshold or revision limit than the run's", () => {
    const lenient = newTaskReview({ id: 'api', acceptance: { criteria: ['works'] } }, {
      maxRevisionRounds: 2,
      threshold: { blockingSeverities: [], unknownBlocks: false },
    });
    const gated = recordGate(lenient, { passed: true, summary: 'ok' });
    const accepted = gated.ok
      ? recordReview(gated.state, {
          verdict: 'accept',
          criteria: [{ criterion: 'works', verdict: 'unknown', evidence: 'not checked' }],
          findings: [{ severity: 'blocker', summary: 'It deletes data.' }],
        })
      : gated;
    if (!accepted.ok) throw new Error('setup failed');
    expect(text(withTask(fresh, 'api', { status: 'accepted', startSha: BASE, commit: SHA('1'), review: accepted.state }))).toMatch(
      /other review settings than the run's/,
    );
    const moreRounds = { ...acceptedReview('api'), maxRevisionRounds: 5 };
    expect(text(withTask(fresh, 'api', { status: 'accepted', startSha: BASE, commit: SHA('1'), review: moreRounds }))).toMatch(/other review settings/);
  });

  it('refuses a task that started before the tasks it depends on were merged', () => {
    expect(text(withTask(fresh, 'ui', { status: 'working', startSha: SHA('2') }))).toMatch(/"ui" started before api/);
  });

  it('refuses a merged task without a start commit, and two tasks with one merge commit', () => {
    let state = withTask(fresh, 'api', { status: 'merged', startSha: null, commit: SHA('1'), review: acceptedReview('api'), mergeCommit: SHA('2') });
    state = { ...state, mergeOrder: ['api'], integrationTip: SHA('2') };
    expect(text(state)).toMatch(/"api" is merged without a start commit/);
    state = withTask(state, 'api', { startSha: BASE });
    state = withTask(state, 'ui', { status: 'merged', startSha: SHA('2'), commit: SHA('3'), review: acceptedReview('ui'), mergeCommit: SHA('2') });
    expect(text({ ...state, mergeOrder: ['api', 'ui'] })).toMatch(/same merge commit/);
  });

  it("refuses a status that doesn't fit the task's record", () => {
    expect(text(withTask(fresh, 'api', { commit: SHA('1') }))).toMatch(/"api" is waiting but has already started/);
    expect(text(withTask(fresh, 'api', { review: acceptedReview('api') }))).toMatch(/"api" is waiting, but its review state is accepted/);
    expect(text(withTask(fresh, 'api', { status: 'working' }))).toMatch(/"api" is working without a start commit/);
    expect(text(withTask(fresh, 'api', { status: 'reviewing', startSha: BASE }))).toMatch(/is reviewing, but its review state is missing/);
    expect(text(withTask(fresh, 'api', { status: 'rejected', startSha: BASE, review: acceptedReview('api') }))).toMatch(/is rejected, but its review state is accepted/);
    expect(text(withTask(fresh, 'api', { status: 'failed', startSha: BASE, reason: 'integrity' }))).toBe('');
  });

  it('refuses a finalized run with nothing merged', () => {
    expect(text({ ...fresh, status: 'finalized', finalCommit: SHA('9') })).toMatch(/finalized, but nothing was merged/);
  });

  it('refuses a state written for another run setup', () => {
    expect(text({ ...fresh, setupHash: `sha256:${'1'.repeat(64)}` })).toMatch(/different run setup/);
  });
});

describe('recovery helpers', () => {
  it('rebuilds the finalize input in merge order from the plan and the state', () => {
    const { record, state } = mergedState();
    expect(finalizeInputOf(record, newRunState(record, NOW))).toBeNull();
    const input = finalizeInputOf(record, state);
    expect(input).toEqual({
      runId: RUN,
      targetBranch: 'main',
      baseSha: BASE,
      integrationTip: SHA('2'),
      merged: [
        { task: { id: 'api', title: 'Task api', engine: 'claude', model: 'test-model', acceptance: { commands: [], criteria: ['works'] } }, commit: SHA('1'), mergeCommit: SHA('2') },
        { task: { id: 'ui', title: 'Task ui', engine: 'claude', model: 'test-model', acceptance: { commands: [], criteria: ['works'] } }, commit: SHA('3'), mergeCommit: null },
      ],
    });
    expect(() => finalizeInputOf(record, withTask(state, 'api', { commit: null }))).toThrow(/missing/);
  });

  it('gives back the review states, the ready plan and the repository context', () => {
    const { record, state } = mergedState();
    expect(taskReviewOf(state, 'api')).toEqual(acceptedReview('api'));
    expect(taskReviewOf(state, 'docs')).toEqual(awaitingReview('docs'));
    expect(taskReviewOf(newRunState(record, NOW), 'docs')).toBeNull();
    expect(taskReviewOf(state, 'nope')).toBeNull();
    expect(readyPlanOf(record)).toEqual(sampleReady([{ id: 'api' }, { id: 'ui', dependsOn: ['api'] }, { id: 'docs' }]));
    expect(contextOf(record, '/home/o')).toEqual({
      repoRoot: '/repo',
      commonDir: '/repo/.git',
      home: '/home/o',
      hooks: 'off',
      caseInsensitivePaths: true,
    });
    expect(() => withTask(state, 'nope', { status: 'failed' })).toThrow(/no task "nope"/);
  });
});
