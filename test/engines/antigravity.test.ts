import { describe, expect, it } from 'vitest';
import type { WorkerRequest } from '../../src/engines/adapter.js';
import { antigravityAdapter } from '../../src/engines/antigravity.js';

const REQUEST: WorkerRequest = { model: 'gemini-4-neon', worktree: '/wt/run/task', brief: 'Do the "task".\nThen stop.', shell: false };

function parse(lines: readonly (string | object)[]) {
  const parser = antigravityAdapter.parser(REQUEST);
  for (const line of lines) parser.line(typeof line === 'string' ? line : JSON.stringify(line));
  return parser.report();
}

const INIT = { event: 'init', conversation_id: 'conv-1', init: { cwd: '/wt/run/task', tools: ['write_to_file'], permission_mode: 'accept-edits' } };
const RESULT = {
  event: 'result',
  result: {
    conversation_id: 'conv-1',
    status: 'SUCCESS',
    response: 'Finished.',
    duration_seconds: 12,
    num_turns: 3,
    usage: { input_tokens: 900, output_tokens: 300, thinking_tokens: 120, cache_read_tokens: 50, total_tokens: 1370 },
  },
};

describe('antigravityAdapter.launch', () => {
  it('starts a headless run with the brief as one stream-json line on stdin, editing within its workspace', () => {
    const launch = antigravityAdapter.launch(REQUEST);
    expect(launch.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '--model',
      'gemini-4-neon',
      '--disable-slash-commands',
      '--sandbox',
    ]);
    expect(launch.stdin.endsWith('\n')).toBe(true);
    expect(launch.stdin.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(launch.stdin)).toEqual({ event: 'user', message: { content: 'Do the "task".\nThen stop.' } });
  });

  it('never skips permissions', () => {
    expect(antigravityAdapter.launch({ ...REQUEST, shell: true }).args).not.toContain('--dangerously-skip-permissions');
  });

  it('refuses a model name that could read as a flag', () => {
    expect(() => antigravityAdapter.launch({ ...REQUEST, model: '--mode' })).toThrow();
  });
});

describe('antigravityAdapter.parser', () => {
  it('reads a successful run: conversation, response and tokens', () => {
    const report = parse([INIT, { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'write_to_file' } }, RESULT]);
    expect(report).toEqual({
      sessionId: 'conv-1',
      succeeded: true,
      result: 'Finished.',
      tokens: { input: 900, output: 300, cacheRead: 50, cacheWrite: null, reasoning: 120, costUsd: null },
      denied: 0,
      deniedTools: [],
      problems: [],
      violations: [],
      unreadableLines: 0,
      billing: 'unknown',
    });
  });

  it('counts soft-denied actions (agy still exits 0 for them)', () => {
    const report = parse([
      INIT,
      { event: 'result', result: { ...RESULT.result, denied_actions: [{ tool: 'run_command', target: 'npm test' }, 'read_url(https://x)', 7] } },
    ]);
    expect(report.succeeded).toBe(true);
    expect(report.denied).toBe(3);
    expect(report.deniedTools).toEqual(['run_command', 'read_url(https://x)']);
  });

  it('reports another status with its error', () => {
    const report = parse([INIT, { event: 'result', result: { status: 'ERROR', error: { message: 'quota exhausted' } } }]);
    expect(report.succeeded).toBe(false);
    expect(report.problems).toEqual(['Antigravity ended with status ERROR.', 'quota exhausted']);
    const text = parse([{ event: 'result', result: { status: 'CANCELED', error: 'cut short' } }]);
    expect(text.problems).toEqual(['Antigravity ended with status CANCELED.', 'cut short']);
  });

  it('gives no verdict without a result, and ignores what it does not know', () => {
    const report = parse(['{', { event: 'mystery' }, { event: 'init', conversation_id: 3 }, { event: 'result', result: 'x' }]);
    expect(report.succeeded).toBeNull();
    expect(report.sessionId).toBeNull();
    expect(report.unreadableLines).toBe(1);
  });

  it('takes the conversation id from the result when the init gave none', () => {
    expect(parse([RESULT]).sessionId).toBe('conv-1');
  });

  it('keeps only well-formed token counts', () => {
    const report = parse([{ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 1, output_tokens: -1 } } }]);
    expect(report.tokens).toBeNull();
  });
});
