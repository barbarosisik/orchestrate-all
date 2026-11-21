/**
 * Review state per task (step 6), as pure functions over plain data (the run store saves it later).
 *
 *   working ──gate passed──▶ awaiting-review ──accept──▶ accepted
 *      ▲     └─gate failed─▶ gate-failed      ──revise──▶ needs-revision ──startRevision──▶ working
 *      │                                       ──reject──▶ rejected
 *      └───────────────────────────────────────────────────────────┘
 *
 * Rules kept in code, whatever the reviewer says:
 * - nothing is accepted unless the deterministic gate passed (no auto-accept, no accepting failing work);
 * - "accept" also needs every criterion graded "pass" (an "unknown" is not a pass) and no finding of a
 *   blocking severity;
 * - every acceptance criterion of the task is graded exactly once;
 * - revision rounds are capped; once they are used up, the reviewer can only accept or reject.
 */

import { ReviewSchema, type Review, type Severity } from './schema.js';

export const REVIEW_STATUSES = ['working', 'gate-failed', 'awaiting-review', 'needs-revision', 'accepted', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface GateSummary {
  readonly passed: boolean;
  readonly summary: string;
}

export interface Attempt {
  /** 0 for the first attempt, then one per revision. */
  readonly round: number;
  readonly gate: GateSummary | null;
  readonly review: Review | null;
}

export interface ReviewThreshold {
  /** Findings of these severities block "accept". */
  readonly blockingSeverities: readonly Severity[];
  /** Whether a criterion graded "unknown" blocks "accept". */
  readonly unknownBlocks: boolean;
}

export const DEFAULT_REVIEW_THRESHOLD: ReviewThreshold = { blockingSeverities: ['blocker', 'major'], unknownBlocks: true };

export interface TaskReview {
  readonly taskId: string;
  /** The task's acceptance criteria, each of which a review grades. */
  readonly criteria: readonly string[];
  readonly status: ReviewStatus;
  readonly maxRevisionRounds: number;
  readonly threshold: ReviewThreshold;
  readonly attempts: readonly Attempt[];
}

export type ReviewErrorCode = 'wrong-status' | 'invalid-review' | 'criteria-mismatch' | 'below-threshold' | 'no-rounds-left';

export type Transition = { ok: true; state: TaskReview } | { ok: false; error: { code: ReviewErrorCode; message: string } };

export interface NewReviewOptions {
  readonly maxRevisionRounds: number;
  readonly threshold?: ReviewThreshold;
}

function refuse(code: ReviewErrorCode, message: string): Transition {
  return { ok: false, error: { code, message } };
}

function current(state: TaskReview): Attempt {
  return state.attempts[state.attempts.length - 1] as Attempt;
}

function withCurrent(state: TaskReview, status: ReviewStatus, change: Partial<Attempt>): TaskReview {
  const attempts = state.attempts.slice(0, -1);
  return { ...state, status, attempts: [...attempts, { ...current(state), ...change }] };
}

function wrongStatus(state: TaskReview, action: string): Transition {
  return refuse('wrong-status', `Task "${state.taskId}" is ${state.status}; it can't ${action} now.`);
}

/** Revision rounds still allowed. */
export function roundsLeft(state: TaskReview): number {
  return Math.max(0, state.maxRevisionRounds - current(state).round);
}

export function newTaskReview(
  task: { readonly id: string; readonly acceptance: { readonly criteria: readonly string[] } },
  opts: NewReviewOptions,
): TaskReview {
  if (!Number.isInteger(opts.maxRevisionRounds) || opts.maxRevisionRounds < 0) {
    throw new Error('maxRevisionRounds must be a whole number, 0 or more.');
  }
  return {
    taskId: task.id,
    criteria: [...task.acceptance.criteria],
    status: 'working',
    maxRevisionRounds: opts.maxRevisionRounds,
    threshold: opts.threshold ?? DEFAULT_REVIEW_THRESHOLD,
    attempts: [{ round: 0, gate: null, review: null }],
  };
}

/**
 * Records the deterministic gate's result for the current attempt. A full GateResult may be passed; only its
 * pass/fail and summary are kept here (the run store saves the whole result separately).
 */
export function recordGate(state: TaskReview, gate: GateSummary): Transition {
  if (state.status !== 'working') return wrongStatus(state, 'record a gate result');
  const summary: GateSummary = { passed: gate.passed, summary: gate.summary };
  return { ok: true, state: withCurrent(state, gate.passed ? 'awaiting-review' : 'gate-failed', { gate: summary }) };
}

/** Why a review doesn't grade the task's criteria exactly once each, or null. */
function criteriaProblem(state: TaskReview, review: Review): string | null {
  const graded = review.criteria.map((c) => c.criterion);
  const duplicate = graded.find((c, i) => graded.indexOf(c) !== i);
  if (duplicate !== undefined) return `"${duplicate}" is graded more than once.`;
  const missing = state.criteria.filter((c) => !graded.includes(c));
  if (missing.length > 0) return `Not graded: ${missing.map((c) => `"${c}"`).join(', ')}.`;
  const unknown = graded.filter((c) => !state.criteria.includes(c));
  if (unknown.length > 0) return `Not criteria of this task: ${unknown.map((c) => `"${c}"`).join(', ')}.`;
  return null;
}

/** What stops a review from accepting, by the threshold; empty when it may accept. */
export function acceptanceBlockers(review: Review, threshold: ReviewThreshold): string[] {
  const blockers: string[] = [];
  for (const c of review.criteria) {
    if (c.verdict === 'fail' || (c.verdict === 'unknown' && threshold.unknownBlocks)) {
      blockers.push(`Criterion "${c.criterion}" is ${c.verdict}.`);
    }
  }
  for (const f of review.findings) {
    if (threshold.blockingSeverities.includes(f.severity)) blockers.push(`A ${f.severity} finding: ${f.summary}`);
  }
  return blockers;
}

/**
 * Records the reviewer's verdict. `input` is the reviewer's JSON, checked against ReviewSchema here. A
 * refused review changes nothing; the reviewer can submit another.
 */
export function recordReview(state: TaskReview, input: unknown): Transition {
  if (state.status !== 'awaiting-review' && state.status !== 'gate-failed') return wrongStatus(state, 'be reviewed');
  const parsed = ReviewSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(review)'}: ${i.message}`);
    return refuse('invalid-review', `The review doesn't match the expected format. ${issues.join('; ')}`);
  }
  const review = parsed.data;
  const mismatch = criteriaProblem(state, review);
  if (mismatch !== null) return refuse('criteria-mismatch', mismatch);

  if (review.verdict === 'accept') {
    if (state.status === 'gate-failed') {
      return refuse('below-threshold', 'The deterministic checks failed, so the task can only be revised or rejected.');
    }
    const blockers = acceptanceBlockers(review, state.threshold);
    if (blockers.length > 0) return refuse('below-threshold', `Can't accept: ${blockers.join(' ')}`);
    return { ok: true, state: withCurrent(state, 'accepted', { review }) };
  }
  if (review.verdict === 'revise') {
    if (roundsLeft(state) === 0) {
      return refuse('no-rounds-left', `No revision rounds left (${state.maxRevisionRounds} used). Accept or reject the task.`);
    }
    return { ok: true, state: withCurrent(state, 'needs-revision', { review }) };
  }
  return { ok: true, state: withCurrent(state, 'rejected', { review }) };
}

/** Starts the next attempt after a "revise" verdict. */
export function startRevision(state: TaskReview): Transition {
  if (state.status !== 'needs-revision') return wrongStatus(state, 'start a revision');
  const round = current(state).round + 1;
  return { ok: true, state: { ...state, status: 'working', attempts: [...state.attempts, { round, gate: null, review: null }] } };
}

/** The reviewer's instructions for the worker's next attempt, after a "revise" verdict. */
export function revisionRequest(state: TaskReview): { instructions: string; findings: Review['findings'] } | null {
  const review = current(state).review;
  if (state.status !== 'needs-revision' || review === null) return null;
  return { instructions: review.instructions ?? '', findings: review.findings };
}
