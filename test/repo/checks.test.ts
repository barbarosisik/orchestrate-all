import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultValidationContext } from '../../src/config/defaults.js';
import { preparePlan } from '../../src/plan/prepare.js';
import { checkRepo } from '../../src/repo/checks.js';
import { validatePlan, type NormalizedPlan } from '../../src/plan/validate.js';
import { makeRepo, type TmpRepo } from '../helpers/tmprepo.js';

const ctx = defaultValidationContext(['claude']);
const repos: TmpRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

function repo(files?: Record<string, string>): TmpRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}

function planInput(dir: string, owns: string[] = ['src/api/'], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    goal: 'Build it.',
    repo: dir,
    targetBranch: 'main',
    orchestrator: { engine: 'claude', model: 'opus' },
    tasks: [
      {
        id: 'api',
        title: 'API',
        kind: 'work',
        mode: 'write',
        brief: 'Do it.',
        engine: 'claude',
        model: 'opus',
        owns,
        dependsOn: [],
        acceptance: { commands: [['npm', 'test']], criteria: [] },
      },
    ],
    ...extra,
  };
}

function normalized(dir: string, owns?: string[], extra?: Record<string, unknown>): NormalizedPlan {
  const result = validatePlan(planInput(dir, owns, extra), ctx);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.plan;
}

async function codes(plan: NormalizedPlan, allowedRepos: string[]): Promise<string[]> {
  const result = await checkRepo(plan, { allowedRepos });
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('checkRepo: a good repository', () => {
  it('fills in the base commit from the target branch and hashes the plan', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    const result = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ready.plan.baseSha).toBe(r.git('rev-parse', 'main'));
    expect(result.ready.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives a new hash when the branch moves', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    const first = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    r.write('docs/x.md');
    r.commitAll('move');
    const second = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(second.ready.planHash).not.toBe(first.ready.planHash);
  });

  it('ignores changes outside the owned paths', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n', 'docs/readme.md': 'r\n' });
    r.write('docs/readme.md', 'edited\n');
    r.write('notes/new.txt');
    expect(await codes(normalized(r.dir), [r.dir])).toEqual([]);
  });

  it('uses the target branch even when another branch is checked out', async () => {
    const r = repo();
    const mainSha = r.git('rev-parse', 'main');
    r.git('checkout', '-q', '-b', 'other');
    r.write('other.txt');
    r.commitAll('other');
    const result = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.ready.plan.baseSha).toBe(mainSha);
  });

  it('does not create an index lock or change the index', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    r.write('src/other.ts');
    const before = r.git('status', '--porcelain=v1');
    await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    expect(r.git('status', '--porcelain=v1')).toBe(before);
  });
});

describe('checkRepo: identity problems', () => {
  it('refuses a repo that is not on the allowlist', async () => {
    const r = repo();
    const other = repo();
    expect(await codes(normalized(r.dir), [other.dir])).toEqual(['repo-not-allowed']);
  });

  it('refuses a folder that does not exist', async () => {
    const missing = join(tmpdir(), 'orch-missing-repo-that-does-not-exist');
    expect(await codes(normalized(missing), [missing])).toEqual(['repo-missing']);
  });

  it('refuses a folder that is not a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-plain-'));
    try {
      expect(await codes(normalized(dir), [dir])).toEqual(['not-a-git-repo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a bare repository', async () => {
    const r = repo();
    const bareDir = mkdtempSync(join(tmpdir(), 'orch-bare-'));
    try {
      r.git('clone', '-q', '--bare', r.dir, bareDir);
      expect(await codes(normalized(bareDir), [bareDir])).toEqual(['bare-repo']);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('refuses a subfolder of a repo', async () => {
    const r = repo({ 'pkg/a.ts': 'a\n' });
    const sub = join(r.dir, 'pkg');
    expect(await codes(normalized(sub), [sub])).toEqual(['repo-not-toplevel']);
  });

  it('refuses a target branch that does not exist', async () => {
    const r = repo();
    expect(await codes(normalized(r.dir, ['src/api/'], { targetBranch: 'develop' }), [r.dir])).toEqual(['branch-missing']);
  });
});

describe('checkRepo: unsaved work under owned paths', () => {
  it('refuses an uncommitted edit inside an owned folder', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    r.write('src/api/a.ts', 'changed\n');
    const result = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([expect.objectContaining({ code: 'dirty-owned', path: 'tasks[0].owns' })]);
    expect(result.errors[0]?.message).toContain('src/api/a.ts');
    expect(result.errors[0]?.message).toContain('uncommitted');
  });

  it('refuses a staged edit to an owned file', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    r.write('src/api/a.ts', 'staged\n');
    r.git('add', 'src/api/a.ts');
    expect(await codes(normalized(r.dir, ['src/api/a.ts']), [r.dir])).toEqual(['dirty-owned']);
  });

  it('refuses a new untracked file inside an owned folder', async () => {
    const r = repo();
    r.write('src/api/new.ts');
    expect(await codes(normalized(r.dir), [r.dir])).toEqual(['dirty-owned']);
  });

  it('refuses an ignored file inside an owned folder', async () => {
    const r = repo({ '.gitignore': '*.log\n', 'src/api/a.ts': 'a\n' });
    r.write('src/api/debug.log');
    const result = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('ignored');
  });

  it('refuses an ignored folder that contains an owned file', async () => {
    const r = repo({ '.gitignore': 'build/\n' });
    r.write('build/out.js');
    expect(await codes(normalized(r.dir, ['build/out.js']), [r.dir])).toEqual(['dirty-owned']);
  });

  it('refuses a deleted owned file', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    rmSync(join(r.dir, 'src/api/a.ts'));
    expect(await codes(normalized(r.dir), [r.dir])).toEqual(['dirty-owned']);
  });

  it('matches owned paths case-insensitively', async () => {
    const r = repo({ 'Src/Api/A.ts': 'a\n' });
    r.write('Src/Api/A.ts', 'changed\n');
    expect(await codes(normalized(r.dir, ['src/api/']), [r.dir])).toEqual(['dirty-owned']);
  });

  it('handles non-ASCII file names', async () => {
    const r = repo({ 'docs/café/ünï.md': 'a\n' });
    r.write('docs/café/ünï.md', 'changed\n');
    expect(await codes(normalized(r.dir, ['docs/café/']), [r.dir])).toEqual(['dirty-owned']);
  });

  it('lists at most a few files per task and says how many more there are', async () => {
    const r = repo();
    for (let i = 0; i < 8; i++) r.write(`src/api/new${i}.ts`);
    const result = await checkRepo(normalized(r.dir), { allowedRepos: [r.dir] });
    if (result.ok) throw new Error('expected errors');
    expect(result.errors[0]?.message).toContain('and 3 more');
  });
});

describe('preparePlan', () => {
  it('runs the plan checks and then the repository checks', async () => {
    const r = repo({ 'src/api/a.ts': 'a\n' });
    const result = await preparePlan(planInput(r.dir), ctx, { allowedRepos: [r.dir] });
    expect(result.ok).toBe(true);
  });

  it('stops at plan errors without touching the repository', async () => {
    const result = await preparePlan(planInput('relative/path'), ctx, { allowedRepos: [] });
    expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual(['bad-repo-path']);
  });

  it('reports repository errors after the plan passes', async () => {
    const r = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), 'orch-else-'));
    mkdirSync(join(elsewhere, 'x'));
    try {
      const result = await preparePlan(planInput(r.dir), ctx, { allowedRepos: [elsewhere] });
      expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual(['repo-not-allowed']);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
