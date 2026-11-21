import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GateResult } from '../../src/accept/gate.js';
import type { FinalizeReport } from '../../src/finalize/check.js';
import { sha256Of } from '../../src/plan/hash.js';
import { canonicalPath } from '../../src/repo/canonical.js';
import type { ReadyPlan } from '../../src/repo/checks.js';
import { tempName } from '../../src/store/files.js';
import { serializeRecord } from '../../src/store/log.js';
import {
  createRun,
  listRuns,
  loadRun,
  openRun,
  readDiff,
  readFinalizeReport,
  readGate,
  readOutput,
  readRunLog,
  removeLeftovers,
  removeRun,
  type RunStore,
  type StoreOptions,
} from '../../src/store/run.js';
import { newTaskReview, recordGate } from '../../src/review/state.js';
import type { PlanRecord, RunState } from '../../src/store/schema.js';
import { reviewSettingsOf, setupHashOf } from '../../src/store/state.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';
import { acceptedReview, awaitingReview, BASE, NOW, SHA, samplePlan, sampleReady } from '../helpers/store.js';

const RUN = '20261121-120000-abcd';
const f = fixtures();
const scratch: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  f.cleanupAll();
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempHome(name = 'home'): string {
  const parent = mkdtempSync(join(tmpdir(), 'orch-store-'));
  scratch.push(parent);
  return join(parent, name);
}

const TASKS = [{ id: 'api' }, { id: 'ui', dependsOn: ['api'] }];
const now = (): Date => NOW;

async function create(home: string, ready: ReadyPlan = sampleReady(TASKS), opts: StoreOptions = {}, runId = RUN): Promise<RunStore> {
  const created = await createRun(home, { runId, ready, hooks: 'off', caseInsensitivePaths: true }, { now, ...opts });
  if (!created.ok) throw new Error(created.problem.message);
  stores.push(created.value);
  return created.value;
}

function code(result: { ok: true } | { ok: false; problem: { code: string } }): string {
  return result.ok ? 'ok' : result.problem.code;
}

function runFolder(home: string, runId = RUN): string {
  return join(home, 'runs', runId);
}

const GATE: GateResult = {
  passed: true,
  acceptance: {
    passed: true,
    commands: [
      {
        argv: ['node', '-e', 'console.log(1)'],
        program: '/usr/bin/node',
        status: 'passed',
        exitCode: 0,
        signal: null,
        durationMs: 12,
        stdout: { text: '1\n', totalBytes: 2, truncated: false },
        stderr: { text: '', totalBytes: 0, truncated: false },
        error: null,
      },
    ],
  },
  integrity: {
    ok: true,
    violations: [],
    baseline: { refs: { 'refs/heads/main': BASE }, checkouts: {}, hiddenIndex: {}, repoFiles: {}, userWorktrees: {}, configFiles: {} },
  },
  added: ['dist/out.js'],
  trackedChanged: [],
  scopeProblem: null,
  summary: '1/1 commands passed; integrity ok; 1 file added by the commands (not committed)',
};

const REPORT: FinalizeReport = {
  ready: false,
  runId: RUN,
  targetBranch: 'main',
  baseSha: BASE,
  integrationTip: BASE,
  target: null,
  tasks: [],
  checkouts: [],
  acceptance: null,
  problems: [{ code: 'nothing-to-finalize', message: 'Finalizing would not change main.', paths: [] }],
  notes: ['a note'],
};

describe('createRun and loadRun', () => {
  it('creates a complete run folder and reads it back', async () => {
    const home = tempHome();
    const store = await create(home);
    const folder = runFolder(home);
    expect(store.folder).toBe(join(canonicalPath(home) ?? home, 'runs', RUN));
    expect(readdirSync(folder).sort()).toEqual(['log.jsonl', 'plan.json', 'state.json', 'tasks']);
    expect(readdirSync(join(home, 'runs'))).toEqual([RUN]);
    const loaded = await loadRun(home, RUN);
    if (!loaded.ok) throw new Error(loaded.problem.message);
    expect(loaded.value.record).toEqual(store.record);
    expect(loaded.value.state).toEqual(store.state);
    expect(loaded.value.state.tasks.map((t) => [t.id, t.status])).toEqual([
      ['api', 'waiting'],
      ['ui', 'waiting'],
    ]);
    const log = await readRunLog(home, RUN);
    expect(log.ok && log.value.records).toEqual([
      { v: 1, at: NOW.toISOString(), kind: 'run-created', planHash: store.record.planHash, targetBranch: 'main', baseSha: BASE, tasks: ['api', 'ui'] },
    ]);
  });

  it('refuses ids that are not safe folder names', async () => {
    const home = tempHome();
    for (const runId of ['Run1', '../x', 'a/b', 'a\\b', 'con', 'nul', '', 'x'.repeat(33), '..']) {
      const created = await createRun(home, { runId, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true });
      expect(code(created), runId).toBe('bad-name');
      expect(code(await loadRun(home, runId))).toBe('bad-name');
      expect(code(await removeRun(home, runId))).toBe('bad-name');
      expect(code(await readRunLog(home, runId))).toBe('bad-name');
    }
    expect(existsSync(join(home, 'runs'))).toBe(false);
  });

  it('never reuses a run folder', async () => {
    const home = tempHome();
    await (await create(home)).close();
    const again = await createRun(home, { runId: RUN, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true });
    expect(code(again)).toBe('exists');
  });

  it('refuses a plan that does not match its hash', async () => {
    const ready = { ...sampleReady(TASKS), planHash: sha256Of('something else') };
    expect(code(await createRun(tempHome(), { runId: RUN, ready, hooks: 'off', caseInsensitivePaths: true }))).toBe('invalid');
  });

  it("refuses a home inside the user's repository", async () => {
    const fx = f.make();
    const ready = { ...sampleReady(TASKS), repoRoot: fx.ctx.repoRoot, gitCommonDir: fx.ctx.commonDir };
    const home = join(fx.repo.dir, '.orchestra');
    expect(code(await createRun(home, { runId: RUN, ready, hooks: 'off', caseInsensitivePaths: true }))).toBe('home-overlaps-repo');
  });

  it('leaves nothing behind when creation fails half-way', async () => {
    const home = tempHome();
    const failing = (): Promise<void> => Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const created = await createRun(home, { runId: RUN, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true }, { rename: failing });
    expect(code(created)).toBe('io');
    expect(readdirSync(join(home, 'runs'))).toEqual([]);
  });

  it('reports a run that does not exist', async () => {
    const loaded = await loadRun(tempHome(), RUN);
    expect(loaded.ok ? 'ok' : loaded.problem.message).toMatch(/There is no run/);
  });
});

describe('RunStore.update', () => {
  it('saves the state atomically and keeps it frozen in memory', async () => {
    const home = tempHome();
    const store = await create(home);
    const updated = await store.updateTask('api', { status: 'working', startSha: BASE });
    expect(code(updated)).toBe('ok');
    expect(store.state.tasks[0]?.status).toBe('working');
    expect(() => {
      (store.state.tasks[0] as { status: string }).status = 'merged';
    }).toThrow();
    const loaded = await loadRun(home, RUN);
    expect(loaded.ok && loaded.value.state).toEqual(store.state);
    expect(readdirSync(runFolder(home)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a state that does not fit the plan, and writes nothing', async () => {
    const home = tempHome();
    const store = await create(home);
    const before = readFileSync(join(runFolder(home), 'state.json'), 'utf8');
    const merged = await store.updateTask('api', { status: 'merged', commit: SHA('1') });
    expect(merged.ok ? 'ok' : merged.problem.message).toMatch(/merged without an accepted review/);
    expect(code(await store.updateTask('api', { status: 'nope' as 'waiting' }))).toBe('invalid');
    expect(code(await store.updateTask('nope', { status: 'failed' }))).toBe('invalid');
    expect(readFileSync(join(runFolder(home), 'state.json'), 'utf8')).toBe(before);
    expect(store.state.tasks[0]?.status).toBe('waiting');
  });

  it('runs writes one at a time, in order', async () => {
    const home = tempHome();
    const store = await create(home);
    const results = await Promise.all([
      store.updateTask('api', { status: 'working', startSha: BASE }),
      store.appendLog({ kind: 'note', message: 'between' }),
      store.updateTask('api', { status: 'reviewing', review: awaitingReview('api') }),
    ]);
    expect(results.map(code)).toEqual(['ok', 'ok', 'ok']);
    expect(store.state.tasks[0]?.status).toBe('reviewing');
    const loaded = await loadRun(home, RUN);
    expect(loaded.ok && loaded.value.state.tasks[0]?.status).toBe('reviewing');
  });

  it('keeps the previous state readable when a write is interrupted before the rename', async () => {
    const home = tempHome();
    let crash = false;
    const store = await create(home, sampleReady(TASKS), {
      rename: (from, to) => (crash ? Promise.reject(Object.assign(new Error('power cut'), { code: 'EIO' })) : rename(from, to)),
    });
    expect(code(await store.updateTask('api', { status: 'working', startSha: BASE }))).toBe('ok');
    crash = true;
    const failed = await store.updateTask('api', { status: 'reviewing', review: awaitingReview('api') });
    expect(code(failed)).toBe('io');
    expect(store.state.tasks[0]?.status).toBe('working');
    // A real crash would also leave the temporary file behind.
    writeFileSync(join(runFolder(home), tempName('state.json')), '{"half": ');
    const loaded = await loadRun(home, RUN);
    expect(loaded.ok && loaded.value.state.tasks[0]?.status).toBe('working');
    await store.close();
    const reopened = await openRun(home, RUN, { now });
    if (!reopened.ok) throw new Error(reopened.problem.message);
    stores.push(reopened.value.store);
    expect(reopened.value.notes.join(' ')).toMatch(/Removed 1 leftover temporary file/);
    expect(readdirSync(runFolder(home)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(reopened.value.store.state).toEqual(store.state);
  });

  it('refuses writes after close, and a second open in the same process', async () => {
    const home = tempHome();
    const store = await create(home);
    expect(code(await openRun(home, RUN))).toBe('busy');
    expect(code(await removeRun(home, RUN))).toBe('busy');
    await store.close();
    expect(code(await store.updateTask('api', { status: 'working' }))).toBe('closed');
    expect(code(await store.appendLog({ kind: 'note', message: 'late' }))).toBe('closed');
    expect(code(await store.openOutput('api', 0, 'stdout'))).toBe('closed');
    const reopened = await openRun(home, RUN);
    expect(code(reopened)).toBe('ok');
    if (reopened.ok) stores.push(reopened.value.store);
  });
});

describe('the log', () => {
  it('drops a partial last line on read, and openRun removes it and records that', async () => {
    const home = tempHome();
    const store = await create(home);
    await store.appendLog({ kind: 'note', message: 'kept' });
    await store.close();
    const logPath = join(runFolder(home), 'log.jsonl');
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}{"v":1,"at":"20`);
    const read = await readRunLog(home, RUN);
    expect(read.ok && read.value.partialLastLine).toBe(true);
    expect(read.ok && read.value.records.map((r) => r.kind)).toEqual(['run-created', 'note']);
    const reopened = await openRun(home, RUN, { now });
    if (!reopened.ok) throw new Error(reopened.problem.message);
    stores.push(reopened.value.store);
    expect(reopened.value.notes.join(' ')).toMatch(/partial last line \(15 bytes\)/);
    await reopened.value.store.appendLog({ kind: 'note', message: 'after' });
    const after = await readRunLog(home, RUN);
    expect(after.ok && after.value.records.map((r) => r.kind)).toEqual(['run-created', 'note', 'log-repaired', 'note']);
    expect(after.ok && after.value.partialLastLine).toBe(false);
  });

  it('applies the size cap and marks what was left out', async () => {
    const home = tempHome();
    const store = await create(home, sampleReady(TASKS), { maxLogBytes: 4096 });
    for (let i = 0; i < 60; i++) expect(code(await store.appendLog({ kind: 'note', message: `step ${i} ${'.'.repeat(80)}` }))).toBe('ok');
    const read = await readRunLog(home, RUN, { maxLogBytes: 4096 });
    expect(read.ok && read.value.truncated).toBe(true);
    expect(read.ok && read.value.records[0]?.kind).toBe('run-created');
  });

  it('refuses a log record that does not match its kind', async () => {
    const store = await create(tempHome());
    expect(code(await store.appendLog({ kind: 'merge', task: 'api', merged: true, tip: 'abc', files: 1, refused: null }))).toBe('invalid');
  });
});

describe('task files', () => {
  it('saves and reads back a gate, without the integrity baseline', async () => {
    const home = tempHome();
    const store = await create(home);
    expect(code(await store.saveGate('api', 0, GATE))).toBe('ok');
    const read = await readGate(home, RUN, 'api', 0);
    const { baseline: _baseline, ...integrity } = GATE.integrity;
    expect(read.ok && read.value).toEqual({ ...GATE, integrity });
    expect(await readGate(home, RUN, 'api', 1)).toEqual({ ok: true, value: null });
    expect(await readGate(home, RUN, 'ui', 0)).toEqual({ ok: true, value: null });
  });

  it('saves and reads back the last finalize report', async () => {
    const home = tempHome();
    const store = await create(home);
    expect(await readFinalizeReport(home, RUN)).toEqual({ ok: true, value: null });
    expect(code(await store.saveFinalizeReport(REPORT))).toBe('ok');
    expect(await readFinalizeReport(home, RUN)).toEqual({ ok: true, value: REPORT });
    expect(code(await store.saveFinalizeReport({ ...REPORT, runId: '20261121-120000-zzzz' }))).toBe('invalid');
  });

  it("refuses another run's finalize report copied into this run", async () => {
    const home = tempHome();
    const other = '20261121-130000-othr';
    const otherStore = await create(home, sampleReady(TASKS), {}, other);
    await otherStore.saveFinalizeReport({ ...REPORT, runId: other });
    await (await create(home)).close();
    writeFileSync(join(runFolder(home), 'finalize.json'), readFileSync(join(runFolder(home, other), 'finalize.json')));
    const read = await readFinalizeReport(home, RUN);
    expect(read.ok ? 'ok' : read.problem.message).toMatch(/belongs to run "20261121-130000-othr"/);
  });

  it('keeps worker output capped, with a marker, and reads it back', async () => {
    const home = tempHome();
    const store = await create(home, sampleReady(TASKS), { maxOutputBytes: 400 });
    const out = await store.openOutput('api', 0, 'stdout');
    if (!out.ok) throw new Error(out.problem.message);
    for (let i = 0; i < 100; i++) out.value.write(`{"event":${i}}\n`);
    const closed = await out.value.close();
    expect(closed.ok && closed.value.truncated).toBe(true);
    const read = await readOutput(home, RUN, 'api', 0, 'stdout', { maxOutputBytes: 400 });
    expect(read.ok && read.value.truncated).toBe(true);
    expect(read.ok && read.value?.data.toString('utf8')).toMatch(/^\{"event":0\}\n[\s\S]*bytes left out by Orchestra[\s\S]*\{"event":99\}\n$/);
    expect(await readOutput(home, RUN, 'api', 0, 'stderr')).toEqual({ ok: true, value: null });
  });

  it('refuses odd task ids and rounds', async () => {
    const home = tempHome();
    const store = await create(home);
    expect(code(await store.saveGate('API', 0, GATE))).toBe('bad-name');
    expect(code(await store.saveGate('docs', 0, GATE))).toBe('bad-name');
    expect(code(await store.saveGate('con', 0, GATE))).toBe('bad-name');
    expect(code(await store.saveGate('../x', 0, GATE))).toBe('bad-name');
    for (const round of [-1, 100, 1.5, Number.NaN]) {
      expect(code(await store.saveGate('api', round, GATE))).toBe('bad-name');
      expect(code(await store.openOutput('api', round, 'stdout'))).toBe('bad-name');
      expect(code(await readGate(home, RUN, 'api', round))).toBe('bad-name');
    }
    expect(code(await readGate(home, RUN, 'A/B', 0))).toBe('bad-name');
    expect(code(await readDiff(home, RUN, 'api', -1))).toBe('bad-name');
    expect(code(await readOutput(home, RUN, '..', 0, 'stdout'))).toBe('bad-name');
  });

  it('reports a damaged gate file and a gate file of another round', async () => {
    const home = tempHome();
    const store = await create(home);
    await store.saveGate('api', 0, GATE);
    const folder = join(runFolder(home), 'tasks', 'api');
    writeFileSync(join(folder, 'gate-1.json'), readFileSync(join(folder, 'gate-0.json')));
    const other = await readGate(home, RUN, 'api', 1);
    expect(other.ok ? 'ok' : other.problem.message).toMatch(/another run, task or round/);
    writeFileSync(join(folder, 'gate-2.json'), '{"schemaVersion": 1, "gate": ');
    expect(code(await readGate(home, RUN, 'api', 2))).toBe('corrupt');
  });
});

function readyFor(fx: Fixture): ReadyPlan {
  const plan = samplePlan(TASKS, fx.base, fx.repo.dir);
  return { plan, planHash: sha256Of(plan), repoRoot: fx.ctx.repoRoot, gitCommonDir: fx.ctx.commonDir };
}

describe('saveDiff', () => {
  it("saves the diff of a task's commit: the changed files first, then the patch", async () => {
    const fx = f.make({ files: { 'README.md': 'hello\n' } });
    fx.repo.write('src/api/a.ts', 'export const a = 1;\n');
    const commit = fx.repo.commitAll('task work');
    const store = await create(fx.home, readyFor(fx));
    const saved = await store.saveDiff(fx.ctx, 'api', 0, fx.base, commit);
    expect(saved.ok && saved.value.truncated).toBe(false);
    const read = await readDiff(fx.home, RUN, 'api', 0);
    if (!read.ok || read.value === null) throw new Error('no diff');
    expect(read.value.truncated).toBe(false);
    expect(read.value.text).toMatch(/^:000000 100644 0{40} [0-9a-f]{40} A\tsrc\/api\/a\.ts\n\ndiff --git a\/src\/api\/a\.ts b\/src\/api\/a\.ts\n/);
    expect(read.value.text).toContain('+export const a = 1;');
  });

  it('cuts a large diff and marks it', async () => {
    const fx = f.make();
    fx.repo.write('src/api/big.txt', 'line\n'.repeat(5000));
    const commit = fx.repo.commitAll('big');
    const store = await create(fx.home, readyFor(fx), { maxDiffBytes: 1000 });
    const saved = await store.saveDiff(fx.ctx, 'api', 0, fx.base, commit);
    expect(saved.ok && saved.value).toEqual({ bytes: expect.any(Number), truncated: true });
    const read = await readDiff(fx.home, RUN, 'api', 0, { maxDiffBytes: 1000 });
    expect(read.ok && read.value.truncated).toBe(true);
    expect(read.ok && read.value?.text).toMatch(/\[\.\.\. diff cut at 1000 bytes by Orchestra \.\.\.\]\n$/);
  });

  it("refuses commits that aren't full ids, another repository, and git failures", async () => {
    const fx = f.make();
    const other = f.make();
    const store = await create(fx.home, readyFor(fx));
    expect(code(await store.saveDiff(fx.ctx, 'api', 0, 'HEAD', fx.base))).toBe('invalid');
    expect(code(await store.saveDiff(other.ctx, 'api', 0, fx.base, fx.base))).toBe('invalid');
    expect(code(await store.saveDiff(fx.ctx, 'api', 0, fx.base, SHA('e')))).toBe('git-failed');
  });
});

describe('corrupt and foreign files', () => {
  async function stateCode(mutate: (folder: string) => void): Promise<{ code: string; message: string }> {
    const home = tempHome();
    await (await create(home)).close();
    mutate(runFolder(home));
    const loaded = await loadRun(home, RUN);
    return loaded.ok ? { code: 'ok', message: '' } : loaded.problem;
  }

  it('reports corrupt JSON, the wrong format version and a missing file clearly', async () => {
    const corrupt = await stateCode((d) => writeFileSync(join(d, 'state.json'), '{"schemaVersion": 1, "runId": '));
    expect(corrupt).toEqual({ code: 'corrupt', message: expect.stringMatching(/state\.json of run .* is not valid JSON/) });
    const version = await stateCode((d) => {
      const state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')) as object;
      writeFileSync(join(d, 'state.json'), JSON.stringify({ ...state, schemaVersion: 2 }));
    });
    expect(version).toEqual({ code: 'wrong-version', message: expect.stringMatching(/another version of Orchestra \(format 2; this version reads format 1\)/) });
    const shape = await stateCode((d) => writeFileSync(join(d, 'state.json'), JSON.stringify({ schemaVersion: 1, tasks: 'all done' })));
    expect(shape).toEqual({ code: 'corrupt', message: expect.stringMatching(/not in the expected format/) });
    const plan = await stateCode((d) => writeFileSync(join(d, 'plan.json'), '[]'));
    expect(plan.code).toBe('corrupt');
    const missing = await stateCode((d) => rmSync(join(d, 'state.json')));
    expect(missing.code).toBe('missing');
  });

  it('refuses a plan changed after approval and a state that does not fit it', async () => {
    const widened = await stateCode((d) => {
      const record = JSON.parse(readFileSync(join(d, 'plan.json'), 'utf8')) as { plan: { tasks: Array<{ owns: string[] }> } };
      record.plan.tasks[0]!.owns = ['src/'];
      writeFileSync(join(d, 'plan.json'), JSON.stringify(record));
    });
    expect(widened).toEqual({ code: 'inconsistent', message: expect.stringMatching(/changed after approval/) });
    const accepted = await stateCode((d) => {
      const state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')) as RunState;
      const forged = acceptedReview('api');
      const tampered = { ...forged, attempts: [{ ...forged.attempts[0]!, gate: { passed: false, summary: 'failed' } }] };
      state.tasks[0] = { ...state.tasks[0]!, status: 'accepted', commit: SHA('1'), review: tampered };
      writeFileSync(join(d, 'state.json'), JSON.stringify(state));
    });
    expect(accepted).toEqual({ code: 'inconsistent', message: expect.stringMatching(/does not follow the review rules/) });
  });

  it('reports a file too large to be one of its own', async () => {
    const home = tempHome();
    const store = await create(home);
    await store.close();
    writeFileSync(join(runFolder(home), 'finalize.json'), Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
    expect(code(await readFinalizeReport(home, RUN))).toBe('too-large');
  });
});

describe('findings of the independent review', () => {
  it('refuses a run setup edited in plan.json, alone or with a new setup hash', async () => {
    const home = tempHome();
    await (await create(home)).close();
    const planPath = join(runFolder(home), 'plan.json');
    const original = readFileSync(planPath, 'utf8');
    const record = JSON.parse(original) as PlanRecord;
    writeFileSync(planPath, JSON.stringify({ ...record, hooks: 'on' }));
    const flipped = await loadRun(home, RUN);
    expect(flipped.ok ? 'ok' : flipped.problem.message).toMatch(/run setup .* does not match its hash/);
    const rehashed = { ...record, hooks: 'on' as const };
    writeFileSync(planPath, JSON.stringify({ ...rehashed, setupHash: setupHashOf(rehashed) }));
    const loaded = await loadRun(home, RUN);
    expect(loaded.ok ? 'ok' : loaded.problem.message).toMatch(/different run setup/);
    writeFileSync(planPath, original);
    expect(code(await loadRun(home, RUN))).toBe('ok');
  });

  it('saves a review state built from a full gate result, as the call order says', async () => {
    const home = tempHome();
    const store = await create(home);
    const task = store.record.plan.tasks[0]!;
    const step = recordGate(newTaskReview(task, reviewSettingsOf(store.record)), GATE);
    if (!step.ok) throw new Error(step.error.message);
    expect(code(await store.updateTask('api', { status: 'reviewing', startSha: BASE, commit: SHA('1'), review: step.state }))).toBe('ok');
    const loaded = await loadRun(home, RUN);
    expect(loaded.ok && loaded.value.state.tasks[0]?.review?.attempts[0]?.gate).toEqual({ passed: true, summary: GATE.summary });
  });

  it('keeps the review settings it was given, and refuses a revision limit it cannot name files for', async () => {
    const home = tempHome();
    const threshold = { blockingSeverities: ['blocker' as const], unknownBlocks: false };
    const created = await createRun(home, { runId: RUN, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true, review: { maxRevisionRounds: 1, threshold } });
    if (!created.ok) throw new Error(created.problem.message);
    stores.push(created.value);
    expect(reviewSettingsOf(created.value.record)).toEqual({ maxRevisionRounds: 1, threshold });
    for (const maxRevisionRounds of [100, 1.5, -1]) {
      const bad = await createRun(tempHome(), { runId: RUN, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true, review: { maxRevisionRounds } });
      expect(bad.ok ? 'ok' : bad.problem.message).toMatch(/whole number from 0 to 99/);
    }
  });

  it('cuts command outputs so that a large gate and finalize report still fit their files', async () => {
    const home = tempHome();
    const limits = { gate: 64 * 1024, finalize: 64 * 1024 };
    const store = await create(home, sampleReady(TASKS), { maxFileBytes: limits });
    const noisy = `START${'\u0001'.repeat(100_000)}END`;
    const command = { ...GATE.acceptance.commands[0]!, stdout: { text: noisy, totalBytes: noisy.length, truncated: false } };
    const big: GateResult = { ...GATE, acceptance: { passed: true, commands: [command, command, command, command] } };
    expect(code(await store.saveGate('api', 0, big))).toBe('ok');
    expect(readFileSync(join(runFolder(home), 'tasks', 'api', 'gate-0.json')).length).toBeLessThanOrEqual(limits.gate);
    const read = await readGate(home, RUN, 'api', 0, { maxFileBytes: limits });
    const out = read.ok ? read.value?.acceptance.commands[0]?.stdout : undefined;
    expect(out?.truncated).toBe(true);
    expect(out?.text).toMatch(/^START[\s\S]*characters left out by Orchestra[\s\S]*END$/);
    const report: FinalizeReport = {
      ...REPORT,
      acceptance: { passed: true, tip: BASE, tasks: [{ id: 'api', passed: true, commands: [command, command] }], gate: big, problem: null, cleanup: [] },
    };
    expect(code(await store.saveFinalizeReport(report))).toBe('ok');
    const final = await readFinalizeReport(home, RUN, { maxFileBytes: limits });
    expect(final.ok && final.value?.acceptance?.gate?.acceptance.commands[0]?.stdout.truncated).toBe(true);
    expect(final.ok && final.value?.acceptance?.gate?.integrity).toEqual({ ok: true, violations: [] });
  });

  it('close waits for queued writes and closes open outputs before releasing the run', async () => {
    const home = tempHome();
    const store = await create(home);
    const out = await store.openOutput('api', 0, 'stdout');
    if (!out.ok) throw new Error(out.problem.message);
    out.value.write('still writing');
    const pending = store.updateTask('api', { status: 'working', startSha: BASE });
    const closing = store.close();
    expect(code(await openRun(home, RUN))).toBe('busy');
    await closing;
    expect(code(await pending)).toBe('ok');
    expect(out.value.isClosed).toBe(true);
    expect(readFileSync(join(runFolder(home), 'tasks', 'api', 'worker-0.out'), 'utf8')).toBe('still writing');
    const reopened = await openRun(home, RUN);
    expect(code(reopened)).toBe('ok');
    if (reopened.ok) stores.push(reopened.value.store);
  });

  it('close keeps the run claimed until a slow write already queued has finished', async () => {
    const home = tempHome();
    let unblock: () => void = () => undefined;
    let slow = false;
    const store = await create(home, sampleReady(TASKS), {
      rename: async (from, to) => {
        if (slow) await new Promise<void>((done) => (unblock = done));
        await rename(from, to);
      },
    });
    slow = true;
    const pending = store.updateTask('api', { status: 'working', startSha: BASE });
    let closed = false;
    const closing = store.close().then(() => (closed = true));
    await new Promise((done) => setTimeout(done, 50));
    expect(closed).toBe(false);
    expect(code(await openRun(home, RUN))).toBe('busy');
    unblock();
    await closing;
    expect(code(await pending)).toBe('ok');
    const reopened = await openRun(home, RUN);
    expect(reopened.ok && reopened.value.store.state.tasks[0]?.status).toBe('working');
    if (reopened.ok) stores.push(reopened.value.store);
  });

  it('lets only one of two opens at the same time have the run', async () => {
    const home = tempHome();
    await (await create(home)).close();
    const results = await Promise.all([openRun(home, RUN), openRun(home, RUN)]);
    expect(results.map(code).sort()).toEqual(['busy', 'ok']);
    for (const r of results) if (r.ok) stores.push(r.value.store);
  });

  it('checks the output stream name at run time', async () => {
    const home = tempHome();
    const store = await create(home);
    for (const name of ['gate', '__proto__', 'constructor']) {
      expect(code(await store.openOutput('api', 0, name as 'stdout'))).toBe('bad-name');
      expect(code(await readOutput(home, RUN, 'api', 0, name as 'stdout'))).toBe('bad-name');
    }
  });
});

describe('links in the run folder', () => {
  it('refuses a link in place of runs/', async () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, 'runs'), 'junction');
    const created = await createRun(home, { runId: RUN, ready: sampleReady(TASKS), hooks: 'off', caseInsensitivePaths: true });
    expect(code(created)).toBe('link');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(code(await listRuns(home))).toBe('link');
    expect(code(await removeRun(home, RUN))).toBe('link');
    expect((await removeLeftovers(home)).problems).toHaveLength(1);
  });

  it('refuses a link in place of the run folder, for reading and for writing', async () => {
    const home = tempHome();
    const store = await create(home);
    const moved = join(home, 'moved');
    await rename(runFolder(home), moved);
    symlinkSync(moved, runFolder(home), 'junction');
    expect(code(await loadRun(home, RUN))).toBe('link');
    expect(code(await readRunLog(home, RUN))).toBe('link');
    expect(code(await store.updateTask('api', { status: 'working', startSha: BASE }))).toBe('link');
    expect(code(await store.appendLog({ kind: 'note', message: 'x' }))).toBe('link');
    expect(code(await store.saveFinalizeReport(REPORT))).toBe('link');
    expect(JSON.parse(readFileSync(join(moved, 'state.json'), 'utf8')).tasks[0].status).toBe('waiting');
  });

  it("refuses a link in place of tasks/ or a task's folder, and writes nothing through it", async () => {
    const home = tempHome();
    const store = await create(home);
    const users = join(home, 'users-files');
    mkdirSync(users);
    rmSync(join(runFolder(home), 'tasks'), { recursive: true });
    symlinkSync(users, join(runFolder(home), 'tasks'), 'junction');
    expect(code(await store.saveGate('api', 0, GATE))).toBe('link');
    expect(code(await store.openOutput('api', 0, 'stdout'))).toBe('link');
    expect(code(await readGate(home, RUN, 'api', 0))).toBe('link');
    expect(readdirSync(users)).toEqual([]);
    await store.close();
    expect(code(await openRun(home, RUN))).toBe('link');

    unlinkSync(join(runFolder(home), 'tasks'));
    mkdirSync(join(runFolder(home), 'tasks', 'ui'), { recursive: true });
    symlinkSync(users, join(runFolder(home), 'tasks', 'api'), 'junction');
    const reopened = await openRun(home, RUN);
    expect(code(reopened)).toBe('link');
  });

  it('stops writing worker output when its folder becomes a link', async () => {
    const home = tempHome();
    const store = await create(home);
    const out = await store.openOutput('api', 0, 'stdout');
    if (!out.ok) throw new Error(out.problem.message);
    const users = join(home, 'users-files');
    mkdirSync(users);
    await rename(join(runFolder(home), 'tasks', 'api'), join(home, 'old-api'));
    symlinkSync(users, join(runFolder(home), 'tasks', 'api'), 'junction');
    out.value.write('secret-ish output');
    expect((await out.value.flush())?.code).toBe('link');
    expect(readdirSync(users)).toEqual([]);
  });
});

describe('a home with spaces and non-ASCII characters', () => {
  it('creates, writes, reads, lists and removes runs', async () => {
    const fx = f.make({ homeName: 'Orchestra Hôme ünïcode 文件' });
    fx.repo.write('src/api/a.ts', 'a\n');
    const commit = fx.repo.commitAll('work');
    const store = await create(fx.home, readyFor(fx));
    expect(code(await store.updateTask('api', { status: 'working', startSha: fx.base }))).toBe('ok');
    expect(code(await store.saveGate('api', 0, GATE))).toBe('ok');
    expect(code(await store.saveDiff(fx.ctx, 'api', 0, fx.base, commit))).toBe('ok');
    const loaded = await loadRun(fx.home, RUN);
    expect(loaded.ok && loaded.value.state.tasks[0]?.status).toBe('working');
    expect(await listRuns(fx.home)).toEqual({ ok: true, value: { runs: [RUN], odd: [], leftovers: [] } });
    await store.close();
    expect(await removeRun(fx.home, RUN)).toEqual({ ok: true, value: { removed: true, notes: [] } });
    expect(existsSync(join(fx.home, 'runs', RUN))).toBe(false);
  });
});

describe('listRuns, removeLeftovers and removeRun', () => {
  it('lists valid runs in order and reports everything else', async () => {
    const home = tempHome();
    expect(await listRuns(home)).toEqual({ ok: true, value: { runs: [], odd: [], leftovers: [] } });
    const later = '20261121-130000-wxyz';
    await (await create(home, sampleReady(TASKS), {}, later)).close();
    await (await create(home)).close();
    const runs = join(home, 'runs');
    mkdirSync(join(runs, 'Not-A-Run'));
    writeFileSync(join(runs, '20261121-140000-file'), 'x');
    mkdirSync(join(home, 'elsewhere'));
    symlinkSync(join(home, 'elsewhere'), join(runs, '20261121-150000-link'), 'junction');
    mkdirSync(join(runs, tempName('20261121-160000-half')));
    expect(await listRuns(home)).toEqual({
      ok: true,
      value: {
        runs: [RUN, later],
        odd: [
          { name: '20261121-140000-file', reason: 'not a folder' },
          { name: '20261121-150000-link', reason: 'a link, not a real folder' },
          { name: 'Not-A-Run', reason: 'not a valid run id' },
        ],
        leftovers: [expect.stringMatching(/^\.20261121-160000-half\.[0-9a-f]{12}\.tmp$/)],
      },
    });
    expect(await removeLeftovers(home)).toEqual({ removed: 1, problems: [] });
    expect((await listRuns(home)).ok && (await listRuns(home))).toMatchObject({ value: { leftovers: [] } });
    expect(await removeLeftovers(tempHome())).toEqual({ removed: 0, problems: [] });
  });

  it('removes a run folder, and only the link when a link was put in its place', async () => {
    const home = tempHome();
    await (await create(home)).close();
    expect(await removeRun(home, RUN)).toEqual({ ok: true, value: { removed: true, notes: [] } });
    expect(await removeRun(home, RUN)).toEqual({ ok: true, value: { removed: false, notes: [] } });
    expect(await removeRun(tempHome(), RUN)).toEqual({ ok: true, value: { removed: false, notes: [] } });

    const users = join(home, 'users-files');
    mkdirSync(users);
    writeFileSync(join(users, 'precious.txt'), 'keep me');
    symlinkSync(users, runFolder(home), 'junction');
    const removed = await removeRun(home, RUN);
    expect(removed.ok && removed.value.notes.join(' ')).toMatch(/only the link was removed/);
    expect(readFileSync(join(users, 'precious.txt'), 'utf8')).toBe('keep me');

    writeFileSync(runFolder(home), 'a file');
    const file = await removeRun(home, RUN);
    expect(file.ok && file.value.notes.join(' ')).toMatch(/was a file/);
    expect(existsSync(runFolder(home))).toBe(false);
  });
});

describe('openRun', () => {
  it('reads back a run created earlier, in another process', async () => {
    const home = tempHome();
    const store = await create(home);
    await store.updateTask('api', { status: 'working', startSha: BASE });
    await store.appendLog({ kind: 'task-status', task: 'api', status: 'working', reason: null });
    await store.close();
    const reopened = await openRun(home, RUN);
    if (!reopened.ok) throw new Error(reopened.problem.message);
    stores.push(reopened.value.store);
    expect(reopened.value.notes).toEqual([]);
    expect(reopened.value.store.state).toEqual(store.state);
    expect(reopened.value.store.record).toEqual(store.record);
  });

  it('does not open a damaged run', async () => {
    const home = tempHome();
    await (await create(home)).close();
    writeFileSync(join(runFolder(home), 'log.jsonl'), serializeRecord({ v: 1, at: NOW.toISOString(), kind: 'note', message: 'x' }));
    writeFileSync(join(runFolder(home), 'state.json'), 'garbage');
    expect(code(await openRun(home, RUN))).toBe('corrupt');
    expect(code(await openRun(home, 'BAD'))).toBe('bad-name');
  });

  it('reports a missing log', async () => {
    const home = tempHome();
    await (await create(home)).close();
    rmSync(join(runFolder(home), 'log.jsonl'));
    expect(code(await readRunLog(home, RUN))).toBe('missing');
    expect(code(await openRun(home, RUN))).toBe('missing');
  });
});
