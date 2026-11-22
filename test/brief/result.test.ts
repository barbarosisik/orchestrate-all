import { describe, expect, it } from 'vitest';
import { MAX_RESULT_TEXT_CHARS, parseWorkerResult, RESULT_TEMPLATE } from '../../src/brief/result.js';

const FILLED = {
  task_id: 'api',
  status: 'completed',
  summary: 'Added the handler.',
  files_changed: [{ path: 'src/api/h.ts', change: 'added', purpose: 'the handler' }],
  interfaces: [{ name: 'handle', kind: 'function', location: 'src/api/h.ts', signature: 'handle(req: Req): Res', change: 'added' }],
  decisions: [{ decision: 'Return 404 for unknown ids', reason: 'matches the other handlers' }],
  assumptions: [],
  verification: [{ command: 'npm test', exit_code: 0, result: '12 passed' }],
  deviations_from_brief: [],
  reserved_change_requests: [],
  open_questions: [],
  blockers: [],
  follow_ups: [],
  suspicious_content: [],
};

function fenced(value: unknown): string {
  return `Done.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

describe('worker result', () => {
  it('reads the last JSON block of the final message', () => {
    const text = `${fenced({ ...FILLED, summary: 'an earlier draft' })}\nThen:\n${fenced(FILLED)}`;
    const parsed = parseWorkerResult(text, 'api');
    expect(parsed).toEqual({ ok: true, result: FILLED });
  });

  it('accepts a bare JSON object, and fills in lists the worker left out', () => {
    const parsed = parseWorkerResult(JSON.stringify({ task_id: 'api', status: 'blocked', summary: 'Needs package.json.', extra: 1 }), 'api');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.result.files_changed).toEqual([]);
      expect(parsed.result.blockers).toEqual([]);
      expect('extra' in parsed.result).toBe(false);
    }
  });

  it('refuses a result for another task', () => {
    expect(parseWorkerResult(fenced({ ...FILLED, task_id: 'web' }), 'api')).toEqual({ ok: false, problem: { code: 'wrong-task', message: 'The result is for task "web", not "api".' } });
  });

  it('says what is wrong with a missing, unreadable or malformed result', () => {
    expect(parseWorkerResult(null, 'api')).toMatchObject({ ok: false, problem: { code: 'no-result' } });
    expect(parseWorkerResult('All done, no JSON.', 'api')).toMatchObject({ ok: false, problem: { code: 'no-result' } });
    expect(parseWorkerResult('```json\n{ "task_id": \n```', 'api')).toMatchObject({ ok: false, problem: { code: 'invalid-json' } });
    const bad = parseWorkerResult(fenced({ ...FILLED, status: 'great' }), 'api');
    expect(bad).toMatchObject({ ok: false, problem: { code: 'invalid' } });
    if (!bad.ok) expect(bad.problem.message).toContain('status');
  });

  it('reads only the end of a very long message', () => {
    const text = `${fenced(FILLED)}${'x'.repeat(MAX_RESULT_TEXT_CHARS)}`;
    expect(parseWorkerResult(text, 'api')).toMatchObject({ ok: false, problem: { code: 'no-result' } });
  });

  it('shows a template whose shape the parser accepts once filled in', () => {
    expect(RESULT_TEMPLATE).toContain('"task_id"');
    const keys = Object.keys(JSON.parse(RESULT_TEMPLATE.replace(/"[a-z ]+(?: \| [a-z ]+)+"/g, '"x"')) as object);
    expect(keys).toEqual(Object.keys(FILLED));
  });
});
