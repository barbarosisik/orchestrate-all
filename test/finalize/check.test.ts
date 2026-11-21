import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearFinalizeCheck, finalizeCheckMessage, finalizeChecks, type FinalizeInput } from '../../src/finalize/check.js';
import { formatFinalizeReport } from '../../src/finalize/report.js';
import { createCheckWorktree } from '../../src/worktree/manager.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';
import { mergedRun, node, plumbingCommit, runTask, userCommit, type MergedRun } from '../helpers/run.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const FILES = { 'README.md': 'hello\n', 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n', 'src/core/c.ts': 'c\n' };
const integrity = { globalGitFiles: [] };
const FINALIZE_REF = 'refs/heads/orchestra/run1/finalize';

/** Fails when two routes files under src/ name the same route. */
const NO_DUPLICATE_ROUTES = node(
  "const fs=require('fs');const seen=new Set();" +
    "for(const d of ['src/api','src/web','src/core']){const f=d+'/routes.txt';if(!fs.existsSync(f))continue;" +
    "for(const r of fs.readFileSync(f,'utf8').split('\\n').filter(Boolean)){" +
    "if(seen.has(r)){console.error('duplicate route '+r);process.exit(1)}seen.add(r)}}",
);

const api = runTask('api', ['src/api/'], [NO_DUPLICATE_ROUTES]);
const web = runTask('web', ['src/web/'], [NO_DUPLICATE_ROUTES]);
const docs = runTask('docs', ['docs/'], []);

async function twoTasks(fx: Fixture): Promise<MergedRun> {
  return mergedRun(fx, 'run1', [
    { task: api, files: { 'src/api/a.ts': 'api v2\n', 'src/api/routes.txt': '/health\n' } },
    { task: docs, files: {} },
    { task: web, files: { 'src/web/w.ts': null, 'src/web/routes.txt': '/home\n' } },
  ]);
}

function input(fx: Fixture, run: MergedRun): FinalizeInput {
  return { runId: 'run1', targetBranch: 'main', baseSha: fx.base, integrationTip: run.tip, merged: run.merged };
}

function codes(report: { problems: readonly { code: string }[] }): string[] {
  return report.problems.map((p) => p.code);
}

/** Nothing of the check is left: no finalize branch, no check worktree. */
function expectNothingLeft(fx: Fixture): void {
  expect(fx.repo.git('for-each-ref', '--format=%(refname)', FINALIZE_REF)).toBe('');
  expect(existsSync(join(fx.home, 'wt', 'run1', 'finalize'))).toBe(false);
}

describe('finalizeChecks', () => {
  it('reports a run ready to approve, and changes nothing of the user’s', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });

    expect(report.problems).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.target).toMatchObject({ branch: 'main', tip: fx.base, moved: false, newCommits: 0, overlap: [] });
    expect(report.target?.tree).toBe(fx.repo.git('rev-parse', `${run.tip}^{tree}`));
    expect(report.target?.changes.map((c) => `${c.status} ${c.path}`)).toEqual([
      'M src/api/a.ts',
      'A src/api/routes.txt',
      'A src/web/routes.txt',
      'D src/web/w.ts',
    ]);
    expect(report.checkouts).toEqual([fx.ctx.repoRoot]);
    expect(report.tasks.map((t) => [t.id, t.mergeCommit === null, t.changes.length, t.acceptance?.passed])).toEqual([
      ['api', false, 2, true],
      ['docs', true, 0, true],
      ['web', false, 2, true],
    ]);
    expect(report.acceptance).toMatchObject({ passed: true, problem: null, cleanup: [] });
    expect(report.notes).toEqual([]);

    expect(fx.repo.git('rev-parse', 'main')).toBe(fx.base);
    expect(fx.repo.git('status', '--porcelain')).toBe('');
    expectNothingLeft(fx);
  });

  it('tests exactly what the branch would hold: the user’s new commits included', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    // The user's own new route clashes with the run's: each side passes alone.
    const userTip = userCommit(fx, { 'src/core/routes.txt': '/health\n' });
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });

    expect(report.ready).toBe(false);
    expect(codes(report)).toEqual(['acceptance']);
    expect(report.target).toMatchObject({ tip: userTip, moved: true, newCommits: 1 });
    expect(report.tasks.map((t) => [t.id, t.acceptance?.passed])).toEqual([
      ['api', false],
      ['docs', true],
      ['web', false],
    ]);
    expect(report.acceptance?.tasks[0]?.commands[0]?.stderr.text).toContain('duplicate route /health');
    expect(report.problems[0]?.message).toContain('api, web');
    expect(fx.repo.git('rev-parse', 'main')).toBe(userTip);
    expectNothingLeft(fx);
  });

  it('passes on a moved branch whose new commits merge cleanly, noting files both sides changed', async () => {
    const fx = f.make({ files: { ...FILES, 'src/api/a.ts': 'one\ntwo\nthree\nfour\n' } });
    const run = await mergedRun(fx, 'run1', [{ task: api, files: { 'src/api/a.ts': 'one\ntwo\nthree\nFOUR\n' } }]);
    userCommit(fx, { 'src/api/a.ts': 'ONE\ntwo\nthree\nfour\n', 'README.md': 'user\n' });
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    expect(report.problems).toEqual([]);
    expect(report.notes).toEqual([expect.stringContaining('src/api/a.ts')]);
    expect(fx.repo.git('cat-file', 'blob', `${report.target?.tree}:src/api/a.ts`)).toBe('ONE\ntwo\nthree\nFOUR');
  });

  it('stops before testing when the branch moved and conflicts with the run', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    userCommit(fx, { 'src/api/a.ts': 'user version\n' });
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    expect(report.ready).toBe(false);
    expect(report.problems).toMatchObject([{ code: 'target-conflict', paths: ['src/api/a.ts'] }]);
    expect(report.acceptance).toBeNull();
    expect(report.tasks.map((t) => t.changes.length)).toEqual([2, 0, 2]);
    expectNothingLeft(fx);
  });

  it('reports unsaved work where finalizing would write, and still runs the tests', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    fx.repo.write('src/web/routes.txt', 'my own unsaved file\n');
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    expect(report.problems).toMatchObject([{ code: 'unsaved-work', paths: ['src/web/routes.txt'] }]);
    expect(report.acceptance?.passed).toBe(true);
  });

  it('refuses an integration branch that holds something other than the recorded merges', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    const sneaky = await plumbingCommit(fx, run.tip, { 'src/api/extra.ts': 'x\n' });
    fx.repo.git('update-ref', 'refs/heads/orchestra/run1/integration', sneaky);
    const report = await finalizeChecks(fx.ctx, { ...input(fx, run), integrationTip: sneaky }, { integrity });
    expect(codes(report)).toEqual(['history']);
    expect(report.target).toBeNull();
  });

  it('notices acceptance commands that move the integration branch', async () => {
    const fx = f.make({ files: FILES });
    const mover = runTask('mover', ['src/api/'], [['git', 'update-ref', 'refs/heads/orchestra/run1/integration', fx.base]]);
    const run = await mergedRun(fx, 'run1', [{ task: mover, files: { 'src/api/a.ts': 'v2\n' } }]);
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    expect(report.acceptance?.passed).toBe(true);
    expect(report.problems).toMatchObject([{ code: 'history', message: expect.stringContaining('After the checks') }]);
    expect(report.ready).toBe(false);
  });

  it('reports a run that would change nothing', async () => {
    const fx = f.make({ files: FILES });
    const run = await mergedRun(fx, 'run1', [{ task: docs, files: {} }]);
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    expect(codes(report)).toEqual(['nothing-to-finalize']);
  });

  it('refuses bad input before touching git', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    const twice = { ...input(fx, run), merged: [...run.merged, run.merged[0] as (typeof run.merged)[number]] };
    expect(codes(await finalizeChecks(fx.ctx, twice, { integrity }))).toEqual(['bad-input']);
    expect(codes(await finalizeChecks(fx.ctx, { ...input(fx, run), runId: 'Run 1' }, { integrity }))).toEqual(['bad-input']);
    expect(codes(await finalizeChecks(fx.ctx, { ...input(fx, run), baseSha: 'abc' }, { integrity }))).toEqual(['bad-input']);
  });

  it('clears what an interrupted check left behind, then checks again', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    fx.repo.git('update-ref', FINALIZE_REF, run.tip);
    const leftover = await createCheckWorktree(fx.ctx, { runId: 'run1', name: 'finalize', tip: run.tip });
    if (!leftover.ok) throw new Error(leftover.error.message);
    writeFileSync(join(leftover.worktree.path, 'build-output.txt'), 'x\n');

    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    expect(report.problems).toEqual([]);
    expectNothingLeft(fx);
    expect(await clearFinalizeCheck(fx.ctx, 'run1')).toEqual([]);
  });
});

describe('finalizeCheckMessage', () => {
  it('names the run', () => {
    expect(finalizeCheckMessage('run1')).toBe('Finalize check for Orchestra run run1\n\nOrchestra-Run: run1\n');
  });
});

describe('formatFinalizeReport', () => {
  it('says what the user is about to approve', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    const text = formatFinalizeReport(await finalizeChecks(fx.ctx, input(fx, run), { integrity }));
    expect(text).toContain('Finalize check, run run1 into main: ready to approve.');
    expect(text).toContain(`Your branch main is where the run started (${fx.base.slice(0, 12)}).`);
    expect(text).toContain('Checked out in');
    expect(text).toContain('  api: Task api (claude, test-model), merged as');
    expect(text).toContain('  docs: Task docs (claude, test-model), no changes, tests passed');
    expect(text).toContain('Files your branch would get (4):\n  M src/api/a.ts\n  A src/api/routes.txt');
    expect(text).toContain('Acceptance on the combined result: 1/1 commands passed; integrity ok.');
    expect(text).not.toContain('Problems:');
  });

  it('lists problems, failed tests and notes, and cuts long lists', async () => {
    const fx = f.make({ files: FILES });
    const run = await twoTasks(fx);
    userCommit(fx, { 'src/core/routes.txt': '/health\n' });
    const report = await finalizeChecks(fx.ctx, input(fx, run), { integrity });
    const text = formatFinalizeReport(report);
    expect(text).toContain('not ready (1 problem)');
    expect(text).toContain('has 1 new commit since the run started');
    expect(text).toContain('tests FAILED');
    expect(text).toContain(': failed (exit code 1)');
    expect(text).toContain('Problems:\n  - The acceptance checks failed');

    const many = Array.from({ length: 45 }, (_, i) => ({ ...(report.target?.changes[0] as never), path: `f${i}.ts`, status: 'A' }));
    const long = formatFinalizeReport({
      ...report,
      target: report.target === null ? null : { ...report.target, changes: many },
      notes: ['a note'],
      acceptance: null,
    });
    expect(long).toContain('  ... and 5 more');
    expect(long).toContain('Notes:\n  - a note');
    expect(long).not.toContain('Acceptance on the combined result');
  });
});

describe('formatFinalizeReport, without git', () => {
  const output = { text: '', totalBytes: 0, truncated: false };
  const command = (argv: string[], status: 'passed' | 'failed' | 'timed-out' | 'not-started', more = {}) => ({
    argv,
    program: argv[0] ?? null,
    status,
    exitCode: status === 'passed' ? 0 : null,
    signal: null,
    durationMs: 1,
    stdout: output,
    stderr: output,
    error: null,
    ...more,
  });

  it('describes every command result and a report with no preview', () => {
    const commands = [
      command(['npm', 'test'], 'timed-out'),
      command(['npx', 'lint'], 'not-started', { error: 'npx was not found in PATH' }),
      command(['make'], 'not-started'),
      command(['node', 'x.js'], 'failed', { signal: 'SIGKILL' }),
    ];
    const text = formatFinalizeReport({
      ready: false,
      runId: 'run1',
      targetBranch: 'main',
      baseSha: 'a'.repeat(40),
      integrationTip: 'b'.repeat(40),
      target: null,
      tasks: [],
      checkouts: [],
      acceptance: {
        passed: false,
        tip: 'c'.repeat(40),
        tasks: [],
        problem: null,
        cleanup: [],
        gate: {
          passed: false,
          acceptance: { passed: false, commands },
          integrity: { ok: true, violations: [], baseline: {} as never },
          added: [],
          trackedChanged: [],
          scopeProblem: null,
          summary: '0/4 commands passed; integrity ok',
        },
      },
      problems: [{ code: 'history', message: 'The integration branch moved.', paths: [] }],
      notes: [],
    });
    expect(text).toContain('not ready (1 problem)');
    expect(text).toContain('Tasks (0):');
    expect(text).not.toContain('Your branch');
    expect(text).not.toContain('Files your branch would get');
    expect(text).toContain('npm test: stopped after the time limit');
    expect(text).toContain('npx lint: did not start (npx was not found in PATH)');
    expect(text).toContain('make: did not start (unknown reason)');
    expect(text).toContain('node x.js: failed (exit code SIGKILL)');
    expect(text.endsWith('The integration branch moved.\n')).toBe(true);
  });
});
