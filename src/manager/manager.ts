/**
 * The run manager (step 12a): the conductor's code that drives each run through the recipe in docs/HANDOFF.md ("How
 * the steps fit together"), with no AI in it. It holds the conductor's lock (lock.ts), so it is the only writer of
 * every run in its Orchestra home.
 *
 * A run:
 * 1. prepareRun: engines detected, the plan validated and checked against the repository, the rules manifest built,
 *    the files rule files import reserved exactly, the plan validated again (prepare.ts).
 * 2. The user approves the start through the Approver (step 13's dialog; approval.ts). Nothing else can approve.
 * 3. createRun, then the integration branch at the base commit.
 * 4. Each task whose dependencies are merged starts when a worker place is free (DEFAULT_LIMITS.maxParallelWorkers):
 *    its worktree, then per round: the engine checked again, an integrity baseline and the agents' config folders,
 *    the brief, the worker, the integrity and agent-config checks, the scope check and the conductor's commit, the
 *    worker's result kept and compared with the real diff, then the acceptance gate. The task then waits for the
 *    orchestrator's review (submitReview): accept, revise (a new round in a fresh worktree) or reject.
 * 5. Accepted tasks merge one at a time, in dependency order. A refused merge fails the task (Orchestra never resolves
 *    a conflict); the tasks that depend on it are cancelled.
 * 6. When every task has finished, the finalize checks run on what was merged and their report is saved. Finalizing
 *    itself (moving the user's branch) is step 13, after the user's approval.
 *
 * Every state change is saved before its log entry: the state is what a restart carries on from, the log is the
 * history. Git steps come before the state write that records them, so a crash can leave git one step ahead; open()
 * compares every running run with git and records what git shows, once it checked it as the step itself would have
 * (git-state.ts). Workers that outlived a crashed conductor are found by their recorded process and stopped, only
 * after checking it is that process (os/process-identity.ts).
 *
 * Decided here (docs/HANDOFF.md, assumed for now): a round that a crash interrupted after its worker started is not
 * carried on, and the task fails: its checks compare with what was there before the worker started, and that baseline
 * is gone with the old process, so carrying on from a new one would let a worker (or its tests) get past the checks by
 * stopping Orchestra. A task whose round had not started its worker yet simply starts it. Acceptance commands run
 * again on the combined result only at the finalize checks, unless checkAfterEachMerge is set.
 *
 * Worktrees and integrity baselines of one repository are never made or read at the same time (repoLock): a half-made
 * worktree must not be read as one of the user's.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAcceptanceGate, type Exclusive, type GateOptions, type GateResult } from '../accept/gate.js';
import type { RunOptions } from '../accept/run.js';
import { renderBrief, type RevisionRequest, type UpstreamResult } from '../brief/render.js';
import { parseWorkerResult } from '../brief/result.js';
import { DEFAULT_LIMITS } from '../config/defaults.js';
import { homeLayout } from '../config/home.js';
import { compareAgentConfig, snapshotAgentConfig } from '../engines/agent-config.js';
import { detectEngines, type DetectOptions, type Detection } from '../engines/detect.js';
import { DEFAULT_WORKER_TIMEOUT_MS, runWorker, type WorkerOutcome } from '../engines/worker.js';
import { clearFinalizeCheck, finalizeChecks } from '../finalize/check.js';
import { checkCombined } from '../finalize/combined.js';
import type { RepoContext } from '../git/context.js';
import { readCommit } from '../git/objects.js';
import { checkIntegrity, takeBaseline, type IntegrityBaseline, type IntegrityOptions } from '../integrity/check.js';
import { integrationBranch, mergeTask, readyToMerge, removeIntegration, startIntegration } from '../merge/integration.js';
import { stopVerifiedProcess } from '../os/process-identity.js';
import type { EngineName, Task } from '../plan/schema.js';
import { canonicalPath } from '../repo/canonical.js';
import { newTaskReview, recordGate, recordReview, startRevision, type GateSummary, type TaskReview } from '../review/state.js';
import { rulesForTask } from '../rules/applicable.js';
import { buildRulesManifest, type RulesManifest } from '../rules/manifest.js';
import { branchRef, newRunId, taskBranch } from '../run/names.js';
import { checkScope, commitTask, taskCommitMessage } from '../scope/check.js';
import type { ScopeRules } from '../scope/rules.js';
import { diffTrees } from '../scope/trees.js';
import {
  agentConfigEntry,
  clipText,
  commitEntry,
  finalizeEntry,
  gateEntry,
  integrityEntry,
  mergeEntry,
  noteEntry,
  reviewEntry,
  scopeEntry,
} from '../store/entries.js';
import { createRun, listRuns, loadRun, openRun, readFinalizeReport, readResult, type RunStore } from '../store/run.js';
import type { LogEntry, RunState, TaskState, TaskStatus } from '../store/schema.js';
import { contextOf, finalizeInputOf, reviewSettingsOf, storedReview, taskState, withTask } from '../store/state.js';
import {
  createTaskWorktree,
  removeLeftoverCheckWorktree,
  removeLeftoverTaskWorktree,
  removeTaskWorktree,
  reopenTaskWorktree,
  startCommitFor,
  type TaskWorktree,
} from '../worktree/manager.js';
import { askApproval, type Approver } from './approval.js';
import { claimsOf, refState, verifyMergeCommit, verifyTaskCommit } from './git-state.js';
import type { HeldLock } from './lock.js';
import { prepareRun, scopeRulesFor, startApprovalText, type PlanProblem } from './prepare.js';
import { isUnfinished, summarize, type FinalizeSummary, type RunSummary } from './summary.js';
import { KeyedMutex, Mutex, Semaphore } from './sync.js';

export interface ManagerLimits {
  readonly maxParallelWorkers: number;
  readonly workerTimeoutMs: number;
  /** Per acceptance command. */
  readonly commandTimeoutMs: number;
}

export const DEFAULT_MANAGER_LIMITS: ManagerLimits = {
  maxParallelWorkers: DEFAULT_LIMITS.maxParallelWorkers,
  workerTimeoutMs: DEFAULT_WORKER_TIMEOUT_MS,
  commandTimeoutMs: DEFAULT_LIMITS.acceptanceCommandTimeoutMinutes * 60_000,
};

/** Git steps a crash can separate from the state write that records them (for tests that simulate one). */
export type GitStep = 'integration' | 'worktree' | 'commit' | 'merge';

export interface ManagerOptions {
  /** Orchestra's home. */
  readonly home: string;
  /** The conductor's lock for this home (lock.ts), held by this process. */
  readonly lock: HeldLock;
  readonly approver: Approver;
  /** The user's home folder: personal rule files and the agents' config folders (os.homedir() by default). */
  readonly userHome?: string;
  /** The conductor's environment; workers and commands get filtered copies (process.env by default). */
  readonly env?: NodeJS.ProcessEnv;
  /** Absolute program paths for the engines (the user's config). */
  readonly programs?: Partial<Record<EngineName, string>>;
  /** More variable names workers and commands may get (the user's config). */
  readonly allowEnv?: readonly string[];
  /** Whether Claude workers keep their shell (PLAN §4 default: no). */
  readonly shell?: boolean;
  readonly limits?: Partial<ManagerLimits>;
  /** Run the merged tasks' acceptance commands on the integration branch after every merge (default: no). */
  readonly checkAfterEachMerge?: boolean;
  readonly integrity?: IntegrityOptions;
  /** Engine detection (tests pass the real one with fake engines; default detectEngines). */
  readonly detect?: (opts: DetectOptions) => Promise<Detection>;
  /** Called right after each git step, before its state write (tests simulate a crash there). */
  readonly afterGitStep?: (step: GitStep, runId: string, taskId: string | null) => Promise<void> | void;
}

export type ManagerEvent = { readonly type: 'run'; readonly run: RunSummary } | { readonly type: 'log'; readonly runId: string; readonly entry: LogEntry };

export type StartOutcome =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly code: 'invalid-plan' | 'not-approved' | 'lock-lost' | 'store' | 'closed'; readonly message: string; readonly problems?: readonly PlanProblem[] };

export type ActionOutcome = { readonly ok: true; readonly notes?: readonly string[] } | { readonly ok: false; readonly code: string; readonly message: string };

const TERMINAL_FAILED: ReadonlySet<TaskStatus> = new Set(['rejected', 'failed', 'cancelled']);
/** Text kept in a task's reason. */
const MAX_REASON = 2000;

/** Everything the manager holds for one run while it drives it. */
class ActiveRun {
  /** Aborted when the run is cancelled: its workers and acceptance commands stop. */
  readonly abort = new AbortController();
  /** Aborted when the run is being discarded: its finalize checks stop too, and none start. */
  readonly discard = new AbortController();
  /** Decisions (read the state, decide, write) one at a time. */
  readonly serial = new Mutex();
  readonly merges = new Mutex();
  /** Tasks with work in progress (starting, a worker, checks, the gate). */
  readonly busy = new Set<string>();
  readonly worktrees = new Map<string, TaskWorktree>();
  readonly problems: string[] = [];
  readonly notes: string[] = [];
  readonly pipelines = new Set<Promise<void>>();
  finalize: FinalizeSummary | null = null;
  finalizing = false;
  pumping = false;
  pumpAgain = false;
  cancelled = false;
  claudeVersion: string | null = null;

  constructor(
    readonly store: RunStore,
    readonly ctx: RepoContext,
    public manifest: RulesManifest | null,
    public scopeRules: ScopeRules | null,
  ) {}

  get runId(): string {
    return this.store.runId;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reason(text: string): string {
  return clipText(text, MAX_REASON);
}

function firstMessages(items: readonly { readonly message: string }[], count = 3): string {
  const shown = items.slice(0, count).map((i) => i.message).join(' ');
  return items.length > count ? `${shown} (and ${items.length - count} more)` : shown;
}

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();
  /** Runs still going that could not be reopened after a restart, with why (shown, never driven). */
  private readonly unopened = new Map<string, string>();
  private readonly listeners = new Set<(event: ManagerEvent) => void>();
  private readonly repoLocks = new KeyedMutex();
  private readonly slots: Semaphore;
  private readonly limits: ManagerLimits;
  private readonly shutdown = new AbortController();
  private closing = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly userHome: string;

  private constructor(private readonly opts: ManagerOptions) {
    this.limits = { ...DEFAULT_MANAGER_LIMITS, ...opts.limits };
    this.slots = new Semaphore(this.limits.maxParallelWorkers);
    this.env = opts.env ?? process.env;
    this.userHome = opts.userHome ?? homedir();
  }

  /** Starts the manager: reopens every run still going and carries on from where git and the state say it is. */
  static async open(opts: ManagerOptions): Promise<RunManager> {
    const manager = new RunManager(opts);
    await manager.recoverAll();
    return manager;
  }

  // -------------------------------------------------------------------------------------------------------
  // Events and summaries

  /** Calls `listener` with every run summary change and log entry; returns the unsubscribe function. */
  subscribe(listener: (event: ManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's problem is its own.
      }
    }
  }

  private summaryOf(run: ActiveRun): RunSummary {
    return summarize(run.store.record, run.store.state, { finalize: run.finalize, problems: [...run.problems], notes: [...run.notes] });
  }

  private changed(run: ActiveRun): void {
    this.emit({ type: 'run', run: this.summaryOf(run) });
  }

  /** The summary of a run, open or finished; null when there is no such run (or it can't be read). */
  async status(runId: string): Promise<RunSummary | null> {
    const run = this.runs.get(runId);
    if (run !== undefined) return this.summaryOf(run);
    const loaded = await loadRun(this.opts.home, runId);
    if (!loaded.ok) return null;
    const report = await readFinalizeReport(this.opts.home, runId);
    const finalize = report.ok && report.value !== null ? finalizeSummary(report.value) : null;
    return summarize(loaded.value.record, loaded.value.state, { finalize, problems: [], notes: [] });
  }

  /**
   * Runs that could not be read or reopened when the manager started, with why. Orchestra doesn't drive them (and
   * can't stop their workers); the user looks at them, or removes them.
   */
  unreadableRuns(): ReadonlyArray<{ readonly runId: string; readonly problem: string }> {
    return [...this.unopened].map(([runId, problem]) => ({ runId, problem }));
  }

  /** Every run in the home, oldest first; runs that can't be read are left out (see unreadableRuns). */
  async list(): Promise<RunSummary[]> {
    const listed = await listRuns(this.opts.home);
    if (!listed.ok) return [];
    const summaries: RunSummary[] = [];
    for (const runId of listed.value.runs) {
      const summary = await this.status(runId);
      if (summary !== null) summaries.push(summary);
    }
    return summaries;
  }

  /** Waits until no work is in progress for the run (tests, and before a discard). */
  async settled(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    while (run.pipelines.size > 0) await Promise.allSettled([...run.pipelines]);
  }

  // -------------------------------------------------------------------------------------------------------
  // Store helpers: state first, then log

  private canWrite(run: ActiveRun): boolean {
    return !this.closing && run.problems.length === 0;
  }

  private pause(run: ActiveRun, problem: string): void {
    if (!run.problems.includes(problem)) run.problems.push(problem);
    this.changed(run);
  }

  private async save(run: ActiveRun, change: (state: RunState) => RunState): Promise<boolean> {
    if (this.closing) return false;
    const saved = await run.store.update(change);
    if (!saved.ok) {
      this.pause(run, `The run's state could not be saved: ${saved.problem.message}`);
      return false;
    }
    this.changed(run);
    return true;
  }

  private async log(run: ActiveRun, entry: LogEntry): Promise<void> {
    if (this.closing) return;
    const appended = await run.store.appendLog(entry);
    if (!appended.ok) {
      const note = `The log could not be written: ${appended.problem.message}`;
      if (!run.notes.includes(note)) run.notes.push(note);
    }
    this.emit({ type: 'log', runId: run.runId, entry });
  }

  /** Changes a task's status (and anything else), then logs the status. */
  private async setStatus(run: ActiveRun, taskId: string, status: TaskStatus, why: string | null, change: Partial<TaskState> = {}): Promise<boolean> {
    const text = why === null ? null : reason(why);
    if (!(await this.save(run, (s) => withTask(s, taskId, { ...change, status, reason: text })))) return false;
    await this.log(run, { kind: 'task-status', task: taskId, status, reason: text });
    return true;
  }

  private async fail(run: ActiveRun, taskId: string, why: string): Promise<void> {
    if (!this.canWrite(run)) return;
    const current = taskState(run.store.state, taskId);
    if (current === null || !isUnfinished(current.status)) return;
    await this.setStatus(run, taskId, run.cancelled ? 'cancelled' : 'failed', run.cancelled ? 'The run was cancelled.' : why);
  }

  private async hook(step: GitStep, run: ActiveRun, taskId: string | null): Promise<void> {
    if (this.opts.afterGitStep !== undefined) await this.opts.afterGitStep(step, run.runId, taskId);
  }

  /** Runs `work` while no worktree of the run's repository is being made or removed, and no baseline is read. */
  private repoLock<T>(run: ActiveRun, work: () => Promise<T>): Promise<T> {
    const key = (canonicalPath(run.ctx.commonDir) ?? run.ctx.commonDir).normalize('NFC');
    return this.repoLocks.run(run.ctx.caseInsensitivePaths ? key.toLowerCase() : key, work);
  }

  private exclusive(run: ActiveRun): Exclusive {
    return (work) => this.repoLock(run, work);
  }

  private commandOptions(): RunOptions {
    return { env: this.env, timeoutMs: this.limits.commandTimeoutMs, ...(this.opts.allowEnv !== undefined ? { allow: this.opts.allowEnv } : {}) };
  }

  /** For a task's gate: its commands stop when the run is cancelled or Orchestra closes. */
  private gateOptions(run: ActiveRun): GateOptions {
    const signal = AbortSignal.any([run.abort.signal, this.shutdown.signal]);
    return { run: { ...this.commandOptions(), signal }, exclusive: this.exclusive(run), ...(this.opts.integrity !== undefined ? { integrity: this.opts.integrity } : {}) };
  }

  /** For the finalize checks: they still run after a cancel (on what was merged), not after a discard or close. */
  private finalizeOptions(run: ActiveRun): GateOptions {
    const signal = AbortSignal.any([run.discard.signal, this.shutdown.signal]);
    return { run: { ...this.commandOptions(), signal }, exclusive: this.exclusive(run), ...(this.opts.integrity !== undefined ? { integrity: this.opts.integrity } : {}) };
  }

  private detect(engines?: readonly EngineName[]): Promise<Detection> {
    return (this.opts.detect ?? detectEngines)({
      env: this.env,
      ...(engines !== undefined ? { engines } : {}),
      ...(this.opts.programs !== undefined ? { programs: this.opts.programs } : {}),
      ...(this.opts.allowEnv !== undefined ? { allowEnv: this.opts.allowEnv } : {}),
    });
  }

  /**
   * Keeps track of a piece of work for the run, which never throws out of here. When it ends, the run is moved along
   * (pump), unless the work was the pump itself.
   */
  private track(run: ActiveRun, taskId: string | null, work: () => Promise<void>, repump = true): void {
    const promise = (async () => {
      try {
        await work();
      } catch (error) {
        if (taskId !== null) await this.fail(run, taskId, `Orchestra stopped this task after an unexpected error: ${errorText(error)}`).catch(() => undefined);
        else this.pause(run, `Unexpected error: ${errorText(error)}`);
      }
    })();
    run.pipelines.add(promise);
    void promise.finally(() => {
      run.pipelines.delete(promise);
      if (repump && !this.closing) this.pump(run);
    });
  }

  /**
   * Moves the run along: starts tasks, merges accepted ones, runs the finalize checks when all are done. One pump
   * runs at a time per run; a pump asked for meanwhile makes the running one go round once more.
   */
  private pump(run: ActiveRun): void {
    if (this.closing || run.problems.length > 0) return;
    if (run.pumping) {
      run.pumpAgain = true;
      return;
    }
    run.pumping = true;
    this.track(
      run,
      null,
      async () => {
        try {
          do {
            run.pumpAgain = false;
            await this.startReady(run);
            // A merge (or a refused one) can let other tasks start or be cancelled: go round again.
            if (await this.mergeReady(run)) run.pumpAgain = true;
            await this.maybeFinalize(run);
          } while (run.pumpAgain && !this.closing && run.problems.length === 0);
        } finally {
          run.pumping = false;
        }
      },
      false,
    );
  }

  // -------------------------------------------------------------------------------------------------------
  // Starting a run

  /**
   * Checks a plan, asks the user to approve it, and starts the run. The approval is bound to the plan's hash.
   * Nothing is written before the user approves.
   */
  async startRun(plan: unknown): Promise<StartOutcome> {
    if (this.closing) return { ok: false, code: 'closed', message: 'The run manager is closing.' };
    const prepared = await prepareRun(plan, {
      home: this.opts.home,
      userHome: this.userHome,
      env: this.env,
      ...(this.opts.programs !== undefined ? { programs: this.opts.programs } : {}),
      ...(this.opts.allowEnv !== undefined ? { allowEnv: this.opts.allowEnv } : {}),
      ...(this.opts.detect !== undefined ? { detect: this.opts.detect } : {}),
    });
    if (!prepared.ok) return { ok: false, code: 'invalid-plan', message: firstMessages(prepared.problems), problems: prepared.problems };
    const { ready, ctx, manifest, detection, scopeRules } = prepared.prepared;
    const runId = newRunId();
    const refused = await askApproval(
      this.opts.approver,
      { kind: 'start', runId, planHash: ready.planHash, text: startApprovalText(runId, prepared.prepared) },
      this.shutdown.signal,
    );
    if (refused !== null) return { ok: false, code: 'not-approved', message: refused };
    if (!(await this.opts.lock.stillHeld())) return { ok: false, code: 'lock-lost', message: "This process no longer holds the conductor's lock." };
    if (this.closing) return { ok: false, code: 'closed', message: 'The run manager is closing.' };

    const created = await createRun(this.opts.home, { runId, ready, hooks: ctx.hooks, caseInsensitivePaths: ctx.caseInsensitivePaths });
    if (!created.ok) return { ok: false, code: 'store', message: created.problem.message };
    if (this.closing) {
      // Closed while the run was being created: it is carried on at the next start.
      await created.value.close();
      return { ok: false, code: 'closed', message: 'The run manager closed; the run will be carried on when Orchestra starts again.' };
    }
    const run = new ActiveRun(created.value, ctx, manifest, scopeRules);
    run.claudeVersion = detection.engines.find((e) => e.engine === 'claude')?.version ?? null;
    for (const engine of detection.engines) for (const warning of engine.warnings) run.notes.push(`${engine.engine}: ${warning}`);
    this.runs.set(runId, run);
    this.changed(run);
    this.track(run, null, async () => {
      if ((await this.ensureIntegration(run)) !== null) this.pump(run);
    });
    return { ok: true, runId };
  }

  /** The integration branch's tip, made at the base commit if it doesn't exist yet; null when it can't be. */
  private async ensureIntegration(run: ActiveRun): Promise<string | null> {
    const state = run.store.state;
    if (state.integrationTip !== null) return state.integrationTip;
    const started = await startIntegration(run.ctx, run.runId, state.baseSha);
    if (!started.ok) {
      const found = await refState(run.ctx, branchRef(integrationBranch(run.runId)));
      if (found.state !== 'at' || found.sha !== state.baseSha) {
        this.pause(run, `The integration branch could not be made: ${started.error.message}`);
        return null;
      }
    } else {
      await this.hook('integration', run, null);
    }
    if (!(await this.save(run, (s) => ({ ...s, integrationTip: s.baseSha })))) return null;
    await this.log(run, noteEntry(`Started the integration branch ${integrationBranch(run.runId)} at the base commit.`));
    return state.baseSha;
  }

  // -------------------------------------------------------------------------------------------------------
  // Tasks

  private planTask(run: ActiveRun, taskId: string): Task {
    const task = run.store.record.plan.tasks.find((t) => t.id === taskId);
    if (task === undefined) throw new Error(`Run ${run.runId} has no task "${taskId}".`);
    return task;
  }

  /** Starts every waiting task whose dependencies are merged; cancels those whose dependencies can't be. */
  private async startReady(run: ActiveRun): Promise<void> {
    await run.serial.run(async () => {
      for (let changed = true; changed; ) {
        changed = false;
        if (!this.canWrite(run)) return;
        const state = run.store.state;
        if (state.integrationTip === null) return;
        for (const task of run.store.record.plan.tasks) {
          const current = taskState(state, task.id);
          if (current?.status !== 'waiting' || run.busy.has(task.id)) continue;
          const blocked = task.dependsOn.find((d) => TERMINAL_FAILED.has(taskState(state, d)?.status ?? 'waiting'));
          if (run.cancelled || blocked !== undefined) {
            const why = run.cancelled ? 'The run was cancelled.' : `It depends on "${blocked}", which was ${taskState(state, blocked as string)?.status}.`;
            await this.setStatus(run, task.id, 'cancelled', why);
            changed = true;
            continue;
          }
          if (!task.dependsOn.every((d) => state.mergeOrder.includes(d))) continue;
          run.busy.add(task.id);
          this.track(run, task.id, () => this.startTask(run, task.id));
        }
      }
    });
  }

  private async startTask(run: ActiveRun, taskId: string): Promise<void> {
    const release = await this.slots.acquire();
    try {
      if (!this.canWrite(run) || run.cancelled) return;
      const state = run.store.state;
      const task = this.planTask(run, taskId);
      if (taskState(state, taskId)?.status !== 'waiting' || state.integrationTip === null) return;
      const startSha = startCommitFor(task, state.baseSha, state.integrationTip);
      const created = await this.repoLock(run, () => createTaskWorktree(run.ctx, { runId: run.runId, taskId, startSha }));
      if (!created.ok) {
        await this.setStatus(run, taskId, 'failed', `Its worktree could not be made: ${created.error.message}`);
        return;
      }
      run.worktrees.set(taskId, created.worktree);
      await this.hook('worktree', run, taskId);
      const review = newTaskReview(task, reviewSettingsOf(run.store.record));
      if (!(await this.setStatus(run, taskId, 'working', null, { startSha, review: storedReview(review) }))) return;
      await this.runRound(run, taskId, release, { worktreeReady: true });
    } finally {
      release();
      run.busy.delete(taskId);
    }
  }

  /** A fresh worktree for the task at `tip`, replacing any folder left there. Null (task failed) when it can't be. */
  private async freshWorktree(run: ActiveRun, taskId: string, tip: string): Promise<TaskWorktree | null> {
    const made = await this.repoLock(run, async () => {
      const known = run.worktrees.get(taskId);
      const removed = known !== undefined ? await removeTaskWorktree(run.ctx, known) : await removeLeftoverTaskWorktree(run.ctx, run.runId, taskId);
      run.worktrees.delete(taskId);
      if (removed !== null && !removed.folderRemoved) return { ok: false as const, message: `Its old worktree could not be removed: ${removed.problems.join(' ')}` };
      let reopened = await reopenTaskWorktree(run.ctx, { runId: run.runId, taskId, tip });
      // Windows may not have finished deleting the old folder.
      for (let attempt = 1; attempt <= 5 && !reopened.ok && reopened.error.code === 'path-exists'; attempt++) {
        await new Promise((done) => setTimeout(done, 200 * attempt));
        reopened = await reopenTaskWorktree(run.ctx, { runId: run.runId, taskId, tip });
      }
      return reopened.ok ? { ok: true as const, worktree: reopened.worktree } : { ok: false as const, message: `Its worktree could not be made again: ${reopened.error.message}` };
    });
    if (!made.ok) {
      await this.fail(run, taskId, made.message);
      return null;
    }
    run.worktrees.set(taskId, made.worktree);
    return made.worktree;
  }

  private currentRound(review: TaskReview | null): number {
    return review?.attempts.at(-1)?.round ?? 0;
  }

  /** What the reviewer asked for, for a revision round: the previous attempt's review. */
  private revisionFor(review: TaskReview, round: number): RevisionRequest | null {
    if (round === 0) return null;
    const previous = review.attempts.find((a) => a.round === round - 1)?.review ?? null;
    return previous === null ? { instructions: '', findings: [] } : { instructions: previous.instructions ?? '', findings: previous.findings };
  }

  /** The results of every merged task this one depends on (directly or not), for its brief. */
  private async upstreamFor(run: ActiveRun, task: Task): Promise<UpstreamResult[]> {
    const state = run.store.state;
    const graph = new Map(run.store.record.plan.tasks.map((t) => [t.id, t.dependsOn]));
    const deps = new Set<string>();
    const pending = [...task.dependsOn];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (deps.has(id)) continue;
      deps.add(id);
      pending.push(...(graph.get(id) ?? []));
    }
    const upstream: UpstreamResult[] = [];
    for (const id of state.mergeOrder) {
      if (!deps.has(id)) continue;
      const dep = taskState(state, id);
      if (dep?.commit == null || dep.startSha === null) continue;
      const [from, to] = await Promise.all([readCommit(run.ctx, dep.startSha), readCommit(run.ctx, dep.commit)]);
      const diff = from.ok && to.ok ? await diffTrees(run.ctx, from.tree, to.tree) : null;
      const saved = await readResult(this.opts.home, run.runId, id, this.currentRound(dep.review));
      upstream.push({
        taskId: id,
        commit: dep.mergeCommit ?? dep.commit,
        files: diff?.ok === true ? diff.changes.map((c) => c.path) : [],
        result: saved.ok ? (saved.value?.result ?? null) : null,
      });
    }
    return upstream;
  }

  /**
   * One round of a task: from a fresh worktree to the gate. `release` frees the worker place; it is called once the
   * worker ended, and in any case when the round stops, whatever stopped it.
   */
  private async runRound(run: ActiveRun, taskId: string, release: () => void, opts: { readonly worktreeReady?: boolean } = {}): Promise<void> {
    try {
      await this.roundSteps(run, taskId, release, opts);
    } finally {
      release();
    }
  }

  private async roundSteps(run: ActiveRun, taskId: string, release: () => void, opts: { readonly worktreeReady?: boolean }): Promise<void> {
    const task = this.planTask(run, taskId);
    const state = taskState(run.store.state, taskId);
    if (state === null || state.status !== 'working' || state.startSha === null || state.review === null) return;
    if (run.cancelled) {
      await this.fail(run, taskId, 'The run was cancelled.');
      return;
    }
    const round = this.currentRound(state.review);
    const expectedTip = state.commit ?? state.startSha;
    const wt = opts.worktreeReady === true ? run.worktrees.get(taskId) : await this.freshWorktree(run, taskId, expectedTip);
    if (wt === undefined || wt === null) return;

    const detected = await this.detect([task.engine]);
    const engine = detected.engines.find((e) => e.engine === task.engine);
    if (engine === undefined || !engine.ready) {
      release();
      await this.fail(run, taskId, `${task.engine} is not ready: ${engine?.problems.map((p) => p.message).join(' ') ?? 'it was not checked.'}`);
      return;
    }
    if (task.engine === 'claude') run.claudeVersion = engine.version;
    if (!(await this.opts.lock.stillHeld())) {
      release();
      this.pause(run, "This process no longer holds the conductor's lock, so it stopped driving the run.");
      return;
    }
    if (run.manifest === null || run.scopeRules === null) {
      release();
      return;
    }

    const baseline = await this.repoLock(run, () => takeBaseline(run.ctx, this.opts.integrity));
    const agentsBefore = await snapshotAgentConfig({ home: this.userHome, env: this.env });
    const brief = renderBrief({
      plan: run.store.record.plan,
      taskId,
      startSha: expectedTip,
      round,
      rules: rulesForTask(run.manifest, task, task.engine, { claudeVersion: run.claudeVersion, caseInsensitive: run.ctx.caseInsensitivePaths }),
      reservedPatterns: run.scopeRules.reservedPatterns,
      shell: this.opts.shell ?? false,
      upstream: await this.upstreamFor(run, task),
      revision: this.revisionFor(state.review, round),
    });
    let outcome: WorkerOutcome;
    try {
      outcome = await runWorker({
        store: run.store,
        worktree: wt,
        round,
        brief,
        shell: this.opts.shell ?? false,
        timeoutMs: this.limits.workerTimeoutMs,
        signal: AbortSignal.any([run.abort.signal, this.shutdown.signal]),
        env: this.env,
        ...(this.opts.allowEnv !== undefined ? { allowEnv: this.opts.allowEnv } : {}),
        ...(this.opts.programs !== undefined ? { programs: this.opts.programs } : {}),
      });
    } finally {
      release();
    }
    if (this.closing) return;
    if (outcome.status === 'cancelled' || run.cancelled) {
      await this.setStatus(run, taskId, 'cancelled', 'The run was cancelled.');
      return;
    }
    if (outcome.status === 'not-started') {
      await this.fail(run, taskId, `Its worker did not start: ${outcome.error ?? 'unknown reason'}`);
      return;
    }
    if (outcome.mayStillBeRunning) {
      await this.fail(run, taskId, `Something its worker started may still be running, so its worktree was neither checked nor committed. ${outcome.notes.join(' ')}`);
      return;
    }

    // The conductor's own checks, whatever the worker said.
    const integrity = await this.repoLock(run, () => checkIntegrity(run.ctx, wt, baseline, expectedTip, this.opts.integrity));
    await this.log(run, integrityEntry(taskId, round, integrity));
    const agents = compareAgentConfig(agentsBefore, await snapshotAgentConfig({ home: this.userHome, env: this.env }));
    await this.log(run, agentConfigEntry(taskId, round, agents));
    if (!integrity.ok) {
      await this.fail(run, taskId, `The integrity check failed: ${firstMessages(integrity.violations)}`);
      return;
    }
    if (!agents.ok) {
      const changes = agents.changes.map((c) => ({ message: `${c.path} was ${c.change}.` }));
      await this.fail(run, taskId, `The agents' own config folders changed while its worker ran: ${firstMessages([...changes, ...agents.incomplete.map((m) => ({ message: m }))])}`);
      return;
    }
    const scope = await this.repoLock(run, () => checkScope(run.ctx, wt, task, { fromCommit: expectedTip, rules: run.scopeRules as ScopeRules }));
    await this.log(run, scopeEntry(taskId, round, scope));
    if (!scope.ok) {
      await this.fail(run, taskId, `The scope check could not run: ${scope.error.message}`);
      return;
    }
    if (!scope.report.clean) {
      await this.fail(run, taskId, `Its worker changed files it may not change: ${firstMessages(scope.report.violations)}`);
      return;
    }
    const made = await commitTask(run.ctx, wt, task, scope.report, { message: taskCommitMessage(run.runId, task), rules: run.scopeRules });
    if (!made.ok) {
      await this.fail(run, taskId, `Its work could not be committed: ${made.error.message}`);
      return;
    }
    if (made.committed) {
      await this.hook('commit', run, taskId);
      const diff = await run.store.saveDiff(run.ctx, taskId, round, expectedTip, made.tip);
      if (!diff.ok) run.notes.push(`The diff of task "${taskId}", round ${round}, could not be saved: ${diff.problem.message}`);
    }
    if (!(await this.save(run, (s) => withTask(s, taskId, { commit: made.tip })))) return;
    if (made.committed) await this.log(run, commitEntry(taskId, round, made.tip, scope.report.changes.length));

    // The worker's own account, kept for the tasks that depend on this one, and checked against the real diff.
    const parsed = parseWorkerResult(outcome.report.result, taskId);
    const changed = scope.report.changes.map((c) => c.path);
    const savedResult = await run.store.saveResult(
      taskId,
      round,
      parsed.ok
        ? { result: parsed.result, problem: null, claims: claimsOf(parsed.result, changed, run.ctx.caseInsensitivePaths) }
        : { result: null, problem: parsed.problem.message, claims: null },
    );
    if (!savedResult.ok) run.notes.push(`The worker result of task "${taskId}", round ${round}, could not be saved: ${savedResult.problem.message}`);
    else if (parsed.ok) {
      const claims = claimsOf(parsed.result, changed, run.ctx.caseInsensitivePaths);
      if (claims.unclaimed.length + claims.notChanged.length > 0) {
        await this.log(
          run,
          noteEntry(
            `Task "${taskId}", round ${round}: its worker's list of changed files differs from the real diff ` +
              `(changed but not listed: ${claims.unclaimed.length}; listed but not changed: ${claims.notChanged.length}).`,
          ),
        );
      }
    }
    await this.gate(run, task, wt, round, made.tip, outcome.status === 'completed' ? null : (outcome.error ?? outcome.status), integrity.baseline);
  }

  /** The acceptance gate on the round's commit, then the task waits for its review. */
  private async gate(
    run: ActiveRun,
    task: Task,
    wt: TaskWorktree,
    round: number,
    tip: string,
    workerProblem: string | null,
    baseline: IntegrityBaseline,
  ): Promise<void> {
    const taskId = task.id;
    let gate: GateResult;
    try {
      gate = await runAcceptanceGate(run.ctx, wt, task, { baseline, commit: tip }, this.gateOptions(run));
    } catch (error) {
      await this.fail(run, taskId, `The acceptance gate stopped: ${errorText(error)}`);
      return;
    }
    if (this.closing) return;
    const saved = await run.store.saveGate(taskId, round, gate);
    if (!saved.ok) run.notes.push(`The gate of task "${taskId}", round ${round}, could not be saved: ${saved.problem.message}`);
    if (!gate.integrity.ok) {
      await this.log(run, gateEntry(taskId, round, gate));
      await this.fail(run, taskId, `Its acceptance commands changed things outside its worktree: ${firstMessages(gate.integrity.violations)}`);
      return;
    }
    const summary: GateSummary =
      workerProblem === null
        ? { passed: gate.passed, summary: gate.summary }
        : { passed: false, summary: clipText(`Its worker did not finish normally (${workerProblem}). The gate: ${gate.summary}`) };
    await run.serial.run(async () => {
      const current = taskState(run.store.state, taskId);
      if (current?.status !== 'working' || current.review === null || run.cancelled) {
        if (run.cancelled) await this.fail(run, taskId, 'The run was cancelled.');
        return;
      }
      const step = recordGate(current.review, summary);
      if (!step.ok) {
        await this.fail(run, taskId, step.error.message);
        return;
      }
      if (!(await this.save(run, (s) => withTask(s, taskId, { status: 'reviewing', review: storedReview(step.state) })))) return;
      await this.log(run, gateEntry(taskId, round, summary));
      await this.log(run, { kind: 'task-status', task: taskId, status: 'reviewing', reason: null });
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Reviews

  /**
   * Records the orchestrator's review of a task waiting for one. The review rules decide (review/state.ts): accept
   * only with a passing gate and every criterion passed; revise while rounds are left; reject. A refused review
   * changes nothing.
   */
  async submitReview(runId: string, taskId: string, input: unknown): Promise<ActionOutcome> {
    const run = this.runs.get(runId);
    if (run === undefined) return { ok: false, code: 'not-found', message: `No run ${runId} is going.` };
    return run.serial.run(async () => {
      if (!this.canWrite(run)) return { ok: false, code: 'paused', message: `Run ${runId} is paused: ${run.problems.join(' ')}` };
      const current = taskState(run.store.state, taskId);
      if (current === null) return { ok: false, code: 'not-found', message: `Run ${runId} has no task "${taskId}".` };
      if (current.status !== 'reviewing' || current.review === null) {
        return { ok: false, code: 'wrong-status', message: `Task "${taskId}" is ${current.status}, not waiting for a review.` };
      }
      const before = current.review;
      const result = recordReview(before, input);
      if (!result.ok) {
        await this.log(run, reviewEntry(before, result));
        return { ok: false, code: result.error.code, message: result.error.message };
      }
      // A revision starts its next round in the same write, so a crash can't leave the task between the two.
      let next = result.state;
      if (next.status === 'needs-revision') {
        const started = startRevision(next);
        if (!started.ok) return { ok: false, code: started.error.code, message: started.error.message };
        next = started.state;
      }
      const status: TaskStatus = next.status === 'accepted' ? 'accepted' : next.status === 'rejected' ? 'rejected' : 'working';
      const why = status === 'rejected' ? 'Rejected in review.' : null;
      if (!(await this.save(run, (s) => withTask(s, taskId, { review: storedReview(next), status, reason: why })))) {
        return { ok: false, code: 'store', message: run.problems.join(' ') };
      }
      await this.log(run, reviewEntry(before, result));
      await this.log(run, { kind: 'task-status', task: taskId, status, reason: why });
      if (status === 'working') {
        run.busy.add(taskId);
        this.track(run, taskId, async () => {
          try {
            await this.runRound(run, taskId, await this.slots.acquire());
          } finally {
            run.busy.delete(taskId);
          }
        });
      } else {
        this.pump(run);
      }
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Merging and finalize checks

  /** Merges every accepted task that may merge now; true when it merged or refused any. */
  private async mergeReady(run: ActiveRun): Promise<boolean> {
    let progress = false;
    await run.merges.run(async () => {
      for (;;) {
        if (!this.canWrite(run) || run.cancelled) return;
        const state = run.store.state;
        const plan = run.store.record.plan;
        const accepted = new Set(state.tasks.filter((t) => t.status === 'accepted').map((t) => t.id));
        const next = readyToMerge(plan.tasks, accepted, new Set(state.mergeOrder))[0];
        if (next === undefined) return;
        const tip = state.integrationTip ?? (await this.ensureIntegration(run));
        if (tip === null) return;
        const task = this.planTask(run, next);
        const current = taskState(state, next) as TaskState;
        const result = await mergeTask(run.ctx, {
          runId: run.runId,
          task,
          start: current.startSha as string,
          commit: current.commit as string,
          expectedTip: tip,
          rules: run.scopeRules as ScopeRules,
        });
        progress = true;
        if (!result.ok) {
          await this.log(run, mergeEntry(next, result));
          await this.fail(run, next, `Merging it was refused (${result.error.code}): ${result.error.message}`);
          continue;
        }
        if (result.merged) await this.hook('merge', run, next);
        const merged = await this.save(run, (s) => ({
          ...withTask(s, next, { status: 'merged', reason: null, mergeCommit: result.merged ? result.tip : null }),
          mergeOrder: [...s.mergeOrder, next],
          integrationTip: result.tip,
        }));
        if (!merged) return;
        await this.log(run, mergeEntry(next, result));
        await this.log(run, { kind: 'task-status', task: next, status: 'merged', reason: null });
        if (this.opts.checkAfterEachMerge === true && result.merged) await this.checkIntegration(run, result.tip);
      }
    });
    return progress;
  }

  /** Optional: every merged task's acceptance commands on the integration tip, to find the merge that broke things. */
  private async checkIntegration(run: ActiveRun, tip: string): Promise<void> {
    const state = run.store.state;
    const tasks = state.mergeOrder.map((id) => this.planTask(run, id));
    const combined = await checkCombined(run.ctx, { runId: run.runId, name: 'integration', tip, tasks }, this.gateOptions(run));
    const what = combined.problem ?? (combined.passed ? 'every merged task\'s commands passed' : `failed: ${combined.gate?.summary ?? 'no result'}`);
    await this.log(run, noteEntry(`Checked the integration branch at ${tip.slice(0, 12)} after merging: ${what}.`));
  }

  private async maybeFinalize(run: ActiveRun): Promise<void> {
    if (!this.canWrite(run) || run.finalizing || run.discard.signal.aborted) return;
    const state = run.store.state;
    if (state.status !== 'running' || state.tasks.some((t) => isUnfinished(t.status)) || run.busy.size > 0) return;
    if (state.mergeOrder.length === 0 || state.integrationTip === null) return;
    if (run.finalize !== null && run.finalize.integrationTip === state.integrationTip) return;
    const input = finalizeInputOf(run.store.record, state);
    if (input === null) return;
    run.finalizing = true;
    this.changed(run);
    try {
      const report = await finalizeChecks(run.ctx, input, this.finalizeOptions(run));
      if (this.closing || run.discard.signal.aborted) return;
      const saved = await run.store.saveFinalizeReport(report);
      if (!saved.ok) run.notes.push(`The finalize report could not be saved: ${saved.problem.message}`);
      run.finalize = finalizeSummary(report);
      await this.log(run, finalizeEntry(report));
      this.changed(run);
    } finally {
      run.finalizing = false;
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Cancelling and discarding

  /** Stops the run's work: workers are stopped, unfinished tasks cancelled. What was merged stays for the finalize. */
  async cancelRun(runId: string): Promise<ActionOutcome> {
    const run = this.runs.get(runId);
    if (run === undefined) return { ok: false, code: 'not-found', message: `No run ${runId} is going.` };
    run.cancelled = true;
    run.abort.abort();
    // A merge already going finishes first (no new one starts now), so the state read below is current.
    await run.merges.run(() => Promise.resolve());
    await run.serial.run(async () => {
      for (const id of run.store.state.tasks.map((t) => t.id)) {
        const current = taskState(run.store.state, id);
        if (current === null || !isUnfinished(current.status)) continue;
        // A task being started or worked on notices the cancel itself (its worker is stopped first).
        if (run.busy.has(id) && (current.status === 'working' || current.status === 'waiting')) continue;
        await this.setStatus(run, id, 'cancelled', 'The run was cancelled.');
      }
    });
    this.pump(run);
    return { ok: true };
  }

  /**
   * Discards a run, after the user approves: stops it, removes its worktrees and branches (each only where Orchestra
   * left it) and marks it discarded. The run folder stays, for the record.
   */
  async discardRun(runId: string): Promise<ActionOutcome> {
    const run = this.runs.get(runId);
    if (run === undefined) return { ok: false, code: 'not-found', message: `No run ${runId} is going.` };
    const text = `Discard Orchestra run ${runId}? Its worktrees and its orchestra/${runId}/* branches are removed; your branch is not touched. The run folder stays.`;
    const refused = await askApproval(this.opts.approver, { kind: 'discard', runId, planHash: run.store.record.planHash, text }, this.shutdown.signal);
    if (refused !== null) return { ok: false, code: 'not-approved', message: refused };
    run.discard.abort();
    await this.cancelRun(runId);
    await this.settled(runId);
    let notes: string[];
    try {
      notes = await this.removeRunGit(run);
    } catch (error) {
      notes = [`Removing the run's worktrees and branches stopped: ${errorText(error)}`];
    }
    if (!(await this.save(run, (s) => ({ ...s, status: 'discarded' })))) {
      return { ok: false, code: 'store', message: run.problems.join(' ') };
    }
    await this.log(run, { kind: 'run-status', status: 'discarded', finalCommit: null });
    await run.store.close();
    this.runs.delete(runId);
    this.emit({ type: 'run', run: (await this.status(runId)) ?? this.summaryOf(run) });
    return { ok: true, notes };
  }

  /** Removes the run's worktrees and branches, each only while it points where the run left it. */
  private async removeRunGit(run: ActiveRun): Promise<string[]> {
    const notes: string[] = [];
    const state = run.store.state;
    await this.repoLock(run, async () => {
      for (const t of state.tasks) {
        if (t.startSha === null) continue;
        const tip = t.commit ?? t.startSha;
        const known = run.worktrees.get(t.id);
        const removed =
          known !== undefined
            ? await removeTaskWorktree(run.ctx, known, { deleteBranchAt: tip })
            : await removeLeftoverTaskWorktree(run.ctx, run.runId, t.id, { deleteBranchAt: tip });
        run.worktrees.delete(t.id);
        if (removed !== null && !removed.ok) notes.push(...removed.problems);
      }
      const check = await removeLeftoverCheckWorktree(run.ctx, run.runId, 'integration');
      if (check !== null && !check.ok) notes.push(...check.problems);
      notes.push(...(await clearFinalizeCheck(run.ctx, run.runId)));
    });
    if (state.integrationTip !== null) {
      const removed = await removeIntegration(run.ctx, run.runId, state.integrationTip);
      if (!removed.ok) notes.push(removed.error.message);
    }
    return notes;
  }

  // -------------------------------------------------------------------------------------------------------
  // Closing

  /** Stops driving runs: workers are stopped, work in progress ends, the stores close. A restart carries on. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.shutdown.abort();
    for (const run of this.runs.values()) await Promise.allSettled([...run.pipelines]);
    for (const run of this.runs.values()) await run.store.close();
    this.runs.clear();
  }

  /**
   * Stops driving runs and closes their stores at once, without stopping workers or waiting for work in progress:
   * what a crash leaves behind, for tests of open()'s recovery. The process stays alive.
   */
  async detach(opts: { readonly stopWorkers?: boolean } = {}): Promise<void> {
    this.closing = true;
    if (opts.stopWorkers === true) this.shutdown.abort();
    for (const run of this.runs.values()) await run.store.close();
    this.runs.clear();
  }

  // -------------------------------------------------------------------------------------------------------
  // Recovery

  private async recoverAll(): Promise<void> {
    const listed = await listRuns(this.opts.home);
    if (!listed.ok) return;
    for (const runId of listed.value.runs) {
      const loaded = await loadRun(this.opts.home, runId);
      if (!loaded.ok) {
        this.unopened.set(runId, loaded.problem.message);
        continue;
      }
      if (loaded.value.state.status !== 'running') continue;
      const opened = await openRun(this.opts.home, runId);
      if (!opened.ok) {
        this.unopened.set(runId, opened.problem.message);
        continue;
      }
      const store = opened.value.store;
      const ctx = contextOf(store.record, this.opts.home);
      const run = new ActiveRun(store, ctx, null, null);
      this.runs.set(runId, run);
      for (const note of opened.value.notes) await this.log(run, noteEntry(note));
      await this.log(run, noteEntry('Orchestra started again and is carrying on with this run.'));
      try {
        await this.recoverRun(run);
      } catch (error) {
        this.pause(run, `Carrying on after the restart failed: ${errorText(error)}`);
      }
      this.changed(run);
      this.pump(run);
    }
  }

  private async recoverRun(run: ActiveRun): Promise<void> {
    const { ctx } = run;
    const record = run.store.record;
    const built = await buildRulesManifest(ctx, { baseSha: record.plan.baseSha, home: this.userHome, env: this.env });
    if (!built.ok) {
      this.pause(run, `The rules manifest could not be rebuilt: ${built.problem}`);
      return;
    }
    const scope = scopeRulesFor(built.manifest);
    if (!scope.ok) {
      this.pause(run, scope.message);
      return;
    }
    run.manifest = built.manifest;
    run.scopeRules = scope.rules;
    const report = await readFinalizeReport(this.opts.home, run.runId);
    if (report.ok && report.value !== null) run.finalize = finalizeSummary(report.value);

    await this.stopLeftoverWorkers(run);
    await this.recoverIntegration(run);
    if (run.problems.length > 0) return;
    await this.repoLock(run, async () => {
      const check = await removeLeftoverCheckWorktree(ctx, run.runId, 'integration');
      if (check !== null && !check.ok) run.notes.push(...check.problems);
      run.notes.push(...(await clearFinalizeCheck(ctx, run.runId)));
    });
    for (const task of record.plan.tasks) {
      if (run.problems.length > 0) return;
      await this.recoverTask(run, task);
    }
  }

  /** Workers that never ended in the state: stopped if they still run (checked first), and recorded as ended. */
  private async stopLeftoverWorkers(run: ActiveRun): Promise<void> {
    for (const t of run.store.state.tasks) {
      for (const [index, worker] of t.workers.entries()) {
        if (worker.endedAt !== null) continue;
        // Only a process working in this task's own worktree: the record could have been forged to name another one.
        const folder = join(homeLayout(canonicalPath(this.opts.home) ?? this.opts.home).worktrees, run.runId, t.id);
        const outcome =
          worker.process == null
            ? 'unverified'
            : await stopVerifiedProcess(worker.process, { insideFolder: folder, caseInsensitive: run.ctx.caseInsensitivePaths });
        const mayRun = (outcome === 'unverified' && worker.process != null) || outcome === 'still-running' || outcome === 'elsewhere';
        const what: Record<typeof outcome, string> = {
          stopped: 'it was still running and was stopped',
          gone: 'it had ended',
          'not-ours': 'it had ended (its process id now names another process, which was left alone)',
          elsewhere: 'a process with its id and start time still runs, but not in its worktree, so it was left alone',
          unverified: worker.process == null ? 'its process was never recorded' : 'its process could not be checked, so it was left alone',
          'still-running': 'it still runs and could not be stopped',
        };
        const error = `Orchestra stopped while this worker ran; ${what[outcome]}.`;
        const saved = await this.save(run, (s) => {
          const workers = [...(taskState(s, t.id)?.workers ?? [])];
          const at = workers[index];
          if (at === undefined || at.endedAt !== null) return s;
          workers[index] = { ...at, endedAt: new Date().toISOString(), error };
          return withTask(s, t.id, { workers });
        });
        if (!saved) return;
        await this.log(run, noteEntry(`Task "${t.id}", round ${worker.round}: ${error}`));
        if (mayRun && isUnfinished(t.status)) {
          await this.setStatus(run, t.id, 'failed', `A worker from before Orchestra restarted may still be running (process ${worker.process?.pid}), so the task does not go on.`);
        }
      }
    }
  }

  /** The integration branch against the state: record a merge git shows, or pause when it moved otherwise. */
  private async recoverIntegration(run: ActiveRun): Promise<void> {
    const state = run.store.state;
    const found = await refState(run.ctx, branchRef(integrationBranch(run.runId)));
    if (state.integrationTip === null) {
      if (found.state === 'missing' || (found.state === 'at' && found.sha === state.baseSha)) await this.ensureIntegration(run);
      else this.pause(run, `The integration branch ${integrationBranch(run.runId)} is not where the run would have made it.`);
      return;
    }
    if (found.state === 'at' && found.sha === state.integrationTip) return;
    if (found.state === 'at') {
      const plan = run.store.record.plan;
      const accepted = new Set(state.tasks.filter((t) => t.status === 'accepted').map((t) => t.id));
      for (const id of readyToMerge(plan.tasks, accepted, new Set(state.mergeOrder))) {
        const t = taskState(state, id) as TaskState;
        if (t.startSha === null || t.commit === null) continue;
        const checked = await verifyMergeCommit(run.ctx, { tip: state.integrationTip, candidate: found.sha, start: t.startSha, commit: t.commit, task: this.planTask(run, id), rules: run.scopeRules as ScopeRules });
        if (!checked.ok) continue;
        const saved = await this.save(run, (s) => ({
          ...withTask(s, id, { status: 'merged', reason: null, mergeCommit: found.sha }),
          mergeOrder: [...s.mergeOrder, id],
          integrationTip: found.sha,
        }));
        if (!saved) return;
        await this.log(run, noteEntry(`Recorded the merge of task "${id}" (${found.sha.slice(0, 12)}), which git had made before Orchestra stopped.`));
        await this.log(run, { kind: 'task-status', task: id, status: 'merged', reason: null });
        return;
      }
    }
    const where = found.state === 'at' ? `points at ${found.sha.slice(0, 12)}` : found.state === 'link' ? `is a link to ${found.target}` : 'is gone';
    this.pause(run, `The integration branch ${integrationBranch(run.runId)} ${where}, not at ${state.integrationTip.slice(0, 12)} as recorded. Orchestra does not carry on.`);
  }

  private async recoverTask(run: ActiveRun, task: Task): Promise<void> {
    const state = run.store.state;
    const t = taskState(state, task.id) as TaskState;
    const ref = branchRef(taskBranch(run.runId, task.id));
    if (t.status === 'waiting') {
      // A worktree made just before the crash, whose state write never happened: removed with its new branch.
      if (state.integrationTip === null) return;
      const start = startCommitFor(task, state.baseSha, state.integrationTip);
      const found = await refState(run.ctx, ref);
      if (found.state === 'missing') {
        await this.repoLock(run, () => removeLeftoverTaskWorktree(run.ctx, run.runId, task.id));
        return;
      }
      const removed = await this.repoLock(run, () => removeLeftoverTaskWorktree(run.ctx, run.runId, task.id, { deleteBranchAt: start }));
      if (removed === null || !removed.branchDeleted) {
        await this.setStatus(run, task.id, 'failed', `Its branch ${taskBranch(run.runId, task.id)} exists, but not where Orchestra would have made it.`);
      } else {
        await this.log(run, noteEntry(`Removed the worktree of task "${task.id}", made just before Orchestra stopped; it starts again.`));
      }
      return;
    }
    if (!isUnfinished(t.status) || t.startSha === null) return;
    const recorded = t.commit ?? t.startSha;
    const found = await refState(run.ctx, ref);
    if (found.state !== 'at') {
      await this.setStatus(run, task.id, 'failed', `Its branch ${taskBranch(run.runId, task.id)} ${found.state === 'link' ? 'was turned into a link' : 'is gone'}.`);
      return;
    }
    if (t.status !== 'working') {
      if (found.sha !== recorded) await this.setStatus(run, task.id, 'failed', `Its branch moved to ${found.sha.slice(0, 12)} after its commit was recorded.`);
      return;
    }
    const round = this.currentRound(t.review);
    if (found.sha !== recorded) {
      // Git one step ahead: the round's commit was made, its state write not. Recorded once checked, so the state
      // matches git; the round itself doesn't go on (below).
      const checked = await verifyTaskCommit(run.ctx, task, recorded, found.sha, run.scopeRules as ScopeRules);
      if (!checked.ok) {
        await this.setStatus(run, task.id, 'failed', `Its branch moved to a commit Orchestra can't account for: ${checked.message}`);
        return;
      }
      if (!(await this.save(run, (s) => withTask(s, task.id, { commit: found.sha })))) return;
      await this.log(run, commitEntry(task.id, round, found.sha, checked.changes.length));
      await this.log(run, noteEntry(`Recorded the commit of task "${task.id}", round ${round}, which git had made before Orchestra stopped.`));
      await run.store.saveDiff(run.ctx, task.id, round, recorded, found.sha);
    }
    if (taskState(run.store.state, task.id)?.workers.some((w) => w.round === round) !== true) {
      // No worker ran in this round yet: nothing happened that a check would have to compare, so it simply starts.
      run.busy.add(task.id);
      this.track(run, task.id, async () => {
        try {
          await this.runRound(run, task.id, await this.slots.acquire());
        } finally {
          run.busy.delete(task.id);
        }
      });
      return;
    }
    // The round's checks compare with what was there before its worker started, and that is gone with the old
    // process. Carrying on from a new baseline would hide whatever the worker (or its tests) changed: stopping
    // Orchestra would be a way past the checks. So an interrupted round ends the task.
    await this.setStatus(
      run,
      task.id,
      'failed',
      `Orchestra stopped while round ${round} of this task was going, so that round's checks (integrity, the agents' folders, the ` +
        'acceptance gate) could not be completed; the task does not go on. Plan it again in a new run.',
    );
  }
}

function finalizeSummary(report: { readonly ready: boolean; readonly integrationTip: string; readonly target: { readonly tip: string } | null; readonly problems: readonly { readonly message: string }[] }): FinalizeSummary {
  return { ready: report.ready, integrationTip: report.integrationTip, targetTip: report.target?.tip ?? null, problems: report.problems.map((p) => p.message) };
}
