import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  objectId,
  parseBatchOutput,
  parseTree,
  readCommit,
  readVerifiedObjects,
  verifyTree,
} from '../../src/git/objects.js';
import { fixtures, gitSupports, type Fixture } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

const files = { 'README.md': 'hello\n', 'src/api/a.ts': 'a\n', 'src/web/w.ts': 'w\n', 'src/web/deep/d.ts': 'd\n' };

/** Where git keeps a loose object. */
function objectFile(fx: Fixture, id: string): string {
  return join(fx.ctx.commonDir, 'objects', id.slice(0, 2), id.slice(2));
}

/** Overwrites the stored object `victim` with the stored object `source`, as a worker could. */
function overwriteObject(fx: Fixture, victim: string, source: string): void {
  const file = objectFile(fx, victim);
  chmodSync(file, 0o644);
  rmSync(file);
  mkdirSync(join(file, '..'), { recursive: true });
  copyFileSync(objectFile(fx, source), file);
}

describe('objectId', () => {
  it('matches the ids git gives blobs', () => {
    const fx = f.make({ files });
    expect(objectId('blob', Buffer.from('a\n'), 'sha1')).toBe(fx.repo.git('rev-parse', 'HEAD:src/api/a.ts'));
  });
});

describe('parseBatchOutput', () => {
  it('reads objects and skips missing ones', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const output = Buffer.concat([Buffer.from(`${a} blob 3\nhi\n\n${b} missing\n`)]);
    const objects = parseBatchOutput(output);
    expect(objects.get(a)?.content.toString()).toBe('hi\n');
    expect(objects.has(b)).toBe(false);
  });

  it('refuses output that does not follow the format', () => {
    const a = 'a'.repeat(40);
    expect(() => parseBatchOutput(Buffer.from(`${a} blob 3\nhi`))).toThrow(/cut short/);
    expect(() => parseBatchOutput(Buffer.from(`${a} blob x\n`))).toThrow(/Unexpected/);
    expect(() => parseBatchOutput(Buffer.from(`${a} blob 3`))).toThrow(/end/);
  });
});

describe('parseTree', () => {
  const id = Buffer.alloc(20, 0xab);
  const entry = (mode: string, name: string): Buffer => Buffer.concat([Buffer.from(`${mode} ${name}\u0000`), id]);

  it('reads entries', () => {
    const entries = parseTree(Buffer.concat([entry('100644', 'a.txt'), entry('40000', 'src')]), 20);
    expect(entries?.map((e) => [e.mode, e.name.toString(), e.id])).toEqual([
      ['100644', 'a.txt', 'ab'.repeat(20)],
      ['40000', 'src', 'ab'.repeat(20)],
    ]);
  });

  it('returns null for a malformed tree', () => {
    expect(parseTree(Buffer.from('100644 a.txt'), 20)).toBeNull();
    expect(parseTree(Buffer.concat([Buffer.from('100644 a.txt\u0000'), Buffer.alloc(5)]), 20)).toBeNull();
    expect(parseTree(entry('10x644', 'a.txt'), 20)).toBeNull();
    expect(parseTree(entry('100644', ''), 20)).toBeNull();
  });
});

describe('readVerifiedObjects', () => {
  it('reads objects whose content matches their id', async () => {
    const fx = f.make({ files });
    const result = await readVerifiedObjects(fx.ctx, [fx.base]);
    expect(result.ok && result.objects.get(fx.base)?.type).toBe('commit');
    expect(await readVerifiedObjects(fx.ctx, [])).toEqual({ ok: true, objects: new Map() });
  });

  it('reports an object rewritten under another id', async () => {
    const fx = f.make({ files });
    overwriteObject(fx, fx.repo.git('rev-parse', 'HEAD:src/web'), fx.repo.git('rev-parse', 'HEAD:src/api'));
    const result = await readVerifiedObjects(fx.ctx, [fx.repo.git('rev-parse', 'HEAD:src/web')]);
    expect(result.ok ? 'ok' : result.problem.code).toBe('altered');
  });

  it('reports missing objects and ids that are not full ids', async () => {
    const fx = f.make({ files });
    const missing = await readVerifiedObjects(fx.ctx, ['0'.repeat(40)]);
    expect(missing.ok ? 'ok' : missing.problem.code).toBe('missing');
    const short = await readVerifiedObjects(fx.ctx, [fx.base.slice(0, 12)]);
    expect(short.ok ? 'ok' : short.problem.code).toBe('missing');
  });

  it('reports a git failure', async () => {
    const fx = f.make({ files });
    const broken = { ...fx.ctx, commonDir: join(fx.home, 'not-a-repo') };
    mkdirSync(broken.commonDir);
    const result = await readVerifiedObjects(broken, [fx.base]);
    expect(result.ok ? 'ok' : result.problem.code).toBe('git-failed');
  });
});

describe('readCommit', () => {
  it("returns the commit's tree and parents", async () => {
    const fx = f.make({ files });
    fx.repo.write('x.txt');
    const second = fx.repo.commitAll('second');
    const result = await readCommit(fx.ctx, second);
    expect(result).toEqual({ ok: true, tree: fx.repo.git('rev-parse', `${second}^{tree}`), parents: [fx.base] });
    const first = await readCommit(fx.ctx, fx.base);
    expect(first.ok && first.parents).toEqual([]);
  });

  it('refuses something that is not a commit', async () => {
    const fx = f.make({ files });
    const result = await readCommit(fx.ctx, fx.repo.git('rev-parse', 'HEAD^{tree}'));
    expect(result.ok ? 'ok' : result.problem.code).toBe('wrong-type');
  });

  it('refuses a rewritten commit', async () => {
    const fx = f.make({ files });
    fx.repo.write('x.txt');
    const second = fx.repo.commitAll('second');
    overwriteObject(fx, fx.base, second);
    const result = await readCommit(fx.ctx, fx.base);
    expect(result.ok ? 'ok' : result.problem.code).toBe('altered');
  });
});

describe('verifyTree', () => {
  it('checks every tree once', async () => {
    const fx = f.make({ files });
    const root = fx.repo.git('rev-parse', 'HEAD^{tree}');
    const verified = new Set<string>();
    expect(await verifyTree(fx.ctx, root, verified)).toEqual({ ok: true, trees: 5 });
    expect(verified.size).toBe(5);
    expect(await verifyTree(fx.ctx, root, verified)).toEqual({ ok: true, trees: 0 });
  });

  it('finds a rewritten tree several folders down', async () => {
    const fx = f.make({ files });
    overwriteObject(fx, fx.repo.git('rev-parse', 'HEAD:src/web/deep'), fx.repo.git('rev-parse', 'HEAD:src/api'));
    const result = await verifyTree(fx.ctx, fx.repo.git('rev-parse', 'HEAD^{tree}'));
    expect(result.ok ? 'ok' : result.problem.code).toBe('altered');
  });

  it('refuses something that is not a tree', async () => {
    const fx = f.make({ files });
    const result = await verifyTree(fx.ctx, fx.base);
    expect(result.ok ? 'ok' : result.problem.code).toBe('wrong-type');
  });

  it.skipIf(!gitSupports(['--object-format=sha256']))('works in a SHA-256 repository', async () => {
    const fx = f.make({ files, initArgs: ['--object-format=sha256'] });
    expect(fx.base).toHaveLength(64);
    const commit = await readCommit(fx.ctx, fx.base);
    if (!commit.ok) throw new Error(commit.problem.message);
    expect(commit.tree).toHaveLength(64);
    expect(await verifyTree(fx.ctx, commit.tree)).toEqual({ ok: true, trees: 5 });
  });
});
