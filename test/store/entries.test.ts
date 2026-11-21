import { describe, expect, it } from 'vitest';
import type { FinalizeReport } from '../../src/finalize/check.js';
import type { IntegrityReport } from '../../src/integrity/check.js';
import { newTaskReview, recordGate, recordReview, type TaskReview } from '../../src/review/state.js';
import type { ScopeReport } from '../../src/scope/check.js';
import {
  agentConfigEntry,
  clipText,
  commitEntry,
  finalizeEntry,
  gateEntry,
  integrityEntry,
  loggedProblems,
  mergeEntry,
  noteEntry,
  reviewEntry,
  scopeEntry,
  workerEntry,
} from '../../src/store/entries.js';
import { DEFAULT_MAX_LOG_BYTES, maxLineBytes, serializeRecord } from '../../src/store/log.js';
import { LOG_LIMITS, LogRecordSchema, type LogEntry, type LogRecord } from '../../src/store/schema.js';
import { passingReview, SHA } from '../helpers/store.js';

/** Every entry must be a valid record once stamped. */
function valid(entry: LogEntry): LogEntry {
  const parsed = LogRecordSchema.safeParse({ v: 1, at: '2026-11-21T12:00:00.000Z', ...entry });
  if (!parsed.success) throw new Error(parsed.error.message);
  return entry;
}

const BASELINE: IntegrityReport['baseline'] = { refs: {}, checkouts: {}, hiddenIndex: {}, repoFiles: {}, userWorktrees: {}, configFiles: {} };

describe('clipText and loggedProblems', () => {
  it('cuts long text with an ellipsis, measured in bytes of JSON, and keeps short text', () => {
    expect(clipText('short')).toBe('short');
    const jsonBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s)) - 2;
    // Fewer characters than the limit, but more bytes.
    for (const wide of ['文'.repeat(500), '\u0001'.repeat(300)]) {
      expect(jsonBytes(clipText(wide, 1000))).toBeLessThanOrEqual(1000);
      expect(clipText(wide, 1000).endsWith('…')).toBe(true);
    }
    for (const long of ['x'.repeat(5000), '文'.repeat(5000), '\u0001'.repeat(5000), '😀'.repeat(5000)]) {
      const clipped = clipText(long, 1000);
      expect(clipped.endsWith('…')).toBe(true);
      expect(jsonBytes(clipped)).toBeLessThanOrEqual(1000);
      expect(jsonBytes(clipped)).toBeGreaterThan(990);
      expect(clipped).not.toMatch(/[\uD800-\uDBFF]…$/);
    }
  });

  it('lists the first problems and counts the rest', () => {
    const many = Array.from({ length: LOG_LIMITS.items + 5 }, (_, i) => ({ code: `c${i}`, message: `m${i}`, paths: [`p${i}`] }));
    const logged = loggedProblems(many);
    expect(logged.shown).toHaveLength(LOG_LIMITS.items);
    expect(logged.more).toBe(5);
    expect(logged.shown[0]).toEqual({ code: 'c0', message: 'm0', paths: ['p0'] });
    expect(Buffer.byteLength(loggedProblems([{ code: 'x'.repeat(100), message: 'm' }]).shown[0]?.code ?? '')).toBe(64);
  });
});

describe('the largest records', () => {
  it('fit the line limit even with long non-ASCII paths and control characters a worker chose', () => {
    const strange = ['文'.repeat(3000), '\u0007'.repeat(3000), '😀'.repeat(3000)];
    for (const name of strange) {
      const violations = Array.from({ length: 30 }, () => ({ path: name, code: 'outside-owns' as const, message: `Added ${name}` }));
      const entry = scopeEntry('api', 0, {
        ok: true,
        report: { clean: false, fromCommit: SHA('1'), fromTree: SHA('2'), tree: SHA('3'), changes: [], violations, ignored: [] },
      });
      const line = serializeRecord({ v: 1, at: '2026-11-21T12:00:00.000Z', ...valid(entry) } as LogRecord);
      expect(Buffer.byteLength(line)).toBeLessThan(maxLineBytes(DEFAULT_MAX_LOG_BYTES));
      const problems = Array.from({ length: 30 }, () => ({ code: name, message: name, paths: [name, name, name, name, name, name] }));
      const many = { kind: 'finalize-check' as const, ready: false, tip: null, tree: null, problems: loggedProblems(problems) };
      expect(Buffer.byteLength(serializeRecord({ v: 1, at: '2026-11-21T12:00:00.000Z', ...valid(many) } as LogRecord))).toBeLessThan(40 * 1024);
    }
  });
});

describe('entries', () => {
  it('summarizes integrity and scope results', () => {
    const report: IntegrityReport = { ok: false, violations: [{ code: 'user-refs', message: 'Your branch moved.' }], baseline: BASELINE };
    expect(valid(integrityEntry('api', 0, report))).toEqual({
      kind: 'integrity',
      task: 'api',
      round: 0,
      ok: false,
      problems: { shown: [{ code: 'user-refs', message: 'Your branch moved.', paths: [] }], more: 0 },
    });
    const scope: ScopeReport = {
      clean: false,
      fromCommit: SHA('1'),
      fromTree: SHA('2'),
      tree: SHA('3'),
      changes: [{ path: 'docs/x.md', status: 'A', oldMode: '000000', newMode: '100644', oldId: SHA('0'), newId: SHA('4') }],
      violations: [{ path: 'docs/x.md', code: 'outside-owns', message: 'Added docs/x.md outside the owned paths.' }],
      ignored: [],
    };
    expect(valid(scopeEntry('api', 1, { ok: true, report: scope }))).toMatchObject({
      clean: false,
      files: 1,
      problems: { shown: [{ code: 'outside-owns', paths: ['docs/x.md'] }], more: 0 },
    });
    expect(valid(scopeEntry('api', 1, { ok: false, error: { code: 'worktree-tampered', message: 'gone' } }))).toMatchObject({
      clean: false,
      files: 0,
      problems: { shown: [{ code: 'worktree-tampered', message: 'gone' }] },
    });
  });

  it('summarizes commits, gates and merges', () => {
    expect(valid(commitEntry('api', 0, SHA('a'), 3))).toEqual({ kind: 'commit', task: 'api', round: 0, commit: SHA('a'), files: 3 });
    expect(valid(gateEntry('api', 0, { passed: false, summary: 's'.repeat(5000) }))).toMatchObject({ passed: false, summary: expect.stringMatching(/…$/) });
    expect(valid(mergeEntry('api', { ok: true, merged: true, tip: SHA('c'), changes: [] }))).toEqual({
      kind: 'merge',
      task: 'api',
      merged: true,
      tip: SHA('c'),
      files: 0,
      refused: null,
    });
    expect(valid(mergeEntry('api', { ok: false, error: { code: 'overlap', message: 'Both changed a.ts.', paths: ['a.ts'] } }))).toMatchObject({
      merged: false,
      tip: null,
      refused: { code: 'overlap', paths: ['a.ts'] },
    });
  });

  it('summarizes reviews, accepted or refused', () => {
    const working = newTaskReview({ id: 'api', acceptance: { criteria: ['works'] } }, { maxRevisionRounds: 2 });
    const step = recordGate(working, { passed: true, summary: 'ok' });
    const awaiting = (step.ok ? step.state : working) as TaskReview;
    expect(valid(reviewEntry(awaiting, recordReview(awaiting, passingReview(['works']))))).toEqual({
      kind: 'review',
      task: 'api',
      round: 0,
      verdict: 'accept',
      status: 'accepted',
      refused: null,
    });
    expect(valid(reviewEntry(awaiting, recordReview(awaiting, { verdict: 'accept' })))).toMatchObject({
      verdict: null,
      status: 'awaiting-review',
      refused: { code: 'invalid-review' },
    });
  });

  it('summarizes a finalize report and a note', () => {
    const report: FinalizeReport = {
      ready: false,
      runId: 'run1',
      targetBranch: 'main',
      baseSha: SHA('b'),
      integrationTip: SHA('c'),
      target: { branch: 'main', tip: SHA('b'), moved: false, newCommits: 0, tree: SHA('d'), changes: [], overlap: [] },
      tasks: [],
      checkouts: [],
      acceptance: null,
      problems: [{ code: 'unsaved-work', message: 'Unsaved work in src/a.ts.', paths: ['src/a.ts'] }],
      notes: [],
    };
    expect(valid(finalizeEntry(report))).toEqual({
      kind: 'finalize-check',
      ready: false,
      tip: SHA('b'),
      tree: SHA('d'),
      problems: { shown: [{ code: 'unsaved-work', message: 'Unsaved work in src/a.ts.', paths: ['src/a.ts'] }], more: 0 },
    });
    expect(valid(finalizeEntry({ ...report, target: null }))).toMatchObject({ tip: null, tree: null });
    expect(valid(noteEntry('n'.repeat(3000)))).toMatchObject({ kind: 'note', message: expect.stringMatching(/…$/) });
  });

  it('builds worker and agent-config entries (step 10)', () => {
    expect(valid(workerEntry('api', 1, 'started', { engine: 'codex', model: 'gpt-6', exitCode: null, error: null }))).toEqual({
      kind: 'worker',
      task: 'api',
      round: 1,
      event: 'started',
      engine: 'codex',
      model: 'gpt-6',
      exitCode: null,
      error: null,
    });
    const finished = valid(workerEntry('api', 1, 'finished', { engine: 'claude', model: 'opus', exitCode: 1, error: 'e'.repeat(5000) }));
    expect(finished).toMatchObject({ exitCode: 1, error: expect.stringMatching(/…$/) });
    expect(valid(agentConfigEntry('api', 0, { ok: true, changes: [], incomplete: [] }))).toEqual({
      kind: 'agent-config',
      task: 'api',
      round: 0,
      ok: true,
      problems: { shown: [], more: 0 },
    });
    const changed = valid(
      agentConfigEntry('api', 2, {
        ok: false,
        changes: [{ path: '/h/.claude/settings.json', change: 'changed' }],
        incomplete: ['/h/.claude/skills has more than 5000 entries; only the first were compared.'],
      }),
    );
    expect(changed).toEqual({
      kind: 'agent-config',
      task: 'api',
      round: 2,
      ok: false,
      problems: {
        shown: [
          { code: 'changed', message: '/h/.claude/settings.json was changed while the worker ran.', paths: ['/h/.claude/settings.json'] },
          { code: 'incomplete', message: '/h/.claude/skills has more than 5000 entries; only the first were compared.', paths: [] },
        ],
        more: 0,
      },
    });
  });
});
