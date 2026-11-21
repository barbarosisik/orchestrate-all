import { afterEach, describe, expect, it } from 'vitest';
import { diffTrees, treePaths } from '../../src/scope/trees.js';
import { fixtures } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

describe('diffTrees and treePaths', () => {
  it('compare and list trees', async () => {
    const fx = f.make({ files: { 'a.txt': 'a\n', 'src/b.txt': 'b\n' } });
    const before = fx.repo.git('rev-parse', 'HEAD^{tree}');
    fx.repo.write('src/c.txt', 'c\n');
    const after = fx.repo.git('rev-parse', `${fx.repo.commitAll()}^{tree}`);
    const diff = await diffTrees(fx.ctx, before, after);
    expect(diff.ok && diff.changes.map((c) => `${c.status} ${c.path}`)).toEqual(['A src/c.txt']);
    const listed = await treePaths(fx.ctx, after);
    expect(listed.ok && listed.paths).toEqual(['a.txt', 'src/b.txt', 'src/c.txt']);
  });

  it('report a git failure', async () => {
    const fx = f.make();
    const missing = 'f'.repeat(40);
    const diff = await diffTrees(fx.ctx, missing, missing);
    expect(diff.ok ? '' : diff.message).toContain('git diff-tree failed');
    const listed = await treePaths(fx.ctx, missing);
    expect(listed.ok ? '' : listed.message).toContain('git ls-tree failed');
  });
});
