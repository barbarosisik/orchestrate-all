/**
 * A run manager on a throwaway repository and Orchestra home, with a fake Claude Code whose "workers" edit files in
 * their worktree, a fake approver, and helpers to wait on runs. Nothing real is touched: the user's home for rule
 * files and agent folders is a temp folder too.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalAnswer, ApprovalRequest, Approver } from '../../src/manager/approval.js';
import { acquireLock, type HeldLock } from '../../src/manager/lock.js';
import { RunManager, type ManagerOptions } from '../../src/manager/manager.js';
import type { RunSummary } from '../../src/manager/summary.js';
import { fakeEnv, installFakeEngine, type FakeEngine, type FakeReply } from './fake-engine.js';
import { makeFixture, type Fixture, type FixtureOptions } from './fixture.js';

export const FILES = {
  'README.md': 'hello\n',
  '.gitignore': 'dist/\n',
  'src/api/a.ts': 'api v1\n',
  'src/web/w.ts': 'web v1\n',
  'docs/guide.md': 'guide v1\n',
};

export class FakeApprover implements Approver {
  readonly requests: ApprovalRequest[] = [];
  answer: 'approve' | 'refuse' | 'wrong-hash' | 'throw' = 'approve';

  ask(request: ApprovalRequest): Promise<ApprovalAnswer> {
    this.requests.push(request);
    if (this.answer === 'throw') return Promise.reject(new Error('the dialog crashed'));
    if (this.answer === 'refuse') return Promise.resolve({ approved: false, reason: 'the user said no' });
    return Promise.resolve({ approved: true, planHash: this.answer === 'wrong-hash' ? `sha256:${'0'.repeat(64)}` : request.planHash });
  }
}

export interface WorkerScript {
  /** Files the worker writes (null deletes), relative to its worktree. */
  readonly files?: Readonly<Record<string, string | null>>;
  /** Files it writes by absolute path (stepping outside its worktree). */
  readonly absolute?: Readonly<Record<string, string>>;
  /** Paths its result claims it changed; defaults to the files it writes. */
  readonly claims?: readonly string[];
  readonly summary?: string;
  /** Interfaces its result reports. */
  readonly interfaces?: readonly { readonly name: string; readonly location: string }[];
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly delayMs?: number;
}

/** What a fake Claude worker prints: the init event, then a result whose text ends with the JSON worker result. */
export function claudeEvents(taskId: string, script: WorkerScript): object[] {
  const claims = script.claims ?? Object.keys(script.files ?? {});
  const result = {
    task_id: taskId,
    status: 'completed',
    summary: script.summary ?? `Did ${taskId}.`,
    files_changed: claims.map((path) => ({ path, change: 'modified', purpose: 'the task' })),
    interfaces: (script.interfaces ?? []).map((i) => ({ name: i.name, kind: 'function', location: i.location, signature: `${i.name}()`, change: 'added' })),
  };
  return [
    { type: 'system', subtype: 'init', session_id: 's', permissionMode: 'acceptEdits', apiKeySource: 'none', mcp_servers: [], tools: ['Read', 'Edit'] },
    {
      type: 'result',
      subtype: script.exitCode === undefined || script.exitCode === 0 ? 'success' : 'error_during_execution',
      is_error: script.exitCode !== undefined && script.exitCode !== 0,
      result: `Done.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
      session_id: 's',
      usage: { input_tokens: 10, output_tokens: 5 },
      permission_denials: [],
    },
  ];
}

function reply(taskId: string, script: WorkerScript): FakeReply {
  return {
    stdout: script.hang === true ? [] : claudeEvents(taskId, script),
    ...(script.files !== undefined ? { writeFiles: script.files } : {}),
    ...(script.absolute !== undefined ? { writeAbsolute: script.absolute } : {}),
    ...(script.exitCode !== undefined ? { exitCode: script.exitCode } : {}),
    ...(script.hang === true ? { hang: true } : {}),
    ...(script.delayMs !== undefined ? { delayMs: script.delayMs } : {}),
  };
}

/** Worker scripts per task, and per round with "<task>@<round>" (which wins over the task's own). */
export type Scripts = Readonly<Record<string, WorkerScript>>;

export function claudeScenario(scripts: Scripts) {
  const byBrief = Object.entries(scripts)
    .sort(([a], [b]) => Number(b.includes('@')) - Number(a.includes('@')))
    .map(([key, script]) => {
      const [taskId, round] = key.split('@') as [string, string | undefined];
      const includes = [`<orchestra_brief task="${taskId}"`, ...(round === undefined ? [] : [`round="${round}"`])];
      return { includes, reply: reply(taskId, script) };
    });
  return {
    replies: {
      '--version': { stdout: ['2.1.330 (Claude Code)'] },
      'auth status': { stdout: [{ loggedIn: true, authMethod: 'claude.ai' }] },
    },
    byBrief,
  };
}

export interface PlanTask {
  readonly id: string;
  readonly owns: readonly string[];
  readonly commands?: readonly (readonly string[])[];
  readonly dependsOn?: readonly string[];
  readonly criteria?: readonly string[];
}

/** An acceptance command that passes when `file` holds exactly `content`. */
export function fileIs(file: string, content: string): string[] {
  return [process.execPath, '-e', `process.exit(require('fs').readFileSync(${JSON.stringify(file)},'utf8')===${JSON.stringify(content)}?0:1)`];
}

/** An acceptance command running a short Node.js script. */
export function nodeCommand(code: string): string[] {
  return [process.execPath, '-e', code];
}

export interface ManagerSetup {
  readonly fx: Fixture;
  readonly userHome: string;
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly lock: HeldLock;
  readonly approver: FakeApprover;
  readonly claude: FakeEngine;
  manager: RunManager;
  plan(tasks: readonly PlanTask[]): unknown;
  open(extra?: Partial<ManagerOptions>): Promise<RunManager>;
  waitFor(runId: string, done: (summary: RunSummary) => boolean, timeoutMs?: number): Promise<RunSummary>;
  /** What a crash leaves (stores closed, workers left running unless told), then a new manager carrying on. */
  restart(opts?: { readonly stopWorkers?: boolean; readonly extra?: Partial<ManagerOptions> }): Promise<RunManager>;
  cleanup(): Promise<void>;
}

export const INTEGRITY = { globalGitFiles: [] };

export async function setupManager(
  scripts: Scripts = {},
  opts: { readonly fixture?: FixtureOptions; readonly extra?: Partial<ManagerOptions> } = {},
): Promise<ManagerSetup> {
  const fx = makeFixture({ files: FILES, ...opts.fixture });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orch-mgr-')));
  const userHome = join(scratch, 'user');
  const bin = join(scratch, 'bin');
  const claude = installFakeEngine(bin, 'claude', claudeScenario(scripts));
  const env = fakeEnv(bin, { HOME: userHome, USERPROFILE: userHome });
  const locked = await acquireLock(join(fx.home, 'service', 'conductor.lock'));
  if (!locked.ok) throw new Error(locked.message);
  const lock = locked.lock;
  const approver = new FakeApprover();
  const managers: RunManager[] = [];
  const open = async (extra: Partial<ManagerOptions> = {}): Promise<RunManager> => {
    const manager = await RunManager.open({
      home: fx.home,
      lock,
      approver,
      userHome,
      env,
      integrity: INTEGRITY,
      limits: { commandTimeoutMs: 60_000, workerTimeoutMs: 60_000 },
      ...opts.extra,
      ...extra,
    });
    managers.push(manager);
    return manager;
  };
  const setup: ManagerSetup = {
    fx,
    userHome,
    bin,
    env,
    lock,
    approver,
    claude,
    manager: await open(),
    plan: (tasks) => ({
      version: 1,
      goal: 'Improve the app.',
      repo: fx.repo.dir,
      targetBranch: 'main',
      orchestrator: { engine: 'claude', model: 'opus' },
      tasks: tasks.map((t) => ({
        id: t.id,
        title: `Task ${t.id}`,
        kind: 'work',
        mode: 'write',
        brief: `Do ${t.id}.`,
        engine: 'claude',
        model: 'test-model',
        owns: [...t.owns],
        dependsOn: [...(t.dependsOn ?? [])],
        acceptance: { commands: (t.commands ?? []).map((c) => [...c]), criteria: [...(t.criteria ?? ['works'])] },
      })),
    }),
    open,
    async waitFor(runId, done, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      let last: RunSummary | null = null;
      while (Date.now() < deadline) {
        last = await setup.manager.status(runId);
        if (last !== null && done(last)) return last;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Timed out waiting on run ${runId}: ${JSON.stringify(last, null, 2)}`);
    },
    async restart(restartOpts = {}) {
      await setup.manager.detach({ stopWorkers: restartOpts.stopWorkers ?? false });
      setup.manager = await open(restartOpts.extra);
      return setup.manager;
    },
    async cleanup() {
      for (const manager of managers) await manager.close();
      await lock.release();
      fx.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  return setup;
}

/** Runs the plan through the fake approver; throws unless it started. */
export async function startPlan(s: ManagerSetup, tasks: readonly PlanTask[]): Promise<string> {
  const started = await s.manager.startRun(s.plan(tasks));
  if (!started.ok) throw new Error(`${started.code}: ${started.message} ${JSON.stringify(started.problems ?? [])}`);
  return started.runId;
}

export function accept(criteria: readonly string[] = ['works']): unknown {
  return { verdict: 'accept', criteria: criteria.map((criterion) => ({ criterion, verdict: 'pass', evidence: 'checked' })), findings: [] };
}

export function revise(instructions: string, criteria: readonly string[] = ['works']): unknown {
  return {
    verdict: 'revise',
    criteria: criteria.map((criterion) => ({ criterion, verdict: 'fail', evidence: 'not yet' })),
    findings: [{ severity: 'major', summary: 'Not done yet.' }],
    instructions,
  };
}

export function reject(criteria: readonly string[] = ['works']): unknown {
  return { verdict: 'reject', criteria: criteria.map((criterion) => ({ criterion, verdict: 'fail', evidence: 'wrong' })), findings: [] };
}

export function taskOf(summary: RunSummary, id: string) {
  const task = summary.tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
}
