import { afterEach, describe, expect, it } from 'vitest';
import { previewFinalize } from '../../src/finalize/target.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';
import { mergedRun, plumbingCommit, runTask, userCommit } from '../helpers/run.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const FILES = {
  'README.md': 'hello\n',
  'notes.txt': 'one\ntwo\nthree\nfour\nfive\n',
  'src/api/a.ts': 'a\n',
  'src/web/w.ts': 'w\n',
};

async function run(fx: Fixture, files: Record<string, string | null> = { 'src/api/a.ts': 'api v2\n', 'src/api/new.ts': 'new\n' }) {
  return mergedRun(fx, 'run1', [{ task: runTask('api', ['src/api/', 'notes.txt']), files }]);
}

function code(result: Awaited<ReturnType<typeof previewFinalize>>): string {
  return result.ok ? 'ok' : result.problem.code;
}

describe('previewFinalize', () => {
  it('on an unchanged branch: the run’s tree and exactly the run’s changes', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx);
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    if (!result.ok) throw new Error(result.problem.message);
    expect(result.preview).toMatchObject({ branch: 'main', tip: fx.base, moved: false, newCommits: 0, overlap: [] });
    expect(result.preview.tree).toBe(fx.repo.git('rev-parse', `${tip}^{tree}`));
    expect(result.preview.changes.map((c) => `${c.status} ${c.path}`)).toEqual(['M src/api/a.ts', 'A src/api/new.ts']);
  });

  it('on a branch that moved: its own commits plus the run’s changes', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx);
    const userTip = userCommit(fx, { 'README.md': 'user edit\n' });
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    if (!result.ok) throw new Error(result.problem.message);
    expect(result.preview).toMatchObject({ tip: userTip, moved: true, newCommits: 1, overlap: [] });
    expect(result.preview.changes.map((c) => c.path)).toEqual(['src/api/a.ts', 'src/api/new.ts']);
    const tree = result.preview.tree;
    expect(fx.repo.git('cat-file', 'blob', `${tree}:README.md`)).toBe('user edit');
    expect(fx.repo.git('cat-file', 'blob', `${tree}:src/api/new.ts`)).toBe('new');
    // Nothing moved: the preview changes nothing.
    expect(fx.repo.git('rev-parse', 'main')).toBe(userTip);
  });

  it('lists files both sides changed when git merges them cleanly', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx, { 'notes.txt': 'one\ntwo\nthree\nfour\nFIVE\n' });
    userCommit(fx, { 'notes.txt': 'ONE\ntwo\nthree\nfour\nfive\n' });
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    if (!result.ok) throw new Error(result.problem.message);
    expect(result.preview.overlap).toEqual(['notes.txt']);
    expect(fx.repo.git('cat-file', 'blob', `${result.preview.tree}:notes.txt`)).toBe('ONE\ntwo\nthree\nfour\nFIVE');
  });

  it('refuses a conflict with the branch’s new commits and names the files', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx);
    userCommit(fx, { 'src/api/a.ts': 'user version\n' });
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    expect(result).toMatchObject({ ok: false, problem: { code: 'target-conflict', paths: ['src/api/a.ts'] } });
  });

  it('refuses a branch that no longer contains the run’s base commit', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx);
    const tree = fx.repo.git('rev-parse', `${fx.base}^{tree}`);
    const unrelated = fx.repo.git('commit-tree', tree, '-m', 'rewritten');
    fx.repo.git('update-ref', 'refs/heads/main', unrelated);
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    expect(code(result)).toBe('target-rewritten');
  });

  it('refuses a branch that already holds part of the run, merged in by hand', async () => {
    const fx = f.make({ files: FILES });
    const { tip, merged } = await run(fx);
    // The user merged the run's integration branch to try it, then reverted one of its files.
    fx.repo.git('merge', '-q', '--no-ff', '-m', 'try the run', 'orchestra/run1/integration');
    userCommit(fx, { 'src/api/a.ts': 'a\n' });
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    expect(result).toMatchObject({ ok: false, problem: { code: 'target-has-run-work' } });

    // The same for only a task's commit.
    fx.repo.git('reset', '-q', '--hard', fx.base);
    fx.repo.git('merge', '-q', '--no-ff', '-m', 'try the task', merged[0]?.commit ?? '');
    const partial = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    expect(code(partial)).toBe('target-has-run-work');
  });

  it('refuses new files that clash in letter case with the branch’s files', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx);
    // The user added src/api/NEW.ts; the run adds src/api/new.ts. Git merges both, but Windows and macOS can't
    // hold both files.
    fx.repo.git('update-ref', 'refs/heads/main', await plumbingCommit(fx, fx.base, { 'src/api/NEW.ts': 'x\n' }));
    const result = await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tip });
    expect(result).toMatchObject({ ok: false, problem: { code: 'case-clash', paths: ['src/api/new.ts'] } });
    if (!result.ok) expect(result.problem.message).toContain('src/api/NEW.ts / src/api/new.ts');
  });

  it('refuses a missing branch, a branch turned into a link and a bad name', async () => {
    const fx = f.make({ files: FILES });
    const { tip } = await run(fx);
    const input = { baseSha: fx.base, integrationTip: tip };
    expect(code(await previewFinalize(fx.ctx, { ...input, targetBranch: 'nope' }))).toBe('target-missing');
    fx.repo.git('symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    expect(code(await previewFinalize(fx.ctx, { ...input, targetBranch: 'alias' }))).toBe('target-link');
    expect(code(await previewFinalize(fx.ctx, { ...input, targetBranch: 'a..b' }))).toBe('bad-input');
  });

  it('refuses an integration tip that is not a commit', async () => {
    const fx = f.make({ files: FILES });
    const tree = fx.repo.git('rev-parse', `${fx.base}^{tree}`);
    expect(code(await previewFinalize(fx.ctx, { targetBranch: 'main', baseSha: fx.base, integrationTip: tree }))).toBe('bad-input');
  });
});
