import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAcceptanceGate, type GateTask } from '../../src/accept/gate.js';
import { checkIntegrity, takeBaseline, type IntegrityBaseline } from '../../src/integrity/check.js';
import { checkScope, commitTask } from '../../src/scope/check.js';
import { createTaskWorktree, type TaskWorktree } from '../../src/worktree/manager.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const NODE = process.execPath;
const integrityOpts = { globalGitFiles: [] };

interface Committed {
  readonly fx: Fixture;
  readonly wt: TaskWorktree;
  readonly commit: string;
  readonly baseline: IntegrityBaseline;
}

/** A task whose work is committed and whose integrity check passed: where the gate starts. */
async function committedTask(): Promise<Committed> {
  const fx = f.make({ files: { 'README.md': 'hello\n', '.gitignore': 'dist/\n', 'src/api/a.ts': 'a\n' } });
  const created = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
  if (!created.ok) throw new Error(created.error.message);
  const wt = created.worktree;
  const before = await takeBaseline(fx.ctx, integrityOpts);
  writeFileSync(join(wt.path, 'src/api/a.ts'), 'changed\n');
  const scope = await checkScope(fx.ctx, wt, task([]), { fromCommit: fx.base });
  if (!scope.ok) throw new Error(scope.error.message);
  const committed = await commitTask(fx.ctx, wt, task([]), scope.report, { message: 'm\n' });
  if (!committed.ok || !committed.committed) throw new Error(JSON.stringify(committed));
  const integrity = await checkIntegrity(fx.ctx, wt, before, committed.commit, integrityOpts);
  if (!integrity.ok) throw new Error(JSON.stringify(integrity.violations));
  return { fx, wt, commit: committed.commit, baseline: integrity.baseline };
}

function task(commands: string[][]): GateTask {
  return { id: 'api', kind: 'work', mode: 'write', owns: ['src/api/'], acceptance: { commands, criteria: [] } };
}

function node(code: string): string[] {
  return [NODE, '-e', code];
}

async function gate(c: Committed, commands: string[][]) {
  return runAcceptanceGate(c.fx.ctx, c.wt, task(commands), { baseline: c.baseline, commit: c.commit }, {
    integrity: integrityOpts,
  });
}

describe('runAcceptanceGate', () => {
  it('passes when the commands pass and change nothing they should not', async () => {
    const c = await committedTask();
    const result = await gate(c, [node('process.exit(0)')]);
    expect(result).toMatchObject({ passed: true, added: [], trackedChanged: [], scopeProblem: null });
    expect(result.summary).toBe('1/1 commands passed; integrity ok');
  });

  it('fails when a command fails', async () => {
    const c = await committedTask();
    const result = await gate(c, [node('process.exit(0)'), node('process.exit(2)')]);
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('1/2 commands passed; integrity ok');
  });

  it('lists files the commands added, without failing; ignored output is not listed', async () => {
    const c = await committedTask();
    const write = "const fs = require('node:fs'); fs.writeFileSync('report.xml', 'x'); fs.mkdirSync('dist'); fs.writeFileSync('dist/out.js', 'x');";
    const result = await gate(c, [node(write)]);
    expect(result).toMatchObject({ passed: true, added: ['report.xml'], trackedChanged: [] });
    expect(result.summary).toContain('1 file added by the commands (not committed)');
  });

  it('fails when a command changed a tracked file, so the tests ran on something other than the commit', async () => {
    const c = await committedTask();
    const result = await gate(c, [node("require('node:fs').writeFileSync('src/api/a.ts', 'rewritten by a test')")]);
    expect(result).toMatchObject({ passed: false, trackedChanged: ['src/api/a.ts'] });
    expect(result.summary).toContain('1 tracked file changed by the commands');
  });

  it('fails, and skips the scope check, when a command tampered with the repository', async () => {
    const c = await committedTask();
    const hook = join(c.fx.ctx.commonDir, 'hooks', 'pre-commit');
    mkdirSync(join(c.fx.ctx.commonDir, 'hooks'), { recursive: true });
    const result = await gate(c, [node(`require('node:fs').writeFileSync(${JSON.stringify(hook)}, '#!/bin/sh\\n')`)]);
    expect(result.passed).toBe(false);
    expect(result.integrity.violations.map((v) => v.code)).toEqual(['repo-files']);
    expect(result.scopeProblem).toContain('skipped');
  });

  it('passes a task without acceptance commands and says so', async () => {
    const c = await committedTask();
    const result = await gate(c, []);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('no acceptance commands; integrity ok');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "fails when the scope check can't run, for example on a file git can't read",
    async () => {
      const c = await committedTask();
      const file = join(c.wt.path, 'src/api/secret.ts');
      const result = await gate(c, [node(`require('node:fs').writeFileSync(${JSON.stringify(file)}, 'x', { mode: 0 })`)]);
      chmodSync(file, 0o644);
      expect(result.passed).toBe(false);
      expect(result.integrity.ok).toBe(true);
      expect(result.scopeProblem).toContain('git add failed');
      expect(result.summary).toContain('scope check: git add failed');
    },
  );
});

describe('runAcceptanceGate and the run manager', () => {
  it("runs its integrity and scope checks inside the caller's exclusive section, the commands outside it", async () => {
    const c = await committedTask();
    const events: string[] = [];
    let depth = 0;
    const exclusive = async <T,>(work: () => Promise<T>): Promise<T> => {
      depth++;
      events.push(`enter ${depth}`);
      try {
        return await work();
      } finally {
        depth--;
        events.push('leave');
      }
    };
    const result = await runAcceptanceGate(c.fx.ctx, c.wt, task([node('process.exit(0)')]), { baseline: c.baseline, commit: c.commit }, {
      integrity: integrityOpts,
      exclusive,
    });
    expect(result.passed).toBe(true);
    expect(events).toEqual(['enter 1', 'leave', 'enter 1', 'leave']);
  });
});
