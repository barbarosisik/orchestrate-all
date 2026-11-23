/**
 * The run store's file formats, as zod schemas (step 9). Every file is read back through these: the run
 * folder is treated as untrusted on read, because until workers are sandboxed (step 10) a worker could write
 * there. Each JSON file carries `schemaVersion`; each log line carries `v`. A file from another version is
 * reported as such, never guessed at.
 *
 * Shapes only. Whether a state makes sense for its plan (merge order, integration tip, review history) is
 * checked in consistency.ts.
 */

import { z } from 'zod';
import type { GateResult } from '../accept/gate.js';
import { COMMAND_STATUSES } from '../accept/run.js';
import { WorkerResultSchema } from '../brief/result.js';
import { OWN_FINALIZE_PROBLEM_CODES, type FinalizeReport } from '../finalize/check.js';
import { CHECKOUT_PROBLEM_CODES } from '../finalize/checkouts.js';
import type { CombinedResult } from '../finalize/combined.js';
import { TARGET_PROBLEM_CODES } from '../finalize/target.js';
import { INTEGRITY_VIOLATION_CODES, type IntegrityReport } from '../integrity/check.js';
import { ENGINE_NAMES, MODEL_PATTERN, PlanSchema, TASK_ID_PATTERN } from '../plan/schema.js';
import { REVIEW_VERDICTS, ReviewSchema, SEVERITIES } from '../review/schema.js';
import { REVIEW_STATUSES, type TaskReview } from '../review/state.js';
import { isValidRunId } from '../run/names.js';
import { CHANGE_STATUSES } from '../scope/diff.js';
import { MAX_ROUND } from './layout.js';

export const STORE_SCHEMA_VERSION = 1;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ShaSchema = z.string().regex(FULL_SHA, 'Expected a full commit id.');
const TimeSchema = z.iso.datetime();
const TaskIdSchema = z.string().regex(TASK_ID_PATTERN);
const RunIdSchema = z.string().refine(isValidRunId, 'Not a valid run id.');
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RoundSchema = z.number().int().min(0).max(MAX_ROUND);
const Count = z.number().int().min(0);
const Version = z.literal(STORE_SCHEMA_VERSION);

// ---------------------------------------------------------------------------------------------------------
// plan.json: the approved plan, written once when the run is created.

/** The plan as approved: the normalized plan plus its base commit (ReadyPlan['plan']). */
export const StoredPlanSchema = PlanSchema.extend({ baseSha: ShaSchema }).strict();

const ThresholdSchema = z
  .object({ blockingSeverities: z.array(z.enum(SEVERITIES)).max(SEVERITIES.length), unknownBlocks: z.boolean() })
  .strict();

/** The review settings every task of the run uses (review/state.ts). */
export const ReviewSettingsSchema = z.object({ maxRevisionRounds: RoundSchema, threshold: ThresholdSchema }).strict();
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

export const PlanRecordSchema = z
  .object({
    schemaVersion: Version,
    runId: RunIdSchema,
    /** sha256Of(plan): what the user approved. */
    planHash: HashSchema,
    /** sha256Of(this record without setupHash): covers the settings below too. state.json repeats it. */
    setupHash: HashSchema,
    plan: StoredPlanSchema,
    /** Where the repository is, to rebuild the RepoContext after a restart. */
    repoRoot: z.string().min(1).max(4096),
    gitCommonDir: z.string().min(1).max(4096),
    hooks: z.enum(['off', 'on']),
    caseInsensitivePaths: z.boolean(),
    review: ReviewSettingsSchema,
    createdAt: TimeSchema,
  })
  .strict();

export type PlanRecord = z.infer<typeof PlanRecordSchema>;

// ---------------------------------------------------------------------------------------------------------
// state.json: the run's state.

export const TaskReviewSchema = z
  .object({
    taskId: TaskIdSchema,
    criteria: z.array(z.string().min(1)).max(50),
    status: z.enum(REVIEW_STATUSES),
    maxRevisionRounds: RoundSchema,
    threshold: ThresholdSchema,
    attempts: z
      .array(
        z
          .object({
            round: RoundSchema,
            gate: z.object({ passed: z.boolean(), summary: z.string() }).strict().nullable(),
            review: ReviewSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROUND + 1),
  })
  .strict();

/** Tokens as the engine reported them (research §5); null where an engine doesn't report a kind. */
export const TokenUsageSchema = z
  .object({
    input: Count,
    output: Count,
    cacheRead: Count.nullable(),
    cacheWrite: Count.nullable(),
    reasoning: Count.nullable(),
    /** The engine's own cost estimate (Claude reports one even on a subscription). */
    costUsd: z.number().min(0).nullable(),
  })
  .strict();

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * The worker's process, recorded once it started (step 12): its id and the system's note of when it started
 * (os/process-identity.ts), so that after a crash of the conductor a worker that outlived it can be found and
 * stopped, and a reused id is never taken for it. `start` is null when it could not be read.
 */
export const WorkerProcessSchema = z
  .object({ pid: z.number().int().positive().max(2 ** 32 - 1), start: z.string().min(1).max(200).nullable() })
  .strict();

/** One worker run: one per review round, more if a worker was restarted. */
export const WorkerRunSchema = z
  .object({
    round: RoundSchema,
    engine: z.enum(ENGINE_NAMES),
    model: z.string().regex(MODEL_PATTERN),
    startedAt: TimeSchema,
    endedAt: TimeSchema.nullable(),
    exitCode: z.number().int().nullable(),
    error: z.string().nullable(),
    tokens: TokenUsageSchema.nullable(),
    process: WorkerProcessSchema.nullable().optional(),
  })
  .strict();

export type WorkerRun = z.infer<typeof WorkerRunSchema>;

/**
 * Where a task is. The review state machine (`review`) has the detail while a task is being reviewed.
 * - waiting: not started (its dependencies aren't merged yet, or no worker is free);
 * - working: its worker or its gate is running;
 * - reviewing: waiting for, or in, review;
 * - accepted: accepted, waiting to be merged;
 * - merged: in the integration branch (or accepted with nothing to merge);
 * - rejected, failed (stopped by a check or an error), cancelled: finished without being merged.
 */
export const TASK_STATUSES = ['waiting', 'working', 'reviewing', 'accepted', 'merged', 'rejected', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskStateSchema = z
  .object({
    id: TaskIdSchema,
    status: z.enum(TASK_STATUSES),
    /** Why the task failed or was cancelled. */
    reason: z.string().nullable(),
    /** The commit its worktree started from. */
    startSha: ShaSchema.nullable(),
    /** Its latest commit, made by the conductor. */
    commit: ShaSchema.nullable(),
    review: TaskReviewSchema.nullable(),
    /** The merge commit in the integration branch; null until merged, and when merging changed nothing. */
    mergeCommit: ShaSchema.nullable(),
    workers: z.array(WorkerRunSchema).max(1000),
  })
  .strict();

export type TaskState = z.infer<typeof TaskStateSchema>;

export const RUN_STATUSES = ['running', 'finalized', 'discarded'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RunStateSchema = z
  .object({
    schemaVersion: Version,
    runId: RunIdSchema,
    planHash: HashSchema,
    /** The same as plan.json's: a state belongs to exactly one run setup. */
    setupHash: HashSchema,
    status: z.enum(RUN_STATUSES),
    targetBranch: z.string().max(1024),
    baseSha: ShaSchema,
    /** Where the integration branch points; null until it is created. */
    integrationTip: ShaSchema.nullable(),
    /** Merged tasks, in the order merged. */
    mergeOrder: z.array(TaskIdSchema).max(100),
    /** The merge commit on the user's branch once finalized (step 13). */
    finalCommit: ShaSchema.nullable(),
    /** One per plan task, in plan order. */
    tasks: z.array(TaskStateSchema).min(1).max(100),
    createdAt: TimeSchema,
    updatedAt: TimeSchema,
  })
  .strict();

export type RunState = z.infer<typeof RunStateSchema>;

// ---------------------------------------------------------------------------------------------------------
// gate-<round>.json and finalize.json: results of the acceptance commands and the finalize checks.

const TreeChangeSchema = z
  .object({
    path: z.string().min(1),
    status: z.enum(CHANGE_STATUSES),
    oldMode: z.string(),
    newMode: z.string(),
    oldId: z.string(),
    newId: z.string(),
  })
  .strict();

const CapturedOutputSchema = z.object({ text: z.string(), totalBytes: Count, truncated: z.boolean() }).strict();

const CommandResultSchema = z
  .object({
    argv: z.array(z.string()),
    program: z.string().nullable(),
    status: z.enum(COMMAND_STATUSES),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    durationMs: z.number().min(0),
    stdout: CapturedOutputSchema,
    stderr: CapturedOutputSchema,
    error: z.string().nullable(),
  })
  .strict();

const AcceptanceResultSchema = z.object({ passed: z.boolean(), commands: z.array(CommandResultSchema) }).strict();
const IntegrityViolationSchema = z.object({ code: z.enum(INTEGRITY_VIOLATION_CODES), message: z.string() }).strict();

/**
 * A gate as saved: the GateResult without the integrity baseline. The baseline (every ref, checkout and git
 * config file of the user's, fingerprinted) is only needed while the run is going and can be large.
 */
export const StoredGateSchema = z
  .object({
    passed: z.boolean(),
    acceptance: AcceptanceResultSchema,
    integrity: z.object({ ok: z.boolean(), violations: z.array(IntegrityViolationSchema) }).strict(),
    added: z.array(z.string()),
    trackedChanged: z.array(z.string()),
    scopeProblem: z.string().nullable(),
    summary: z.string(),
  })
  .strict();

export type StoredGate = z.infer<typeof StoredGateSchema>;
/** The program's GateResult, as the store keeps it. */
export type StoredGateResult = Omit<GateResult, 'integrity'> & { readonly integrity: Omit<IntegrityReport, 'baseline'> };
/** The program's FinalizeReport, as the store keeps it: its gate without the baseline. */
export type StoredFinalizeReport = Omit<FinalizeReport, 'acceptance'> & {
  readonly acceptance: (Omit<CombinedResult, 'gate'> & { readonly gate: StoredGateResult | null }) | null;
};

export const GateRecordSchema = z
  .object({ schemaVersion: Version, runId: RunIdSchema, taskId: TaskIdSchema, round: RoundSchema, savedAt: TimeSchema, gate: StoredGateSchema })
  .strict();

const TaskAcceptanceSchema = z.object({ id: z.string(), passed: z.boolean(), commands: z.array(CommandResultSchema) }).strict();

/** The report keeps what the checks were given, even when that was invalid ("bad-input"), so plain strings. */
export const FinalizeReportSchema = z
  .object({
    ready: z.boolean(),
    runId: z.string(),
    targetBranch: z.string(),
    baseSha: z.string(),
    integrationTip: z.string(),
    target: z
      .object({
        branch: z.string(),
        tip: z.string(),
        moved: z.boolean(),
        newCommits: Count,
        tree: z.string(),
        changes: z.array(TreeChangeSchema),
        overlap: z.array(z.string()),
      })
      .strict()
      .nullable(),
    tasks: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          engine: z.string(),
          model: z.string(),
          commit: z.string(),
          mergeCommit: z.string().nullable(),
          changes: z.array(TreeChangeSchema),
          acceptance: TaskAcceptanceSchema.nullable(),
        })
        .strict(),
    ),
    checkouts: z.array(z.string()),
    acceptance: z
      .object({
        passed: z.boolean(),
        tip: z.string(),
        tasks: z.array(TaskAcceptanceSchema),
        gate: StoredGateSchema.nullable(),
        problem: z.string().nullable(),
        cleanup: z.array(z.string()),
      })
      .strict()
      .nullable(),
    problems: z.array(
      z
        .object({
          code: z.union([z.enum(OWN_FINALIZE_PROBLEM_CODES), z.enum(TARGET_PROBLEM_CODES), z.enum(CHECKOUT_PROBLEM_CODES)]),
          message: z.string(),
          paths: z.array(z.string()),
        })
        .strict(),
    ),
    notes: z.array(z.string()),
  })
  .strict();

export const FinalizeRecordSchema = z
  .object({ schemaVersion: Version, runId: RunIdSchema, savedAt: TimeSchema, report: FinalizeReportSchema })
  .strict();

// ---------------------------------------------------------------------------------------------------------
// result-<round>.json: the worker's own result for one round (brief/result.ts), kept for dependents' briefs.

/** How a worker's files_changed compares with the conductor's own diff of its round. */
export const ClaimsSchema = z
  .object({
    /** Files the round changed that the worker did not list. */
    unclaimed: z.array(z.string().max(4096)).max(10_000),
    /** Files the worker listed that the round did not change. */
    notChanged: z.array(z.string().max(4096)).max(10_000),
  })
  .strict();

export type Claims = z.infer<typeof ClaimsSchema>;

export const ResultRecordSchema = z
  .object({
    schemaVersion: Version,
    runId: RunIdSchema,
    taskId: TaskIdSchema,
    round: RoundSchema,
    savedAt: TimeSchema,
    /** The worker's result as parsed, or null when there was none to read. It is the worker's account only. */
    result: WorkerResultSchema.nullable(),
    /** Why there is no result, or null. */
    problem: z.string().max(4_000).nullable(),
    /** Null when there was no diff to compare with (nothing committed in this round). */
    claims: ClaimsSchema.nullable(),
  })
  .strict();

export type StoredResult = Pick<z.infer<typeof ResultRecordSchema>, 'result' | 'problem' | 'claims'>;

// ---------------------------------------------------------------------------------------------------------
// log.jsonl: one record per line. Records are summaries; full results live in the files above.

/**
 * Limits for log records, in bytes as JSON (entries.ts cuts to them), so that the largest record stays near
 * 32 KiB, well under the line limit. A string of N such bytes has at most N characters, which the schema checks.
 */
export const LOG_LIMITS = {
  /** A summary, a note, a reason. */
  text: 2_000,
  /** A problem's message. */
  message: 1_000,
  code: 64,
  /** Problems listed in one record; the rest are counted in `more`. */
  items: 10,
  /** Paths listed per problem, and the length of each. */
  paths: 5,
  path: 400,
} as const;

const LoggedText = z.string().max(LOG_LIMITS.text);
const LoggedProblemSchema = z
  .object({
    code: z.string().max(LOG_LIMITS.code),
    message: z.string().max(LOG_LIMITS.message),
    paths: z.array(z.string().max(LOG_LIMITS.path)).max(LOG_LIMITS.paths),
  })
  .strict();
const LoggedProblemsSchema = z.object({ shown: z.array(LoggedProblemSchema).max(LOG_LIMITS.items), more: Count }).strict();

export type LoggedProblem = z.infer<typeof LoggedProblemSchema>;
export type LoggedProblems = z.infer<typeof LoggedProblemsSchema>;

const record = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.object({ v: Version, at: TimeSchema, kind: z.literal(kind), ...shape }).strict();

export const LogRecordSchema = z.discriminatedUnion('kind', [
  record('run-created', { planHash: HashSchema, targetBranch: z.string().max(1024), baseSha: ShaSchema, tasks: z.array(TaskIdSchema).max(100) }),
  record('run-status', { status: z.enum(RUN_STATUSES), finalCommit: ShaSchema.nullable() }),
  record('task-status', { task: TaskIdSchema, status: z.enum(TASK_STATUSES), reason: LoggedText.nullable() }),
  record('worker', {
    task: TaskIdSchema,
    round: RoundSchema,
    event: z.enum(['started', 'finished']),
    engine: z.enum(ENGINE_NAMES),
    model: z.string().regex(MODEL_PATTERN),
    exitCode: z.number().int().nullable(),
    error: LoggedText.nullable(),
  }),
  record('integrity', { task: TaskIdSchema, round: RoundSchema, ok: z.boolean(), problems: LoggedProblemsSchema }),
  /** The agents' own config folders compared before and after a worker (step 10, engines/agent-config.ts). */
  record('agent-config', { task: TaskIdSchema, round: RoundSchema, ok: z.boolean(), problems: LoggedProblemsSchema }),
  record('scope', { task: TaskIdSchema, round: RoundSchema, clean: z.boolean(), files: Count, problems: LoggedProblemsSchema }),
  record('commit', { task: TaskIdSchema, round: RoundSchema, commit: ShaSchema, files: Count }),
  record('gate', { task: TaskIdSchema, round: RoundSchema, passed: z.boolean(), summary: LoggedText }),
  record('review', {
    task: TaskIdSchema,
    round: RoundSchema,
    verdict: z.enum(REVIEW_VERDICTS).nullable(),
    /** The review state afterwards; unchanged when the review was refused. */
    status: z.enum(REVIEW_STATUSES),
    refused: LoggedProblemSchema.nullable(),
  }),
  record('merge', { task: TaskIdSchema, merged: z.boolean(), tip: ShaSchema.nullable(), files: Count, refused: LoggedProblemSchema.nullable() }),
  record('finalize-check', { ready: z.boolean(), tip: ShaSchema.nullable(), tree: ShaSchema.nullable(), problems: LoggedProblemsSchema }),
  record('note', { message: LoggedText }),
  /** Written by the store when the log reached its size limit and older records were left out. */
  record('log-truncated', { droppedRecords: Count, droppedBytes: Count }),
  /** Written by the store when it found a partial last line (an interrupted write) and removed it. */
  record('log-repaired', { droppedBytes: Count }),
]);

export type LogRecord = z.infer<typeof LogRecordSchema>;
type WithoutStamp<T> = T extends unknown ? Omit<T, 'v' | 'at'> : never;
/** A record before the store stamps it with the format version and the time. */
export type LogEntry = WithoutStamp<LogRecord>;

// ---------------------------------------------------------------------------------------------------------
// Compile-time checks, both ways: what a schema accepts can be used as the program's type, and every field the
// program's type has is one the schema expects, with the same type. (Value limits, such as a time of 0 or more,
// are not types: tests cover those with real results.)

type Expect<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Writable<T> = T extends readonly (infer U)[] ? Writable<U>[] : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T;
export type SchemaTypeChecks = [
  Expect<Assignable<z.infer<typeof FinalizeReportSchema>, StoredFinalizeReport>>,
  Expect<Assignable<Writable<StoredFinalizeReport>, z.input<typeof FinalizeReportSchema>>>,
  Expect<Assignable<z.infer<typeof StoredGateSchema>, StoredGateResult>>,
  Expect<Assignable<Writable<StoredGateResult>, z.input<typeof StoredGateSchema>>>,
  Expect<Assignable<z.infer<typeof TaskReviewSchema>, TaskReview>>,
  Expect<Assignable<Writable<TaskReview>, z.input<typeof TaskReviewSchema>>>,
];
