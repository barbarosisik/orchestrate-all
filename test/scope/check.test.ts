import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkScope, commitTask, taskCommitMessage, type ScopeReport } from '../../src/scope/check.js';
import type { ScopeTask } from '../../src/scope/rules.js';
import { createTaskWorktree, type TaskWorktree } from '../../src/worktree/manager.js';
import { fixtures, installHook, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const api: ScopeTask = { id: 'api', kind: 'work', mode: 'write', owns: ['src/api/'] };

interface Setup {
  readonly fx: Fixture;
  readonly wt: TaskWorktree;
  write(rel: string, content?: string): void;
  worker(...args: string[]): string;
  scope(task?: ScopeTask, fromCommit?: string): Promise<ScopeReport>;
}

async function setup(files?: Record<string, string>, hooks: 'on' | 'off' = 'off'): Promise<Setup> {
  const fx = f.make({
    hooks,
    files: files ?? {
      'README.md': 'hello\n',
      '.gitignore': 'dist/\n*.log\n',
      'src/api/a.ts': 'a\n',
      'src/web/w.ts': 'w\n',
    },
  });
  const created = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
  if (!created.ok) throw new Error(created.error.message);
  const wt = created.worktree;
  return {
    fx,
    wt,
    write(rel, content = 'x\n') {
      mkdirSync(join(wt.path, rel, '..'), { recursive: true });
      writeFileSync(join(wt.path, rel), content);
    },
    worker: (...args) => fx.repo.git('-C', wt.path, ...args),
    async scope(task = api, fromCommit = fx.base) {
      const result = await checkScope(fx.ctx, wt, task, { fromCommit });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.report;
    },
  };
}

function summary(report: ScopeReport): string[] {
  return report.changes.map((c) => `${c.status} ${c.path}`);
}

function violations(report: ScopeReport): string[] {
  return report.violations.map((v) => `${v.code} ${v.path}`);
}

describe('checkScope', () => {
  it('reports nothing for an untouched worktree', async () => {
    const s = await setup();
    const report = await s.scope();
    expect(report).toMatchObject({ clean: true, changes: [], violations: [], ignored: [] });
    expect(report.tree).toBe(s.fx.repo.git('rev-parse', 'HEAD^{tree}'));
  });

  it('treats line-ending conversion as no change (core.autocrlf=true, the Git for Windows default)', async () => {
    const fx = f.make({ files: { 'src/api/a.ts': 'one\ntwo\n', 'README.md': 'r\n' } });
    fx.repo.git('config', 'core.autocrlf', 'true');
    const created = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
    if (!created.ok) throw new Error(created.error.message);
    const wt = created.worktree;
    expect(readFileSync(join(wt.path, 'src/api/a.ts'), 'utf8')).toBe('one\r\ntwo\r\n');
    writeFileSync(join(wt.path, 'src/api/b.ts'), 'new\r\nfile\r\n');
    const result = await checkScope(fx.ctx, wt, api, { fromCommit: fx.base });
    if (!result.ok) throw new Error(result.error.message);
    expect(summary(result.report)).toEqual(['A src/api/b.ts']);
    expect(fx.repo.git('cat-file', '-p', `${result.report.tree}:src/api/b.ts`)).toBe('new\nfile');
  });

  it('lists added, changed and deleted files inside the owned paths', async () => {
    const s = await setup({ 'src/api/a.ts': 'a\n', 'src/api/old.ts': 'old\n', 'README.md': 'r\n' });
    s.write('src/api/a.ts', 'changed\n');
    s.write('src/api/new.ts', 'new\n');
    rmSync(join(s.wt.path, 'src/api/old.ts'));
    const report = await s.scope();
    expect(summary(report)).toEqual(['M src/api/a.ts', 'A src/api/new.ts', 'D src/api/old.ts']);
    expect(report.clean).toBe(true);
  });

  it('finds changes outside the owned paths', async () => {
    const s = await setup();
    s.write('src/web/w.ts', 'changed\n');
    s.write('notes.txt');
    const report = await s.scope();
    expect(report.clean).toBe(false);
    expect(violations(report)).toEqual(['outside-owns notes.txt', 'outside-owns src/web/w.ts']);
  });

  it("finds a change the worker hid from git status with assume-unchanged or skip-worktree", async () => {
    const s = await setup({ 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n', 'README.md': 'r\n' });
    s.worker('update-index', '--assume-unchanged', 'src/web/w.ts');
    s.worker('update-index', '--skip-worktree', 'README.md');
    s.write('src/web/w.ts', 'sneaky\n');
    s.write('README.md', 'sneaky\n');
    expect(s.worker('status', '--porcelain')).toBe('');
    expect(violations(await s.scope())).toEqual(['outside-owns README.md', 'outside-owns src/web/w.ts']);
  });

  it('compares the files themselves, whatever the worker staged', async () => {
    const s = await setup();
    s.write('src/web/w.ts', 'staged then reverted\n');
    s.worker('add', 'src/web/w.ts');
    s.write('src/web/w.ts', 'w\n');
    s.write('src/api/a.ts', 'real change\n');
    expect(summary(await s.scope())).toEqual(['M src/api/a.ts']);
  });

  it('lists ignored files without committing them, marking those inside the owned paths', async () => {
    const s = await setup();
    s.write('src/api/debug.log');
    s.write('dist/bundle.js');
    const report = await s.scope();
    expect(report.changes).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.ignored).toEqual([
      { path: 'dist/', owned: false },
      { path: 'src/api/debug.log', owned: true },
    ]);
  });

  it('rejects a reserved file inside an owned folder', async () => {
    const s = await setup();
    s.write('src/api/package.json', '{}\n');
    expect(violations(await s.scope())).toEqual(['reserved src/api/package.json']);
  });

  it('treats any change by a read-only task as out of scope', async () => {
    const s = await setup();
    s.write('src/api/a.ts', 'changed\n');
    const report = await s.scope({ id: 'review', kind: 'work', mode: 'readonly', owns: [] });
    expect(violations(report)).toEqual(['outside-owns src/api/a.ts']);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink inside the owned folder', async () => {
    const s = await setup();
    symlinkSync('/etc/hosts', join(s.wt.path, 'src/api/hosts'));
    expect(violations(await s.scope())).toEqual(['symlink src/api/hosts']);
  });

  it(".gitattributes written by the worker don't apply; the start commit's do", async () => {
    const s = await setup({ '.gitattributes': '*.up filter=upper\n', 'src/api/a.ts': 'a\n' });
    s.fx.repo.git('config', 'filter.upper.clean', 'tr a-z A-Z');
    s.write('.gitattributes', '*.up filter=upper\n*.ts filter=upper\n');
    s.write('src/api/b.ts', 'lower\n');
    s.write('src/api/c.up', 'lower\n');
    const report = await s.scope();
    const blob = (path: string): string => s.fx.repo.git('cat-file', '-p', `${report.tree}:${path}`);
    expect(blob('src/api/b.ts')).toBe('lower');
    expect(blob('src/api/c.up')).toBe('LOWER');
    expect(violations(report)).toEqual(['outside-owns .gitattributes']);
  });

  it('refuses to run git in a worktree whose links were tampered with', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.path, '.git'), 'gitdir: /somewhere/else\n');
    const result = await checkScope(s.fx.ctx, s.wt, api, { fromCommit: s.fx.base });
    expect(result.ok ? 'ok' : result.error.code).toBe('worktree-tampered');
  });

  it('refuses when a per-worktree config file appeared', async () => {
    const s = await setup();
    writeFileSync(join(s.wt.adminDir, 'config.worktree'), '[core]\n\tattributesFile = /tmp/evil\n');
    const result = await checkScope(s.fx.ctx, s.wt, api, { fromCommit: s.fx.base });
    expect(result.ok ? 'ok' : result.error.code).toBe('worktree-tampered');
  });

  it('refuses a worktree that contains a nested repository', async () => {
    const s = await setup();
    s.fx.repo.git('init', '-q', join(s.wt.path, 'src', 'api', 'inner'));
    const result = await checkScope(s.fx.ctx, s.wt, api, { fromCommit: s.fx.base });
    expect(result.ok ? 'ok' : result.error.code).toBe('nested-git');
  });

  it('refuses an abbreviated or unknown commit', async () => {
    const s = await setup();
    for (const fromCommit of [s.fx.base.slice(0, 7), 'f'.repeat(40), '--output=/tmp/x']) {
      const result = await checkScope(s.fx.ctx, s.wt, api, { fromCommit });
      expect(result.ok ? 'ok' : result.error.code, fromCommit).toBe('bad-commit');
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a file git cannot read', async () => {
    const s = await setup();
    s.write('src/api/secret.ts', 'x\n');
    chmodSync(join(s.wt.path, 'src/api/secret.ts'), 0o000);
    try {
      const result = await checkScope(s.fx.ctx, s.wt, api, { fromCommit: s.fx.base });
      expect(result.ok ? 'ok' : result.error.code).toBe('git-failed');
    } finally {
      chmodSync(join(s.wt.path, 'src/api/secret.ts'), 0o644);
    }
  });
});

describe('commitTask', () => {
  it('commits exactly the checked tree on the task branch, as Orchestra, without hooks or signing', async () => {
    const s = await setup();
    const marker = join(s.fx.home, 'hooks-ran.txt');
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) installHook(s.fx, hook, marker);
    s.write('src/api/a.ts', 'changed\n');
    const report = await s.scope();
    const message = taskCommitMessage('run1', { id: 'api', title: 'Build the API' });
    const result = await commitTask(s.fx.ctx, s.wt, api, report, { message });
    if (!result.ok || !result.committed) throw new Error(JSON.stringify(result));

    const git = s.fx.repo.git;
    expect(git('rev-parse', s.wt.ref)).toBe(result.commit);
    expect(git('rev-parse', `${result.commit}^{tree}`)).toBe(report.tree);
    expect(git('rev-parse', `${result.commit}^`)).toBe(s.fx.base);
    expect(git('log', '-1', '--format=%an <%ae>|%cn <%ce>|%G?', result.commit)).toBe(
      'Orchestra <orchestra@localhost>|Orchestra <orchestra@localhost>|N',
    );
    expect(`${git('log', '-1', '--format=%B', result.commit)}\n`).toBe(message);
    expect(existsSync(marker)).toBe(false);
    expect(git('rev-parse', 'main')).toBe(s.fx.base);
  });

  it("uses Orchestra's identity even when the repository sets its own", async () => {
    const s = await setup();
    s.fx.repo.git('config', 'author.name', 'Someone Else');
    s.fx.repo.git('config', 'user.email', 'someone@example.invalid');
    s.write('src/api/a.ts', 'changed\n');
    const result = await commitTask(s.fx.ctx, s.wt, api, await s.scope(), { message: 'm\n' });
    if (!result.ok || !result.committed) throw new Error(JSON.stringify(result));
    expect(s.fx.repo.git('log', '-1', '--format=%an <%ae>', result.commit)).toBe('Orchestra <orchestra@localhost>');
  });

  it('commits nothing when nothing changed', async () => {
    const s = await setup();
    const result = await commitTask(s.fx.ctx, s.wt, api, await s.scope(), { message: 'm\n' });
    expect(result).toEqual({ ok: true, committed: false, tip: s.fx.base });
    expect(s.fx.repo.git('rev-parse', s.wt.ref)).toBe(s.fx.base);
  });

  it('refuses a report with violations', async () => {
    const s = await setup();
    s.write('src/web/w.ts', 'changed\n');
    const result = await commitTask(s.fx.ctx, s.wt, api, await s.scope(), { message: 'm\n' });
    expect(result.ok ? 'ok' : result.error.code).toBe('out-of-scope');
    expect(s.fx.repo.git('rev-parse', s.wt.ref)).toBe(s.fx.base);
  });

  it('refuses when the task branch moved after the check', async () => {
    const s = await setup();
    s.write('src/api/a.ts', 'changed\n');
    const report = await s.scope();
    s.worker('commit', '-q', '--allow-empty', '-m', 'worker commit');
    const moved = s.fx.repo.git('rev-parse', s.wt.ref);
    const result = await commitTask(s.fx.ctx, s.wt, api, report, { message: 'm\n' });
    expect(result.ok ? 'ok' : result.error.code).toBe('branch-moved');
    expect(s.fx.repo.git('rev-parse', s.wt.ref)).toBe(moved);
  });

  it('re-checks the commit and moves the branch back if it does not match the report', async () => {
    const s = await setup();
    s.write('src/api/a.ts', 'changed\n');
    s.write('src/web/w.ts', 'out of scope\n');
    const real = await s.scope();
    const forged: ScopeReport = { ...real, clean: true, violations: [], changes: real.changes.slice(0, 1) };
    const result = await commitTask(s.fx.ctx, s.wt, api, forged, { message: 'm\n' });
    expect(result.ok ? 'ok' : result.error.code).toBe('recheck-failed');
    if (!result.ok) expect(result.error.message).toContain('moved back');
    expect(s.fx.repo.git('rev-parse', s.wt.ref)).toBe(s.fx.base);
  });

  it('leaves a worktree that matches its commit, so the next check from there is empty', async () => {
    const s = await setup();
    s.write('src/api/a.ts', 'changed\n');
    const result = await commitTask(s.fx.ctx, s.wt, api, await s.scope(), { message: 'm\n' });
    if (!result.ok || !result.committed) throw new Error(JSON.stringify(result));
    expect((await s.scope(api, result.commit)).changes).toEqual([]);
    s.write('src/api/a.ts', 'changed again by a test command\n');
    expect(summary(await s.scope(api, result.commit))).toEqual(['M src/api/a.ts']);
    expect(readFileSync(join(s.wt.path, 'src/api/a.ts'), 'utf8')).toContain('again');
  });
});

describe('taskCommitMessage', () => {
  it('puts the title first and the run and task in trailers', () => {
    expect(taskCommitMessage('run1', { id: 'api', title: 'Build the API' })).toBe(
      'Build the API\n\nOrchestra-Run: run1\nOrchestra-Task: api\n',
    );
  });

  it('keeps the title on one line and falls back to the task id', () => {
    expect(taskCommitMessage('run1', { id: 'api', title: 'Line one\nline two' }).split('\n')[0]).toBe('Line one line two');
    expect(taskCommitMessage('run1', { id: 'api', title: '\n\t' }).split('\n')[0]).toBe('api');
  });
});
