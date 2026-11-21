import { afterEach, describe, expect, it } from 'vitest';
import { checkIntegrationHistory, commitsSince } from '../../src/finalize/history.js';
import { fixtures } from '../helpers/fixture.js';
import { mergedRun, plumbingCommit, runTask, userCommit, type MergedRun } from '../helpers/run.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const FILES = { 'README.md': 'hello\n', 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n' };
const REF = 'refs/heads/orchestra/run1/integration';

function recorded(run: MergedRun) {
  return run.merged.map((m) => ({ taskId: m.task.id, commit: m.commit, mergeCommit: m.mergeCommit }));
}

async function threeTasks() {
  const fx = f.make({ files: FILES });
  const run = await mergedRun(fx, 'run1', [
    { task: runTask('api', ['src/api/']), files: { 'src/api/a.ts': 'api v2\n', 'src/api/new.ts': 'new\n' } },
    { task: runTask('docs', ['docs/']), files: {} },
    { task: runTask('web', ['src/web/']), files: { 'src/web/w.ts': null } },
  ]);
  return { fx, run };
}

describe('checkIntegrationHistory', () => {
  it('accepts exactly the recorded merges and lists what each changed', async () => {
    const { fx, run } = await threeTasks();
    expect(run.merged.map((m) => m.mergeCommit === null)).toEqual([false, true, false]);
    const checked = await checkIntegrationHistory(fx.ctx, 'run1', fx.base, run.tip, recorded(run));
    if (!checked.ok) throw new Error(checked.message);
    expect(checked.tasks.map((t) => [t.taskId, t.changes.map((c) => `${c.status} ${c.path}`)])).toEqual([
      ['api', ['M src/api/a.ts', 'A src/api/new.ts']],
      ['docs', []],
      ['web', ['D src/web/w.ts']],
    ]);
  });

  it('accepts a run with nothing merged', async () => {
    const fx = f.make({ files: FILES });
    const run = await mergedRun(fx, 'run1', []);
    expect(await checkIntegrationHistory(fx.ctx, 'run1', fx.base, fx.base, recorded(run))).toEqual({ ok: true, tasks: [] });
  });

  it('refuses a branch that is not where it was recorded', async () => {
    const { fx, run } = await threeTasks();
    const extra = await plumbingCommit(fx, run.tip, { 'src/api/sneaky.ts': 'x\n' });
    fx.repo.git('update-ref', REF, extra);
    const checked = await checkIntegrationHistory(fx.ctx, 'run1', fx.base, run.tip, recorded(run));
    expect(checked).toMatchObject({ ok: false, message: expect.stringContaining('not at') });
  });

  it('refuses a commit added on top of the recorded merges, even when the tip is updated to match', async () => {
    const { fx, run } = await threeTasks();
    const extra = await plumbingCommit(fx, run.tip, { 'src/api/sneaky.ts': 'x\n' });
    fx.repo.git('update-ref', REF, extra);
    const checked = await checkIntegrationHistory(fx.ctx, 'run1', fx.base, extra, recorded(run));
    expect(checked).toMatchObject({ ok: false, message: expect.stringContaining('was recorded') });
  });

  it('refuses merges recorded in another order or with other task commits', async () => {
    const { fx, run } = await threeTasks();
    const swapped = [...recorded(run)].reverse();
    expect((await checkIntegrationHistory(fx.ctx, 'run1', fx.base, run.tip, swapped)).ok).toBe(false);

    const wrongCommit = recorded(run).map((m) => (m.taskId === 'web' ? { ...m, commit: fx.base } : m));
    expect(await checkIntegrationHistory(fx.ctx, 'run1', fx.base, run.tip, wrongCommit)).toMatchObject({
      ok: false,
      message: expect.stringContaining('recorded parents'),
    });
  });

  it('refuses a history that does not start at the base commit', async () => {
    const { fx, run } = await threeTasks();
    const other = userCommit(fx, { 'README.md': 'moved\n' });
    expect(await checkIntegrationHistory(fx.ctx, 'run1', other, run.tip, recorded(run))).toMatchObject({
      ok: false,
      message: expect.stringContaining('recorded parents'),
    });
    expect(await checkIntegrationHistory(fx.ctx, 'run1', other, run.tip, [])).toMatchObject({
      ok: false,
      message: expect.stringContaining("run's base commit"),
    });
  });

  it('refuses a missing integration branch or one turned into a link', async () => {
    const { fx, run } = await threeTasks();
    fx.repo.git('symbolic-ref', REF, 'refs/heads/main');
    expect(await checkIntegrationHistory(fx.ctx, 'run1', fx.base, run.tip, recorded(run))).toMatchObject({
      ok: false,
      message: expect.stringContaining('link'),
    });
    fx.repo.git('update-ref', '--no-deref', '-d', REF);
    expect(await checkIntegrationHistory(fx.ctx, 'run1', fx.base, run.tip, recorded(run))).toMatchObject({
      ok: false,
      message: expect.stringContaining('does not exist'),
    });
  });
});

describe('commitsSince', () => {
  it('counts the commits a branch gained', async () => {
    const fx = f.make({ files: FILES });
    userCommit(fx, { 'README.md': 'one\n' });
    const tip = userCommit(fx, { 'README.md': 'two\n' });
    expect(await commitsSince(fx.ctx, fx.base, tip)).toBe(2);
    expect(await commitsSince(fx.ctx, tip, tip)).toBe(0);
    expect(typeof (await commitsSince(fx.ctx, 'f'.repeat(40), tip))).toBe('string');
  });
});
