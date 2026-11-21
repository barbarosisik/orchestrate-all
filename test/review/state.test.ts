import { describe, expect, it } from 'vitest';
import type { Review } from '../../src/review/schema.js';
import {
  acceptanceBlockers,
  DEFAULT_REVIEW_THRESHOLD,
  newTaskReview,
  recordGate,
  recordReview,
  revisionRequest,
  roundsLeft,
  startRevision,
  type TaskReview,
  type Transition,
} from '../../src/review/state.js';

const CRITERIA = ['GET /users returns the list', 'errors use the shared format'];
const task = { id: 'api', acceptance: { criteria: CRITERIA } };

function ok(transition: Transition): TaskReview {
  if (!transition.ok) throw new Error(`${transition.error.code}: ${transition.error.message}`);
  return transition.state;
}

function code(transition: Transition): string {
  return transition.ok ? 'ok' : transition.error.code;
}

function review(verdict: Review['verdict'], overrides: Partial<Review> = {}): Review {
  return {
    verdict,
    criteria: CRITERIA.map((criterion) => ({ criterion, verdict: 'pass', evidence: 'test users.test.ts passes' })),
    findings: [],
    ...overrides,
  };
}

function awaiting(maxRevisionRounds = 2): TaskReview {
  return ok(recordGate(newTaskReview(task, { maxRevisionRounds }), { passed: true, summary: '2/2 commands passed' }));
}

describe('newTaskReview', () => {
  it('starts the first attempt in "working"', () => {
    const state = newTaskReview(task, { maxRevisionRounds: 2 });
    expect(state).toEqual({
      taskId: 'api',
      criteria: CRITERIA,
      status: 'working',
      maxRevisionRounds: 2,
      threshold: DEFAULT_REVIEW_THRESHOLD,
      attempts: [{ round: 0, gate: null, review: null }],
    });
    expect(roundsLeft(state)).toBe(2);
  });

  it('refuses a round limit that is not a whole number of 0 or more', () => {
    expect(() => newTaskReview(task, { maxRevisionRounds: -1 })).toThrow();
    expect(() => newTaskReview(task, { maxRevisionRounds: 1.5 })).toThrow();
  });
});

describe('recordGate', () => {
  it('waits for review after a passing gate, and marks a failing one', () => {
    const fresh = newTaskReview(task, { maxRevisionRounds: 2 });
    expect(ok(recordGate(fresh, { passed: true, summary: 'ok' })).status).toBe('awaiting-review');
    const failed = ok(recordGate(fresh, { passed: false, summary: '0/1 commands passed' }));
    expect(failed.status).toBe('gate-failed');
    expect(failed.attempts[0]?.gate).toEqual({ passed: false, summary: '0/1 commands passed' });
  });

  it('keeps only the summary of a full gate result (the run store saves the rest)', () => {
    const fresh = newTaskReview(task, { maxRevisionRounds: 2 });
    const gateResult = { passed: true, summary: '1/1 commands passed', acceptance: { passed: true, commands: [] }, added: ['dist/x.js'] };
    expect(ok(recordGate(fresh, gateResult)).attempts[0]?.gate).toEqual({ passed: true, summary: '1/1 commands passed' });
  });

  it('only records a gate while the worker is working', () => {
    expect(code(recordGate(awaiting(), { passed: true, summary: 'again' }))).toBe('wrong-status');
  });
});

describe('recordReview', () => {
  it('accepts a review that passes every criterion with only minor findings', () => {
    const accepted = ok(
      recordReview(awaiting(), review('accept', { findings: [{ severity: 'minor', summary: 'a comment typo' }] })),
    );
    expect(accepted.status).toBe('accepted');
    expect(accepted.attempts[0]?.review?.verdict).toBe('accept');
  });

  it('refuses to accept when a criterion failed or is unknown, or a finding is blocking', () => {
    const failing = review('accept', {
      criteria: [
        { criterion: CRITERIA[0] as string, verdict: 'fail', evidence: 'returns 500' },
        { criterion: CRITERIA[1] as string, verdict: 'unknown', evidence: 'not checked' },
      ],
      findings: [{ severity: 'major', summary: 'no input validation', path: 'src/api/users.ts' }],
    });
    const result = recordReview(awaiting(), failing);
    expect(code(result)).toBe('below-threshold');
    expect(result.ok ? '' : result.error.message).toContain('is fail');
    expect(acceptanceBlockers(failing, DEFAULT_REVIEW_THRESHOLD)).toHaveLength(3);
    expect(acceptanceBlockers(failing, { blockingSeverities: ['blocker'], unknownBlocks: false })).toHaveLength(1);
  });

  it('can let "unknown" through when the threshold says so', () => {
    const lenient = { ...awaiting(), threshold: { blockingSeverities: ['blocker' as const], unknownBlocks: false } };
    const withUnknown = review('accept', {
      criteria: CRITERIA.map((criterion) => ({ criterion, verdict: 'unknown' as const, evidence: 'manual check needed' })),
    });
    expect(ok(recordReview(lenient, withUnknown)).status).toBe('accepted');
  });

  it('never accepts work whose deterministic gate failed', () => {
    const failed = ok(recordGate(newTaskReview(task, { maxRevisionRounds: 2 }), { passed: false, summary: 'tests fail' }));
    expect(code(recordReview(failed, review('accept')))).toBe('below-threshold');
    expect(ok(recordReview(failed, review('revise'))).status).toBe('needs-revision');
  });

  it('sends work back for revision, and rejects', () => {
    expect(ok(recordReview(awaiting(), review('revise', { instructions: 'validate input' }))).status).toBe('needs-revision');
    expect(ok(recordReview(awaiting(), review('reject'))).status).toBe('rejected');
  });

  it('refuses a review that does not follow the format', () => {
    for (const bad of [null, {}, { ...review('accept'), verdict: 'maybe' }, { ...review('accept'), extra: true }]) {
      const result = recordReview(awaiting(), bad);
      expect(code(result), JSON.stringify(bad)).toBe('invalid-review');
    }
  });

  it('needs every criterion graded exactly once, and nothing else', () => {
    const one = CRITERIA[0] as string;
    const missing = review('accept', { criteria: [{ criterion: one, verdict: 'pass', evidence: 'ok' }] });
    const twice = review('accept', {
      criteria: [...review('accept').criteria, { criterion: one, verdict: 'pass', evidence: 'ok' }],
    });
    const extra = review('accept', {
      criteria: [...review('accept').criteria, { criterion: 'something else', verdict: 'pass', evidence: 'ok' }],
    });
    for (const [input, text] of [
      [missing, 'Not graded'],
      [twice, 'more than once'],
      [extra, 'Not criteria of this task'],
    ] as const) {
      const result = recordReview(awaiting(), input);
      expect(code(result)).toBe('criteria-mismatch');
      expect(result.ok ? '' : result.error.message).toContain(text);
    }
  });

  it('only reviews a task that is waiting for review or failed its gate', () => {
    expect(code(recordReview(newTaskReview(task, { maxRevisionRounds: 2 }), review('accept')))).toBe('wrong-status');
    const accepted = ok(recordReview(awaiting(), review('accept')));
    expect(code(recordReview(accepted, review('reject')))).toBe('wrong-status');
  });

  it('leaves the state unchanged when it refuses a review', () => {
    const state = awaiting();
    const copy = structuredClone(state);
    recordReview(state, review('accept', { findings: [{ severity: 'blocker', summary: 'crashes' }] }));
    expect(state).toEqual(copy);
  });
});

describe('revision rounds', () => {
  it('starts a new attempt for each revision, up to the limit', () => {
    let state = ok(recordReview(awaiting(1), review('revise', { instructions: 'handle empty lists' })));
    expect(revisionRequest(state)).toEqual({ instructions: 'handle empty lists', findings: [] });
    state = ok(startRevision(state));
    expect(state.status).toBe('working');
    expect(state.attempts.map((a) => a.round)).toEqual([0, 1]);
    expect(roundsLeft(state)).toBe(0);
    expect(revisionRequest(state)).toBeNull();

    state = ok(recordGate(state, { passed: true, summary: 'ok' }));
    const again = recordReview(state, review('revise'));
    expect(code(again)).toBe('no-rounds-left');
    expect(ok(recordReview(state, review('reject'))).status).toBe('rejected');
  });

  it('allows no revision at all with a limit of 0', () => {
    expect(code(recordReview(awaiting(0), review('revise')))).toBe('no-rounds-left');
  });

  it('only starts a revision after a "revise" verdict', () => {
    expect(code(startRevision(awaiting()))).toBe('wrong-status');
  });

  it('gives empty instructions when the reviewer wrote none', () => {
    const state = ok(recordReview(awaiting(), review('revise')));
    expect(revisionRequest(state)?.instructions).toBe('');
  });
});
