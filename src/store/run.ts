/**
 * The run store (step 9): everything a run produces, saved in `<home>/runs/<runId>/` (layout.ts), where the
 * user can read it (R4) and a restarted conductor can carry on from it (step 12).
 *
 * - createRun: the run folder is built under a temporary name, then renamed into place, so a run folder
 *   either holds a complete plan, state and log or doesn't exist. Orchestra never reuses a run folder.
 * - openRun: for the conductor after a restart. Loads and checks everything, removes leftover temporary
 *   files, and removes a partial last log line (recording that it did).
 * - loadRun and the read functions: read-only, for showing a run. Everything read is checked by zod
 *   (schema.ts) and against the plan (consistency.ts): until workers are sandboxed (step 10), a worker could
 *   write here. A missing or damaged file is reported as a problem with a plain message, never a crash.
 * - RunStore: the writer for one open run. Writes go one at a time through a queue; the state is checked
 *   before it is written (the store never writes what it would refuse to read) and is only replaced in
 *   memory once it is on disk. Every write first checks that no folder on the way is a link.
 * - listRuns and removeRun: valid run folders only; anything else in `<home>/runs` is reported, and removal
 *   never deletes through a link.
 *
 * Single writer: one process (the conductor; step 12's background service) writes a run. This module refuses
 * to open a run twice in the same process (the run is claimed before any slow work, and released only once
 * close() has finished every queued write and closed every output file). A lock between processes is left to
 * step 12, which owns the service's lifetime and can tell a stale lock from a live one.
 *
 * Size: a gate or finalize report too large for its file has its command outputs cut to fit (fit.ts); the
 * integrity baseline is left out of both (it is only needed while the run is going).
 *
 * No secrets: nothing here reads environment variables or credentials. Acceptance output comes from commands
 * that ran with an allowlisted environment. Worker output is stored as the worker printed it, so a secret a
 * worker printed would be stored too (noted in docs/HANDOFF.md).
 */

import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateResult } from '../accept/gate.js';
import type { FinalizeReport } from '../finalize/check.js';
import { repoGitRaw, type RepoContext } from '../git/context.js';
import { describeGitFailure, LONG_GIT_TIMEOUT_MS } from '../git/run.js';
import { canonicalPath, DEFAULT_CASE_INSENSITIVE, isInsidePath, samePath } from '../repo/canonical.js';
import { isValidRunId, isValidTaskId } from '../run/names.js';
import { planRecordProblems, stateProblems } from './consistency.js';
import { issueText, parseDocument, readDocument, storeFail, writeDocument, type StoreProblem, type StoreResult } from './documents.js';
import {
  ensureRealFolder,
  folderProblem,
  isTempName,
  readFileCapped,
  removeTempEntries,
  removeTree,
  syncFolder,
  tempName,
  withRetry,
  writeFileAtomic,
  type AtomicWriteOptions,
  type FileProblem,
} from './files.js';
import {
  firstFolderProblem,
  isOutputStream,
  isValidRound,
  MAX_ROUND,
  roundFile,
  RUN_FILES,
  runPaths,
  runsFolder,
  taskFolder,
  TASKS_FOLDER,
  type OutputStream,
  type RunPaths,
} from './layout.js';
import { fitOutputs } from './fit.js';
import { DEFAULT_MAX_LOG_BYTES, LogWriter, readLog, type ParsedLog } from './log.js';
import {
  FinalizeRecordSchema,
  GateRecordSchema,
  PlanRecordSchema,
  RunStateSchema,
  STORE_SCHEMA_VERSION,
  type LogEntry,
  type PlanRecord,
  type RunState,
  type StoredFinalizeReport,
  type StoredGate,
} from './schema.js';
import { newPlanRecord, newRunState, withTask, type NewRunInput, type TaskChange } from './state.js';
import { CappedOutput, DEFAULT_MAX_OUTPUT_BYTES, readCappedOutput, type StoredOutput } from './stream.js';

export { type StoreProblem, type StoreProblemCode, type StoreResult } from './documents.js';

const MIB = 1024 * 1024;
/** Largest file of each kind the store writes or reads. */
export const MAX_FILE_BYTES = { plan: 32 * MIB, state: 16 * MIB, finalize: 64 * MIB, gate: 32 * MIB } as const;
export type FileLimits = { readonly [K in keyof typeof MAX_FILE_BYTES]: number };
export const DEFAULT_MAX_DIFF_BYTES = 4 * MIB;
/** Briefs are rendered with every part bounded (brief/render.ts), so one stays under 2 MiB; this leaves room. */
export const DEFAULT_MAX_BRIEF_BYTES = 4 * MIB;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIFF_MARKER = /\n\[\.\.\. diff cut at \d+ bytes by Orchestra \.\.\.\]\n$/;

export interface StoreOptions {
  readonly now?: () => Date;
  readonly maxLogBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxDiffBytes?: number;
  readonly maxBriefBytes?: number;
  /** Size limits per file kind, for the writer and the readers alike (default MAX_FILE_BYTES). */
  readonly maxFileBytes?: Partial<FileLimits>;
  /** Tests only: replaces fs.rename in atomic writes, to simulate a failure between the write and the rename. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

export interface LoadedRun {
  readonly runId: string;
  readonly folder: string;
  readonly record: PlanRecord;
  readonly state: RunState;
}

/** Runs open for writing in this process, by folder (compared as the file system does: see folderKey). */
const openFolders = new Set<string>();

/** Windows and macOS ignore letter case, so two spellings of one home must not open a run twice. */
function folderKey(folder: string): string {
  const nfc = folder.normalize('NFC');
  return DEFAULT_CASE_INSENSITIVE ? nfc.toLowerCase() : nfc;
}

function problem<T>(found: FileProblem | StoreProblem): StoreResult<T> {
  return { ok: false, problem: found };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function badRunId<T>(runId: string): StoreResult<T> {
  return storeFail('bad-name', `"${runId}" is not a valid run id.`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function limits(opts: StoreOptions): FileLimits {
  return { ...MAX_FILE_BYTES, ...opts.maxFileBytes };
}

function atomicOptions(opts: StoreOptions): AtomicWriteOptions {
  return opts.rename === undefined ? {} : { rename: opts.rename };
}

/** The run folder and `<home>/runs` must be real folders. */
function runFolders(paths: RunPaths): Promise<FileProblem | null> {
  return firstFolderProblem([paths.runs, paths.folder]);
}

async function loadFrom(paths: RunPaths, runId: string, opts: StoreOptions = {}): Promise<StoreResult<LoadedRun>> {
  const folders = await runFolders(paths);
  if (folders !== null) {
    if (folders.code === 'missing') return storeFail('missing', `There is no run ${runId} (${paths.folder} does not exist).`);
    return problem(folders);
  }
  const record = await readDocument(paths.plan, PlanRecordSchema, limits(opts).plan, `plan.json of run ${runId}`);
  if (!record.ok) return record;
  const planIssues = planRecordProblems(record.value, runId);
  if (planIssues.length > 0) return storeFail('inconsistent', `plan.json of run ${runId} can't be trusted: ${planIssues.join(' ')}`);
  const state = await readDocument(paths.state, RunStateSchema, limits(opts).state, `state.json of run ${runId}`);
  if (!state.ok) return state;
  const stateIssues = stateProblems(record.value, state.value);
  if (stateIssues.length > 0) return storeFail('inconsistent', `state.json of run ${runId} doesn't fit its plan: ${stateIssues.join(' ')}`);
  return { ok: true, value: { runId, folder: paths.folder, record: record.value, state: state.value } };
}

/** Reads and checks a run's plan and state, without changing anything. */
export async function loadRun(home: string, runId: string, opts: StoreOptions = {}): Promise<StoreResult<LoadedRun>> {
  if (!isValidRunId(runId)) return badRunId(runId);
  return loadFrom(runPaths(home, runId), runId, opts);
}

/** Creates a new run folder for an approved plan and opens it for writing. */
export async function createRun(home: string, input: NewRunInput, opts: StoreOptions = {}): Promise<StoreResult<RunStore>> {
  const { runId, ready } = input;
  if (!isValidRunId(runId)) return badRunId(runId);
  const rounds = input.review?.maxRevisionRounds;
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 0 || rounds > MAX_ROUND)) {
    return storeFail('invalid', `maxRevisionRounds must be a whole number from 0 to ${MAX_ROUND}, not ${rounds}.`);
  }
  const now = opts.now ?? (() => new Date());
  const record = newPlanRecord(input, now());
  const planIssues = planRecordProblems(record, runId);
  if (planIssues.length > 0) return storeFail('invalid', `Refused to store the plan: ${planIssues.join(' ')}`);

  try {
    await mkdir(home, { recursive: true });
  } catch (error) {
    return storeFail('io', `Could not create Orchestra's folder ${home}: ${errorText(error)}`);
  }
  const paths = runPaths(home, runId);
  const ci = input.caseInsensitivePaths;
  const repoRoot = canonicalPath(ready.repoRoot) ?? ready.repoRoot;
  const commonDir = canonicalPath(ready.gitCommonDir) ?? ready.gitCommonDir;
  if (isInsidePath(paths.runs, repoRoot, ci) || isInsidePath(repoRoot, paths.runs, ci) || isInsidePath(paths.runs, commonDir, ci)) {
    return storeFail(
      'home-overlaps-repo',
      `Orchestra's folder (${home}) overlaps the repository (${ready.repoRoot}). Set ORCHESTRA_HOME to a folder outside the project.`,
    );
  }
  const runs = await ensureRealFolder(paths.runs);
  if (runs !== null) return problem(runs);
  if (!claim(paths)) return busy(runId);
  const created = await buildRun(home, paths, record, opts, now);
  if (!created.ok) release(paths);
  return created;
}

async function buildRun(home: string, paths: RunPaths, record: PlanRecord, opts: StoreOptions, now: () => Date): Promise<StoreResult<RunStore>> {
  const { runId } = record;
  if ((await folderProblem(paths.folder))?.code !== 'missing') {
    return storeFail('exists', `${paths.folder} already exists. Orchestra never reuses a run folder; pick a new run id.`);
  }

  // Built under a temporary name, then renamed into place: a run folder is complete or absent.
  const tempLeaf = tempName(runId);
  const temp = join(paths.runs, tempLeaf);
  const tempPaths = {
    plan: join(temp, RUN_FILES.plan),
    state: join(temp, RUN_FILES.state),
    log: join(temp, RUN_FILES.log),
    tasks: join(temp, TASKS_FOLDER),
  };
  const state = newRunState(record, now());
  const log = new LogWriter(tempPaths.log, { now });
  const firstLine = log.initialContent({ kind: 'run-created', planHash: record.planHash, targetBranch: record.plan.targetBranch, baseSha: record.plan.baseSha, tasks: record.plan.tasks.map((t) => t.id) });
  const built = await (async (): Promise<StoreResult> => {
    if (!firstLine.ok) return firstLine;
    const folder = await ensureRealFolder(temp);
    if (folder !== null) return problem(folder);
    const atomic = atomicOptions(opts);
    const steps = [
      () => writeDocument(tempPaths.plan, record, PlanRecordSchema, limits(opts).plan, atomic),
      () => writeDocument(tempPaths.state, state, RunStateSchema, limits(opts).state, atomic),
      () => writeFileAtomic(tempPaths.log, firstLine.value, atomic),
    ];
    for (const step of steps) {
      const result = await step();
      if (!result.ok) return result;
    }
    const tasks = await ensureRealFolder(tempPaths.tasks);
    if (tasks !== null) return problem(tasks);
    try {
      await withRetry(() => rename(temp, paths.folder));
    } catch (error) {
      return storeFail('io', `Could not move the new run folder into place at ${paths.folder}: ${errorText(error)}`);
    }
    await syncFolder(paths.runs);
    return { ok: true, value: undefined };
  })();
  if (!built.ok) {
    await removeTree(temp, { expected: join(canonicalPath(paths.runs) ?? paths.runs, tempLeaf) }).catch(() => undefined);
    return built;
  }
  return { ok: true, value: new RunStore(home, paths, { runId, folder: paths.folder, record, state }, opts) };
}

/** Claims a run folder for writing in this process; false when it is already claimed. */
function claim(paths: RunPaths): boolean {
  const key = folderKey(paths.folder);
  if (openFolders.has(key)) return false;
  openFolders.add(key);
  return true;
}

function release(paths: RunPaths): void {
  openFolders.delete(folderKey(paths.folder));
}

function busy<T>(runId: string): StoreResult<T> {
  return storeFail('busy', `Run ${runId} is already open in this process.`);
}

/**
 * Opens an existing run for writing, for the conductor after a restart: checks everything, removes leftover
 * temporary files and a partial last log line. `notes` says what was cleaned up.
 */
export async function openRun(home: string, runId: string, opts: StoreOptions = {}): Promise<StoreResult<{ store: RunStore; notes: string[] }>> {
  if (!isValidRunId(runId)) return badRunId(runId);
  const paths = runPaths(home, runId);
  // Claimed before any slow work, so two opens at the same time can't both clean up and write.
  if (!claim(paths)) return busy(runId);
  const opened = await reopen(home, paths, runId, opts);
  if (!opened.ok) release(paths);
  return opened;
}

async function reopen(home: string, paths: RunPaths, runId: string, opts: StoreOptions): Promise<StoreResult<{ store: RunStore; notes: string[] }>> {
  const loaded = await loadFrom(paths, runId, opts);
  if (!loaded.ok) return loaded;

  const notes: string[] = [];
  const folders = [paths.folder];
  const tasks = await folderProblem(paths.tasks);
  if (tasks === null) {
    for (const task of loaded.value.record.plan.tasks) {
      const folder = taskFolder(paths, task.id);
      const found = await folderProblem(folder);
      if (found === null) folders.push(folder);
      else if (found.code !== 'missing') return problem(found);
    }
  } else if (tasks.code !== 'missing') {
    return problem(tasks);
  }
  for (const folder of folders) {
    const cleaned = await removeTempEntries(folder);
    if (cleaned.removed > 0) notes.push(`Removed ${cleaned.removed} leftover temporary file(s) in ${folder}.`);
    notes.push(...cleaned.problems);
  }
  const log = new LogWriter(paths.log, { maxBytes: opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, folders: () => runFolders(paths), atomic: atomicOptions(opts), ...(opts.now ? { now: opts.now } : {}) });
  const repaired = await log.repair();
  if (!repaired.ok) return repaired;
  if (repaired.value > 0) notes.push(`Removed a partial last line (${repaired.value} bytes) from the log, left by an interrupted write.`);

  return { ok: true, value: { store: new RunStore(home, paths, loaded.value, opts), notes } };
}

/** The writer for one open run. Get one from createRun or openRun. */
export class RunStore {
  readonly runId: string;
  readonly record: PlanRecord;
  private current: RunState;
  private readonly log: LogWriter;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly outputs = new Set<CappedOutput>();
  private closed = false;

  /** @internal Use createRun or openRun. */
  constructor(
    readonly home: string,
    readonly paths: RunPaths,
    run: LoadedRun,
    private readonly opts: StoreOptions,
  ) {
    this.runId = run.runId;
    this.record = deepFreeze(run.record);
    this.current = deepFreeze(run.state);
    this.now = opts.now ?? (() => new Date());
    this.log = new LogWriter(paths.log, {
      maxBytes: opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
      now: this.now,
      folders: () => runFolders(paths),
      atomic: atomicOptions(opts),
    });
  }

  get folder(): string {
    return this.paths.folder;
  }

  /** The state as last saved. Frozen: change it through update(). */
  get state(): RunState {
    return this.current;
  }

  /**
   * Refuses further writes, waits for the queued ones, closes any output file still open, then releases the
   * run so it can be opened again (in this process).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    await Promise.all([...this.outputs].map((output) => output.close()));
    this.outputs.clear();
    release(this.paths);
  }

  /** Runs `job` after every earlier write, one at a time. Writes asked for before close() still happen. */
  private enqueue<T>(job: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
    if (this.closed) return Promise.resolve(storeFail('closed', `Run ${this.runId} was closed.`));
    const guarded = async (): Promise<StoreResult<T>> => {
      try {
        return await job();
      } catch (error) {
        return storeFail('io', `Writing run ${this.runId} failed: ${errorText(error)}`);
      }
    };
    const next = this.queue.then(guarded, guarded);
    this.queue = next;
    return next;
  }

  /**
   * Replaces the state with `change(state)`, stamped with the time. Refused, and nothing written, when the
   * new state is not valid or doesn't fit the plan (consistency.ts).
   */
  update(change: (state: RunState) => RunState): Promise<StoreResult<RunState>> {
    return this.enqueue(async () => {
      let next: RunState;
      try {
        next = { ...change(this.current), updatedAt: this.now().toISOString() };
      } catch (error) {
        return storeFail('invalid', `The state change failed: ${errorText(error)}`);
      }
      const parsed = RunStateSchema.safeParse(next);
      if (!parsed.success) return storeFail('invalid', `Refused to save the run's state: ${issueText(parsed.error)}`);
      const issues = stateProblems(this.record, parsed.data);
      if (issues.length > 0) return storeFail('inconsistent', `Refused to save the run's state: ${issues.join(' ')}`);
      const folders = await runFolders(this.paths);
      if (folders !== null) return problem(folders);
      const written = await writeDocument(this.paths.state, parsed.data, RunStateSchema, limits(this.opts).state, atomicOptions(this.opts));
      if (!written.ok) return written;
      this.current = deepFreeze(parsed.data);
      return { ok: true, value: this.current };
    });
  }

  /** Changes one task's state. */
  updateTask(taskId: string, change: TaskChange): Promise<StoreResult<RunState>> {
    return this.update((state) => withTask(state, taskId, change));
  }

  /** Appends a decision to the log (entries.ts builds them from the steps' results). */
  appendLog(entry: LogEntry): Promise<StoreResult> {
    return this.enqueue(() => this.log.append(entry));
  }

  /** The task's folder, created if needed, after checking every folder on the way. */
  private async taskFolderFor(taskId: string): Promise<StoreResult<string>> {
    if (!isValidTaskId(taskId) || !this.record.plan.tasks.some((t) => t.id === taskId)) {
      return storeFail('bad-name', `Run ${this.runId} has no task "${taskId}".`);
    }
    const folders = await runFolders(this.paths);
    if (folders !== null) return problem(folders);
    const tasks = await ensureRealFolder(this.paths.tasks);
    if (tasks !== null) return problem(tasks);
    const folder = taskFolder(this.paths, taskId);
    const own = await ensureRealFolder(folder);
    return own === null ? { ok: true, value: folder } : problem(own);
  }

  private roundCheck<T>(taskId: string, round: number): StoreResult<T> | null {
    if (!isValidRound(round)) return storeFail('bad-name', `${round} is not a valid round for task "${taskId}".`);
    return null;
  }

  /** Saves a task's gate for one round: each acceptance command with its output, integrity and scope. */
  saveGate(taskId: string, round: number, gate: GateResult): Promise<StoreResult> {
    return this.enqueue(async () => {
      const bad = this.roundCheck<undefined>(taskId, round);
      if (bad !== null) return bad;
      const folder = await this.taskFolderFor(taskId);
      if (!folder.ok) return folder;
      const value = { schemaVersion: STORE_SCHEMA_VERSION, runId: this.runId, taskId, round, savedAt: this.now().toISOString(), gate: storedGate(gate) };
      const max = limits(this.opts).gate;
      return writeDocument(roundFile(this.paths, taskId, 'gate', round), fitOutputs(value, max), GateRecordSchema, max, atomicOptions(this.opts));
    });
  }

  /** Saves the last finalize report. */
  saveFinalizeReport(report: FinalizeReport): Promise<StoreResult> {
    return this.enqueue(async () => {
      if (report.runId !== this.runId) return storeFail('invalid', `The finalize report is for run "${report.runId}", not ${this.runId}.`);
      const folders = await runFolders(this.paths);
      if (folders !== null) return problem(folders);
      const stored = { ...report, acceptance: report.acceptance === null ? null : { ...report.acceptance, gate: report.acceptance.gate === null ? null : storedGate(report.acceptance.gate) } };
      const value = { schemaVersion: STORE_SCHEMA_VERSION, runId: this.runId, savedAt: this.now().toISOString(), report: stored };
      const max = limits(this.opts).finalize;
      return writeDocument(this.paths.finalize, fitOutputs(value, max), FinalizeRecordSchema, max, atomicOptions(this.opts));
    });
  }

  /**
   * Saves the diff of a task's commit for one round (`from`: the commit it started from or was revised from).
   * Git runs on the repository with renames, external diff programs and text conversion off, so the user's
   * git config can't run a program. Large diffs keep their start (the list of changed files comes first),
   * with a marker line at the end.
   */
  saveDiff(ctx: RepoContext, taskId: string, round: number, from: string, to: string): Promise<StoreResult<{ bytes: number; truncated: boolean }>> {
    return this.enqueue(async () => {
      const bad = this.roundCheck<{ bytes: number; truncated: boolean }>(taskId, round);
      if (bad !== null) return bad;
      if (!FULL_SHA.test(from) || !FULL_SHA.test(to)) return storeFail('invalid', `"${from}" and "${to}" must be full commit ids.`);
      if (!samePath(ctx.commonDir, this.record.gitCommonDir, this.record.caseInsensitivePaths)) {
        return storeFail('invalid', `The repository ${ctx.commonDir} is not this run's (${this.record.gitCommonDir}).`);
      }
      const folder = await this.taskFolderFor(taskId);
      if (!folder.ok) return folder;
      const maxBytes = this.opts.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
      const diff = await repoGitRaw(
        ctx,
        ['diff-tree', '-r', '-p', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', from, to],
        { maxStdoutBytes: maxBytes, timeoutMs: LONG_GIT_TIMEOUT_MS },
      );
      const truncated = diff.truncated === true;
      if (diff.code !== 0 && !truncated) return storeFail('git-failed', `git diff-tree failed: ${describeGitFailure(diff)}`);
      const content = truncated ? Buffer.concat([diff.stdout, Buffer.from(`\n[... diff cut at ${maxBytes} bytes by Orchestra ...]\n`)]) : diff.stdout;
      const written = await writeFileAtomic(roundFile(this.paths, taskId, 'diff', round), content, atomicOptions(this.opts));
      return written.ok ? { ok: true, value: { bytes: content.length, truncated } } : written;
    });
  }

  /**
   * Saves the brief a task's worker gets in one round, as given (step 11). The worker runner saves it before the
   * start, so the run folder shows what each worker was told. A brief over the limit is refused, not cut.
   */
  saveBrief(taskId: string, round: number, brief: string): Promise<StoreResult<{ bytes: number }>> {
    return this.enqueue(async () => {
      const bad = this.roundCheck<{ bytes: number }>(taskId, round);
      if (bad !== null) return bad;
      const folder = await this.taskFolderFor(taskId);
      if (!folder.ok) return folder;
      const maxBytes = this.opts.maxBriefBytes ?? DEFAULT_MAX_BRIEF_BYTES;
      const written = await writeFileAtomic(roundFile(this.paths, taskId, 'brief', round), brief, { ...atomicOptions(this.opts), maxBytes });
      return written.ok ? { ok: true, value: { bytes: Buffer.byteLength(brief) } } : written;
    });
  }

  /**
   * Starts a capped file for a worker's output in one round (step 10 writes to it as the worker prints). A
   * file left by an earlier attempt at the same round is replaced.
   */
  async openOutput(taskId: string, round: number, stream: OutputStream): Promise<StoreResult<CappedOutput>> {
    if (this.closed) return storeFail('closed', `Run ${this.runId} was closed.`);
    if (!isOutputStream(stream)) return storeFail('bad-name', `"${String(stream)}" is not an output stream (stdout or stderr).`);
    const bad = this.roundCheck<CappedOutput>(taskId, round);
    if (bad !== null) return bad;
    const folder = await this.taskFolderFor(taskId);
    if (!folder.ok) return folder;
    const chain = [this.paths.runs, this.paths.folder, this.paths.tasks, folder.value];
    const created = await CappedOutput.create(roundFile(this.paths, taskId, stream, round), {
      maxBytes: this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      folders: () => firstFolderProblem(chain),
    });
    if (!created.ok) return problem(created.problem);
    this.outputs.add(created.value);
    created.value.onClose(() => this.outputs.delete(created.value));
    return created;
  }
}

/** A GateResult as saved: without the integrity baseline (the user's refs and config files, fingerprinted). */
function storedGate(gate: GateResult): StoredGate {
  return { ...gate, integrity: { ok: gate.integrity.ok, violations: [...gate.integrity.violations] } } as StoredGate;
}

// ---------------------------------------------------------------------------------------------------------
// Reading a run's other files. A file not written yet (no finalize check, a round not run) gives null.

async function readOptional<T>(
  home: string,
  runId: string,
  read: (paths: RunPaths) => Promise<StoreResult<T>>,
): Promise<StoreResult<T | null>> {
  if (!isValidRunId(runId)) return badRunId(runId);
  const paths = runPaths(home, runId);
  const folders = await runFolders(paths);
  if (folders !== null) return problem(folders);
  const result = await read(paths);
  if (!result.ok && result.problem.code === 'missing') return { ok: true, value: null };
  return result;
}

function taskFileCheck<T>(runId: string, taskId: string, round: number): StoreResult<T> | null {
  if (!isValidTaskId(taskId)) return storeFail('bad-name', `"${taskId}" is not a valid task id.`);
  if (!isValidRound(round)) return storeFail('bad-name', `${round} is not a valid round.`);
  return null;
}

async function taskFolders(paths: RunPaths, taskId: string): Promise<FileProblem | null> {
  return firstFolderProblem([paths.tasks, taskFolder(paths, taskId)]);
}

/** The run's decision log. Every run has one, so a missing log is a problem, not "nothing yet". */
export async function readRunLog(home: string, runId: string, opts: StoreOptions = {}): Promise<StoreResult<ParsedLog>> {
  if (!isValidRunId(runId)) return badRunId(runId);
  const paths = runPaths(home, runId);
  const folders = await runFolders(paths);
  if (folders !== null) return problem(folders);
  const read = await readLog(paths.log, opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES);
  return read.ok ? read : problem(read.problem);
}

/** The last finalize report, as saved: without the integrity baseline, outputs cut if it was too large. */
export function readFinalizeReport(home: string, runId: string, opts: StoreOptions = {}): Promise<StoreResult<StoredFinalizeReport | null>> {
  return readOptional(home, runId, async (paths) => {
    const read = await readDocument(paths.finalize, FinalizeRecordSchema, limits(opts).finalize, `finalize.json of run ${runId}`);
    if (!read.ok) return read;
    if (read.value.runId !== runId) return storeFail('inconsistent', `finalize.json of run ${runId} belongs to run "${read.value.runId}".`);
    return { ok: true, value: read.value.report };
  });
}

export function readGate(home: string, runId: string, taskId: string, round: number, opts: StoreOptions = {}): Promise<StoreResult<StoredGate | null>> {
  return readOptional(home, runId, async (paths) => {
    const bad = taskFileCheck<StoredGate>(runId, taskId, round);
    if (bad !== null) return bad;
    const folders = await taskFolders(paths, taskId);
    if (folders !== null) return problem(folders);
    const what = `The gate of task "${taskId}", round ${round}, in run ${runId}`;
    const read = await readFileCapped(roundFile(paths, taskId, 'gate', round), limits(opts).gate);
    if (!read.ok) return read;
    const parsed = parseDocument(read.value, GateRecordSchema, what);
    if (!parsed.ok) return parsed;
    if (parsed.value.runId !== runId || parsed.value.taskId !== taskId || parsed.value.round !== round) {
      return storeFail('inconsistent', `${what} is the file of another run, task or round.`);
    }
    return { ok: true, value: parsed.value.gate };
  });
}

export function readDiff(home: string, runId: string, taskId: string, round: number, opts: StoreOptions = {}): Promise<StoreResult<{ text: string; truncated: boolean } | null>> {
  return readOptional(home, runId, async (paths) => {
    const bad = taskFileCheck<{ text: string; truncated: boolean }>(runId, taskId, round);
    if (bad !== null) return bad;
    const folders = await taskFolders(paths, taskId);
    if (folders !== null) return problem(folders);
    const read = await readFileCapped(roundFile(paths, taskId, 'diff', round), (opts.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES) + 200);
    if (!read.ok) return read;
    const text = read.value.toString('utf8');
    return { ok: true, value: { text, truncated: DIFF_MARKER.test(text) } };
  });
}

export function readBrief(home: string, runId: string, taskId: string, round: number, opts: StoreOptions = {}): Promise<StoreResult<string | null>> {
  return readOptional(home, runId, async (paths) => {
    const bad = taskFileCheck<string>(runId, taskId, round);
    if (bad !== null) return bad;
    const folders = await taskFolders(paths, taskId);
    if (folders !== null) return problem(folders);
    const read = await readFileCapped(roundFile(paths, taskId, 'brief', round), opts.maxBriefBytes ?? DEFAULT_MAX_BRIEF_BYTES);
    return read.ok ? { ok: true, value: read.value.toString('utf8') } : read;
  });
}

export function readOutput(
  home: string,
  runId: string,
  taskId: string,
  round: number,
  stream: OutputStream,
  opts: StoreOptions = {},
): Promise<StoreResult<StoredOutput | null>> {
  return readOptional(home, runId, async (paths) => {
    const bad = taskFileCheck<StoredOutput>(runId, taskId, round);
    if (bad !== null) return bad;
    if (!isOutputStream(stream)) return storeFail('bad-name', `"${String(stream)}" is not an output stream (stdout or stderr).`);
    const folders = await taskFolders(paths, taskId);
    if (folders !== null) return problem(folders);
    const read = await readCappedOutput(roundFile(paths, taskId, stream, round), opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    return read.ok ? read : problem(read.problem);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Listing and removing runs.

export interface OddEntry {
  readonly name: string;
  readonly reason: string;
}

export interface RunList {
  /** Valid run folders, oldest first (run ids sort by start time). */
  readonly runs: string[];
  /** Anything else in `<home>/runs`, with why it isn't a run. */
  readonly odd: OddEntry[];
  /** Temporary files and folders left by an interrupted write or run creation (see removeLeftovers). */
  readonly leftovers: string[];
}

export async function listRuns(home: string): Promise<StoreResult<RunList>> {
  const runs = runsFolder(home);
  const found = await folderProblem(runs);
  if (found?.code === 'missing') return { ok: true, value: { runs: [], odd: [], leftovers: [] } };
  if (found !== null) return problem(found);
  let names: string[];
  try {
    names = await readdir(runs);
  } catch (error) {
    return storeFail('io', `Could not list ${runs}: ${errorText(error)}`);
  }
  const list: RunList = { runs: [], odd: [], leftovers: [] };
  for (const name of names.sort()) {
    if (isTempName(name)) {
      list.leftovers.push(name);
      continue;
    }
    if (!isValidRunId(name)) {
      list.odd.push({ name, reason: 'not a valid run id' });
      continue;
    }
    const kind = await folderProblem(join(runs, name));
    if (kind === null) list.runs.push(name);
    else list.odd.push({ name, reason: kind.code === 'link' ? 'a link, not a real folder' : 'not a folder' });
  }
  return { ok: true, value: list };
}

/** Removes temporary files and folders an interrupted write or run creation left in `<home>/runs`. */
export async function removeLeftovers(home: string): Promise<{ removed: number; problems: string[] }> {
  const runs = runsFolder(home);
  const found = await folderProblem(runs);
  if (found?.code === 'missing') return { removed: 0, problems: [] };
  if (found !== null) return { removed: 0, problems: [found.message] };
  return removeTempEntries(runs);
}

/**
 * Deletes a run folder, never through a link: a link in its place is removed itself. The run's worktrees
 * and branches are the worktree manager's to remove. Refused while the run is open in this process.
 */
export async function removeRun(home: string, runId: string): Promise<StoreResult<{ removed: boolean; notes: string[] }>> {
  if (!isValidRunId(runId)) return badRunId(runId);
  const paths = runPaths(home, runId);
  if (openFolders.has(folderKey(paths.folder))) return storeFail('busy', `Run ${runId} is open; close it first.`);
  const runs = await folderProblem(paths.runs);
  if (runs?.code === 'missing') return { ok: true, value: { removed: false, notes: [] } };
  if (runs !== null) return problem(runs);
  const notes: string[] = [];
  try {
    const info = await lstat(paths.folder).catch(() => null);
    if (info === null) return { ok: true, value: { removed: false, notes } };
    if (info.isSymbolicLink()) notes.push(`${paths.folder} was a link; only the link was removed, not what it pointed to.`);
    else if (!info.isDirectory()) notes.push(`${paths.folder} was a file, not a folder; it was removed.`);
    await removeTree(paths.folder, { expected: paths.folder });
  } catch (error) {
    return storeFail('io', `Could not remove ${paths.folder}: ${errorText(error)}`);
  }
  return { ok: true, value: { removed: true, notes } };
}
