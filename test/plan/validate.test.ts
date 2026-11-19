import { describe, expect, it } from 'vitest';
import { validatePlan, type ValidationContext, type ValidationError } from '../../src/plan/validate.js';
import { defaultValidationContext } from '../../src/config/defaults.js';

type AnyTask = Record<string, unknown>;

function task(id: string, overrides: AnyTask = {}): AnyTask {
  return {
    id,
    title: `Task ${id}`,
    kind: 'work',
    mode: 'write',
    brief: `Do the ${id} work.`,
    engine: 'claude',
    model: 'opus',
    owns: [`src/${id}/`],
    dependsOn: [],
    acceptance: { commands: [['npm', 'test']], criteria: ['It works.'] },
    ...overrides,
  };
}

function plan(tasks: AnyTask[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    goal: 'Build the thing.',
    repo: 'C:\\Users\\me\\AppData\\Local\\Temp\\orch-test',
    targetBranch: 'main',
    orchestrator: { engine: 'claude', model: 'opus' },
    tasks,
    ...overrides,
  };
}

const twoEngines: ValidationContext = defaultValidationContext(['claude', 'codex']);
const oneEngine: ValidationContext = defaultValidationContext(['claude']);

function errorsOf(input: unknown, ctx: ValidationContext = oneEngine): ValidationError[] {
  const result = validatePlan(input, ctx);
  if (result.ok) return [];
  return result.errors;
}

function codesOf(input: unknown, ctx: ValidationContext = oneEngine): string[] {
  return errorsOf(input, ctx).map((e) => e.code);
}

describe('validatePlan: a valid plan', () => {
  it('accepts a single-task plan', () => {
    const result = validatePlan(plan([task('api')]), oneEngine);
    expect(result.ok).toBe(true);
  });

  it('returns the normalized plan', () => {
    const result = validatePlan(
      plan([task('api', { owns: ['src\\api\\', 'src/api/handler.ts', 'SRC/API/', 'docs/api.md'] })]),
      oneEngine,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.plan.tasks[0]?.owns).toEqual(['docs/api.md', 'src/api/']);
  });

  it('drops a baseSha supplied by the model', () => {
    const result = validatePlan(plan([task('api')], { baseSha: 'deadbeef' }), oneEngine);
    if (!result.ok) throw new Error('expected ok');
    expect('baseSha' in result.plan).toBe(false);
  });

  it('accepts 2 + 2 across two ready engines', () => {
    const tasks = [
      task('a', { engine: 'claude' }),
      task('b', { engine: 'codex', model: 'gpt-6.2-sol' }),
      task('c', { engine: 'claude' }),
      task('d', { engine: 'codex', model: 'gpt-6.2-sol' }),
    ];
    expect(errorsOf(plan(tasks), twoEngines)).toEqual([]);
  });

  it('accepts a readonly task with no owned files', () => {
    expect(errorsOf(plan([task('review', { mode: 'readonly', owns: [] })]))).toEqual([]);
  });

  it('accepts overlapping ownership when one task depends on the other', () => {
    const tasks = [
      task('base', { owns: ['src/shared/'] }),
      task('mid', { owns: ['src/mid/'], dependsOn: ['base'] }),
      task('top', { owns: ['src/shared/types.ts'], dependsOn: ['mid'] }),
    ];
    expect(errorsOf(plan(tasks))).toEqual([]);
  });

  it('accepts a reserved run with one reserved task that owns a reserved file', () => {
    const tasks = [task('deps', { kind: 'reserved', owns: ['package.json', 'package-lock.json'] })];
    expect(errorsOf(plan(tasks))).toEqual([]);
  });
});

describe('validatePlan: schema problems', () => {
  it('rejects non-objects', () => {
    expect(codesOf('nope')).toEqual(['schema']);
  });

  it('rejects unknown keys', () => {
    const errors = errorsOf(plan([task('api', { extra: true })]));
    expect(errors.map((e) => e.code)).toEqual(['schema']);
    expect(errors[0]?.path).toBe('tasks[0]');
  });

  it('rejects a bad task id', () => {
    const errors = errorsOf(plan([task('Bad_ID')]));
    expect(errors[0]).toMatchObject({ code: 'schema', path: 'tasks[0].id' });
  });

  it('rejects a bad model name', () => {
    expect(errorsOf(plan([task('api', { model: 'opus; rm -rf /' })]))[0]).toMatchObject({
      code: 'schema',
      path: 'tasks[0].model',
    });
  });

  it('rejects an unknown engine', () => {
    expect(errorsOf(plan([task('api', { engine: 'gemini' })]))[0]).toMatchObject({
      code: 'schema',
      path: 'tasks[0].engine',
    });
  });

  it('rejects an orchestrator that cannot be a front door', () => {
    expect(errorsOf(plan([task('api')], { orchestrator: { engine: 'antigravity', model: 'x' } }))[0]).toMatchObject({
      code: 'schema',
      path: 'orchestrator.engine',
    });
  });

  it('rejects an empty task list', () => {
    expect(codesOf(plan([]))).toEqual(['schema']);
  });

  it('rejects an empty acceptance command', () => {
    expect(codesOf(plan([task('api', { acceptance: { commands: [[]], criteria: [] } })]))).toEqual(['schema']);
  });

  it('rejects a title over 80 characters', () => {
    expect(codesOf(plan([task('api', { title: 'x'.repeat(81) })]))).toEqual(['schema']);
  });
});

describe('validatePlan: identity', () => {
  it('rejects duplicate task ids', () => {
    expect(codesOf(plan([task('api'), task('api', { owns: ['src/other/'] })]))).toContain('duplicate-id');
  });

  it('rejects the reserved id "integration"', () => {
    expect(codesOf(plan([task('integration')]))).toContain('reserved-id');
  });

  it('rejects a relative repo path', () => {
    expect(codesOf(plan([task('api')], { repo: 'my-repo' }))).toContain('bad-repo-path');
  });

  it('accepts a POSIX absolute repo path', () => {
    expect(codesOf(plan([task('api')], { repo: '/tmp/orch-test' }))).toEqual([]);
  });

  it.each(['', 'a..b', 'a b', 'feature/', '/main', '-x', 'a.lock', 'a//b', 'a@{1}', '@', 'x~1', 'x^', 'x:y', 'a/.hidden', 'end.', 'orchestra/123/integration'])(
    'rejects the target branch %j',
    (branch) => {
      expect(codesOf(plan([task('api')], { targetBranch: branch }))).toContain('bad-branch');
    },
  );

  it.each(['main', 'feature/login-v2', 'release-1.2', 'user/me/fix_bug'])('accepts the target branch %j', (branch) => {
    expect(codesOf(plan([task('api')], { targetBranch: branch }))).toEqual([]);
  });
});

describe('validatePlan: owned paths', () => {
  it('reports each malformed entry with its location and reason', () => {
    const errors = errorsOf(plan([task('api', { owns: ['src/ok.ts', '../escape.ts', 'src/*.ts'] })]));
    expect(errors).toEqual([
      expect.objectContaining({ code: 'owns-invalid', path: 'tasks[0].owns[1]' }),
      expect.objectContaining({ code: 'owns-invalid', path: 'tasks[0].owns[2]' }),
    ]);
    expect(errors[0]?.message).toContain('..');
  });

  it('rejects a write task with nothing owned', () => {
    expect(codesOf(plan([task('api', { owns: [] })]))).toContain('owns-mode');
  });

  it('rejects a readonly task that owns files', () => {
    expect(codesOf(plan([task('api', { mode: 'readonly' })]))).toContain('owns-mode');
  });

  it('rejects a work task that owns a reserved file', () => {
    const errors = errorsOf(plan([task('api', { owns: ['src/api/', 'package.json'] })]));
    expect(errors).toEqual([expect.objectContaining({ code: 'owns-reserved', path: 'tasks[0].owns[1]' })]);
    expect(errors[0]?.message).toContain('package.json');
  });

  it('rejects a work task that owns an instruction file in a subfolder', () => {
    expect(codesOf(plan([task('api', { owns: ['packages/api/AGENTS.md'] })]))).toContain('owns-reserved');
  });

  it('rejects a work task that owns a folder inside a reserved folder', () => {
    expect(codesOf(plan([task('ci', { owns: ['.github/workflows/'] })]))).toContain('owns-reserved');
  });

  it('never lets any task own git metadata, not even a reserved task', () => {
    expect(codesOf(plan([task('api', { owns: ['.git/hooks/pre-commit'] })]))).toContain('owns-forbidden');
    expect(codesOf(plan([task('deps', { kind: 'reserved', owns: ['.git/config'] })]))).toContain('owns-forbidden');
  });

  it('uses custom reserved patterns from the context', () => {
    const ctx = { ...oneEngine, reservedPatterns: ['src/generated/'] };
    expect(codesOf(plan([task('api', { owns: ['src/generated/a.ts'] })]), ctx)).toContain('owns-reserved');
    expect(codesOf(plan([task('api', { owns: ['package.json'] })]), ctx)).toEqual([]);
  });
});

describe('validatePlan: overlap between tasks', () => {
  it('rejects two unordered tasks owning the same file', () => {
    const errors = errorsOf(plan([task('a', { owns: ['src/x.ts'] }), task('b', { owns: ['src/x.ts'] })]));
    expect(errors).toEqual([expect.objectContaining({ code: 'overlap-unordered', path: 'tasks[1].owns[0]' })]);
    expect(errors[0]?.message).toContain('a');
    expect(errors[0]?.message).toContain('dependsOn');
  });

  it('rejects overlap that differs only in case, slashes or Unicode form', () => {
    expect(codesOf(plan([task('a', { owns: ['Src/Caf\u00e9.ts'] }), task('b', { owns: ['src\\cafe\u0301.TS'] })]))).toContain(
      'overlap-unordered',
    );
  });

  it('rejects a file inside another unordered task\u2019s folder', () => {
    expect(codesOf(plan([task('a', { owns: ['src/'] }), task('b', { owns: ['src/deep/x.ts'] })]))).toContain(
      'overlap-unordered',
    );
  });

  it('accepts sibling folders that only share a name prefix', () => {
    expect(codesOf(plan([task('a', { owns: ['src/app/'] }), task('b', { owns: ['src/app2/'] })]))).toEqual([]);
  });

  it('in strict mode, rejects overlap even when ordered', () => {
    const ctx: ValidationContext = { ...oneEngine, overlapMode: 'strict' };
    const tasks = [task('a', { owns: ['src/x.ts'] }), task('b', { owns: ['src/x.ts'], dependsOn: ['a'] })];
    expect(codesOf(plan(tasks), ctx)).toEqual(['overlap-strict']);
  });
});

describe('validatePlan: dependencies', () => {
  it('rejects an unknown dependency', () => {
    expect(errorsOf(plan([task('a', { dependsOn: ['ghost'] })]))[0]).toMatchObject({
      code: 'dep-unknown',
      path: 'tasks[0].dependsOn[0]',
    });
  });

  it('rejects a task depending on itself', () => {
    expect(codesOf(plan([task('a', { dependsOn: ['a'] })]))).toContain('dep-self');
  });

  it('rejects a duplicate dependency', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a', 'a'] })];
    expect(codesOf(plan(tasks))).toContain('dep-duplicate');
  });

  it('rejects a cycle and names it', () => {
    const tasks = [task('a', { dependsOn: ['c'] }), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })];
    const errors = errorsOf(plan(tasks));
    expect(errors).toEqual([expect.objectContaining({ code: 'dep-cycle' })]);
    expect(errors[0]?.message).toContain('a -> c -> b -> a');
  });
});

describe('validatePlan: reserved runs', () => {
  it('rejects a reserved task mixed with other tasks', () => {
    const tasks = [task('deps', { kind: 'reserved', owns: ['package.json'] }), task('api')];
    expect(codesOf(plan(tasks))).toContain('reserved-run');
  });

  it('rejects a readonly reserved task', () => {
    expect(codesOf(plan([task('deps', { kind: 'reserved', mode: 'readonly', owns: [] })]))).toContain('reserved-run');
  });
});

describe('validatePlan: engines and the even split', () => {
  it('rejects a task on an engine that is not ready', () => {
    const errors = errorsOf(plan([task('a', { engine: 'antigravity', model: 'gemini-4-neon' })]));
    expect(errors).toEqual([expect.objectContaining({ code: 'engine-not-ready', path: 'tasks[0].engine' })]);
  });

  it('rejects a plan when no engine is ready', () => {
    expect(codesOf(plan([task('a')]), defaultValidationContext([]))).toEqual(['no-engines']);
  });

  it('rejects an uneven split and says what it should be', () => {
    const tasks = [task('a'), task('b'), task('c'), task('d', { engine: 'codex', model: 'gpt-6.2-sol' })];
    const errors = errorsOf(plan(tasks), twoEngines);
    expect(errors).toEqual([expect.objectContaining({ code: 'uneven-split', path: 'tasks' })]);
    expect(errors[0]?.message).toContain('claude: 3');
    expect(errors[0]?.message).toContain('codex: 1');
    expect(errors[0]?.message).toContain('2');
  });

  it('works with only the engines that are ready (Antigravity missing)', () => {
    const tasks = [task('a'), task('b', { engine: 'codex', model: 'gpt-6.2-sol' })];
    expect(codesOf(plan(tasks), twoEngines)).toEqual([]);
  });

  it('allows one task when three engines are ready', () => {
    const ctx = defaultValidationContext(['claude', 'codex', 'antigravity']);
    expect(codesOf(plan([task('a', { engine: 'antigravity', model: 'gemini-4-neon' })]), ctx)).toEqual([]);
  });

  it('can switch the split check off', () => {
    const ctx: ValidationContext = { ...twoEngines, splitMode: 'off' };
    expect(codesOf(plan([task('a'), task('b'), task('c')]), ctx)).toEqual([]);
  });
});

describe('validatePlan: limits', () => {
  it('rejects more tasks than the cap', () => {
    const ctx: ValidationContext = { ...oneEngine, maxTasks: 2 };
    const tasks = [task('a'), task('b'), task('c')];
    expect(codesOf(plan(tasks), ctx)).toContain('task-limit');
  });
});
