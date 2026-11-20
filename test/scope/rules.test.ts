import { describe, expect, it } from 'vitest';
import type { TreeChange } from '../../src/scope/diff.js';
import { evaluateScope, type ScopeTask } from '../../src/scope/rules.js';

const api: ScopeTask = { id: 'api', kind: 'work', mode: 'write', owns: ['src/api/', 'docs/api.md'] };

function change(path: string, status: TreeChange['status'] = 'A', newMode = '100644'): TreeChange {
  return {
    path,
    status,
    oldMode: status === 'A' ? '000000' : '100644',
    newMode: status === 'D' ? '000000' : newMode,
  };
}

function codes(changes: TreeChange[], task: ScopeTask = api, treePaths: string[] = []): string[] {
  return evaluateScope(task, changes, undefined, treePaths).map((v) => `${v.code} ${v.path}`);
}

describe('evaluateScope: inside the owned paths', () => {
  it('accepts added, changed and deleted files in an owned folder or an owned file', () => {
    expect(
      codes([change('src/api/new.ts'), change('src/api/a.ts', 'M'), change('src/api/old.ts', 'D'), change('docs/api.md', 'M')]),
    ).toEqual([]);
  });

  it('compares paths without letter case, like the plan validator', () => {
    expect(codes([change('SRC/Api/x.ts', 'M')])).toEqual([]);
  });

  it('accepts a mode change, such as making a script executable', () => {
    expect(codes([change('src/api/run.sh', 'M', '100755')])).toEqual([]);
  });
});

describe('evaluateScope: outside the owned paths', () => {
  it('rejects added, changed and deleted files elsewhere', () => {
    expect(codes([change('src/web/x.ts'), change('README.md', 'M'), change('src/web/old.ts', 'D')])).toEqual([
      'outside-owns src/web/x.ts',
      'outside-owns README.md',
      'outside-owns src/web/old.ts',
    ]);
  });

  it('is not fooled by a folder whose name only starts the same', () => {
    expect(codes([change('src/api-evil/x.ts'), change('docs/api.md.bak')])).toEqual([
      'outside-owns src/api-evil/x.ts',
      'outside-owns docs/api.md.bak',
    ]);
  });

  it('says so when the task is read-only', () => {
    const review: ScopeTask = { id: 'review', kind: 'work', mode: 'readonly', owns: [] };
    const [violation] = evaluateScope(review, [change('notes.md')]);
    expect(violation).toMatchObject({ code: 'outside-owns', path: 'notes.md' });
    expect(violation?.message).toContain('read-only');
  });
});

describe('evaluateScope: path rules inside owned folders', () => {
  it('rejects reserved files even inside an owned folder', () => {
    expect(
      codes([
        change('src/api/package.json'),
        change('src/api/.env.local'),
        change('src/api/AGENTS.md', 'M'),
        change('src/api/.github/workflows/ci.yml'),
        change('src/api/.vscode/settings.json'),
      ]),
    ).toEqual([
      'reserved src/api/package.json',
      'reserved src/api/.env.local',
      'reserved src/api/AGENTS.md',
      'reserved src/api/.github/workflows/ci.yml',
      'reserved src/api/.vscode/settings.json',
    ]);
  });

  it('lets a reserved task change the reserved files it owns', () => {
    const deps: ScopeTask = { id: 'deps', kind: 'reserved', mode: 'write', owns: ['package.json', 'package-lock.json'] };
    expect(codes([change('package.json', 'M'), change('package-lock.json', 'M')], deps)).toEqual([]);
  });

  it('rejects git metadata', () => {
    expect(codes([change('src/api/.git/config')])).toEqual(['forbidden src/api/.git/config']);
  });

  it('rejects symlinks and nested repositories, but allows deleting a symlink', () => {
    expect(
      codes([
        change('src/api/link', 'A', '120000'),
        change('src/api/was-file', 'T', '120000'),
        change('src/api/vendor', 'A', '160000'),
        change('src/api/old-link', 'D'),
      ]),
    ).toEqual(['symlink src/api/link', 'symlink src/api/was-file', 'submodule src/api/vendor']);
  });

  it('reports every problem with one path', () => {
    expect(codes([change('src/api/package.json', 'A', '120000')])).toEqual([
      'reserved src/api/package.json',
      'symlink src/api/package.json',
    ]);
  });

  it('rejects new names Windows cannot create, but not edits to existing ones', () => {
    expect(
      codes([
        change('src/api/aux.ts'),
        change('src/api/a:b.ts'),
        change('src/api/notes.'),
        change('src/api/con.ts', 'M'),
      ]),
    ).toEqual(['bad-name src/api/aux.ts', 'bad-name src/api/a:b.ts', 'bad-name src/api/notes.']);
  });
});

describe('evaluateScope: names that clash when letter case is ignored', () => {
  it('rejects a new file that differs from another only in case', () => {
    const tree = ['src/api/Readme.md', 'src/api/README.md', 'src/api/a.ts'];
    expect(codes([change('src/api/README.md')], api, tree)).toEqual(['case-collision src/api/README.md']);
  });

  it('rejects a new file in a folder spelled differently from an existing one', () => {
    const tree = ['src/Api/a.ts', 'src/api/b.ts'];
    const [violation] = evaluateScope(api, [change('src/api/b.ts')], undefined, tree);
    expect(violation?.code).toBe('case-collision');
    expect(violation?.message).toContain('"src/Api"');
  });

  it('rejects the same name in two Unicode forms', () => {
    const tree = ['src/api/café.md', 'src/api/café.md'];
    expect(codes([change('src/api/café.md')], api, tree)).toEqual(['case-collision src/api/café.md']);
  });

  it('accepts names that are unique', () => {
    expect(codes([change('src/api/b.ts')], api, ['src/api/a.ts', 'src/api/b.ts'])).toEqual([]);
  });
});
