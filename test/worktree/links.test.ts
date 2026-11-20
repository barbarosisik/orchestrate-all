import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  adminTarget,
  checkWorktreeLinks,
  findAdminDir,
  parseGitFile,
  readControlFile,
  sameLocation,
} from '../../src/worktree/links.js';
import { createTaskWorktree, type TaskWorktree } from '../../src/worktree/manager.js';
import { fixtures, type Fixture } from '../helpers/fixture.js';

const scratch = mkdtempSync(join(tmpdir(), 'orch-links-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const f = fixtures();
afterEach(() => f.cleanupAll());

async function worktree(): Promise<{ fx: Fixture; wt: TaskWorktree }> {
  const fx = f.make();
  const result = await createTaskWorktree(fx.ctx, { runId: 'run1', taskId: 'api', startSha: fx.base });
  if (!result.ok) throw new Error(result.error.message);
  return { fx, wt: result.worktree };
}

function codes(fx: Fixture, wt: TaskWorktree): string[] {
  return checkWorktreeLinks(wt, fx.ctx.commonDir, fx.ctx.caseInsensitivePaths).map((p) => p.code);
}

describe('parseGitFile', () => {
  it('reads an absolute gitdir link', () => {
    const target = resolve('/repo/.git/worktrees/api');
    expect(parseGitFile(`gitdir: ${target}\n`, '/wt/api')).toBe(target);
  });

  it('resolves a relative link from the worktree folder', () => {
    expect(parseGitFile('gitdir: ../repo/.git/worktrees/api\r\n', resolve('/wt/api'))).toBe(
      resolve('/wt/repo/.git/worktrees/api'),
    );
  });

  it('rejects anything else', () => {
    expect(parseGitFile('', '/wt')).toBeNull();
    expect(parseGitFile('gitdir:/x\n', '/wt')).toBeNull();
    expect(parseGitFile('gitdir: /x\ngitdir: /y\n', '/wt')).toBeNull();
    expect(parseGitFile('[core]\n\tbare = false\n', '/wt')).toBeNull();
  });
});

describe('readControlFile', () => {
  it('reads a file and refuses a folder or a missing path', () => {
    const file = join(scratch, 'HEAD');
    writeFileSync(file, 'ref: refs/heads/main\n');
    mkdirSync(join(scratch, 'dir'));
    expect(readControlFile(file)).toBe('ref: refs/heads/main\n');
    expect(readControlFile(join(scratch, 'dir'))).toBeNull();
    expect(readControlFile(join(scratch, 'missing'))).toBeNull();
  });
});

describe('sameLocation', () => {
  it('compares paths whose last part does not exist', () => {
    expect(sameLocation(join(scratch, 'gone', '.git'), join(scratch, 'gone', '.git'), false)).toBe(true);
    expect(sameLocation(join(scratch, 'gone', '.git'), join(scratch, 'other', '.git'), false)).toBe(false);
  });
});

describe('findAdminDir and adminTarget', () => {
  it("finds git's folder for a worktree by its back-link", async () => {
    const { fx, wt } = await worktree();
    expect(findAdminDir(fx.ctx.commonDir, wt.path, fx.ctx.caseInsensitivePaths)).toBe(wt.adminDir);
    expect(adminTarget(wt.adminDir)).not.toBeNull();
  });

  it('returns null when the repository has no linked worktrees', () => {
    const fx = f.make();
    expect(findAdminDir(fx.ctx.commonDir, join(fx.home, 'wt', 'x'), false)).toBeNull();
  });
});

describe('checkWorktreeLinks', () => {
  it('passes for a fresh worktree', async () => {
    const { fx, wt } = await worktree();
    expect(codes(fx, wt)).toEqual([]);
  });

  it('notices a .git file replaced by a folder', async () => {
    const { fx, wt } = await worktree();
    rmSync(join(wt.path, '.git'));
    mkdirSync(join(wt.path, '.git'));
    expect(codes(fx, wt)).toEqual(['git-pointer']);
  });

  it('notices a back-link that points elsewhere', async () => {
    const { fx, wt } = await worktree();
    writeFileSync(join(wt.adminDir, 'gitdir'), `${join(scratch, 'elsewhere', '.git')}\n`);
    expect(codes(fx, wt)).toEqual(['worktree-admin']);
  });

  it('notices a commondir that points at another repository', async () => {
    const { fx, wt } = await worktree();
    writeFileSync(join(wt.adminDir, 'commondir'), `${scratch}\n`);
    expect(codes(fx, wt)).toEqual(['worktree-admin']);
  });

  it("notices that git's folder for the worktree is gone", async () => {
    const { fx, wt } = await worktree();
    rmSync(wt.adminDir, { recursive: true, force: true });
    expect(codes(fx, wt)).toEqual(['worktree-admin']);
  });
});
