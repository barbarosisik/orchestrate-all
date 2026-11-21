import { describe, expect, it } from 'vitest';
import type { WorkerRequest } from '../../src/engines/adapter.js';
import { codexAdapter } from '../../src/engines/codex.js';

const REQUEST: WorkerRequest = { model: 'gpt-6-codex', worktree: '/wt/run/task', brief: 'Do the task.', shell: false };

function parse(lines: readonly (string | object)[]) {
  const parser = codexAdapter.parser(REQUEST);
  for (const line of lines) parser.line(typeof line === 'string' ? line : JSON.stringify(line));
  return parser.report();
}

const STARTED = { type: 'thread.started', thread_id: '0199a213-81c0' };
const USAGE = { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 12, output_tokens: 122, reasoning_output_tokens: 30 };

describe('codexAdapter.launch', () => {
  it("starts `codex exec` reading stdin, in the worktree's sandbox, without the user's config, rules, hooks, apps or plugins", () => {
    const launch = codexAdapter.launch(REQUEST);
    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--cd',
      '/wt/run/task',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-6-codex',
      '--disable',
      'hooks',
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '-',
    ]);
    expect(launch.stdin).toBe('Do the task.');
  });

  it('never uses the flags research §5.2 rules out', () => {
    const args = codexAdapter.launch({ ...REQUEST, shell: true }).args;
    for (const flag of ['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--trust', 'danger-full-access', '--full-auto']) {
      expect(args).not.toContain(flag);
    }
    expect(args.join(' ')).not.toContain('forced_login_method');
  });

  it('refuses a model name that could read as a flag', () => {
    expect(() => codexAdapter.launch({ ...REQUEST, model: '-s' })).toThrow();
  });
});

describe('codexAdapter.parser', () => {
  it('reads a completed turn: thread id, last agent message and the cumulative tokens', () => {
    const report = parse([
      STARTED,
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Working on it.' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } },
      { type: 'turn.completed', usage: { ...USAGE, input_tokens: 100, output_tokens: 1 } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: USAGE },
    ]);
    expect(report).toEqual({
      sessionId: '0199a213-81c0',
      succeeded: true,
      result: 'Done.',
      tokens: { input: 24763, output: 122, cacheRead: 24448, cacheWrite: 12, reasoning: 30, costUsd: null },
      denied: 0,
      deniedTools: [],
      problems: [],
      violations: [],
      unreadableLines: 0,
      billing: 'unknown',
    });
  });

  it('reports a failed turn with its message', () => {
    const report = parse([STARTED, { type: 'turn.failed', error: { message: 'model overloaded' } }]);
    expect(report.succeeded).toBe(false);
    expect(report.problems).toEqual(['model overloaded']);
  });

  it('fails the run on a stream error, even after a completed turn', () => {
    const report = parse([STARTED, { type: 'turn.completed', usage: USAGE }, { type: 'error', message: 'stream closed' }]);
    expect(report.succeeded).toBe(false);
    expect(report.problems).toEqual(['stream closed']);
  });

  it('keeps warnings Codex reports as error items without failing the run', () => {
    const report = parse([
      STARTED,
      { type: 'item.completed', item: { id: 'w', type: 'error', message: 'AGENTS.md was truncated to 32 KiB' } },
      { type: 'turn.completed', usage: USAGE },
    ]);
    expect(report.succeeded).toBe(true);
    expect(report.problems).toEqual(['AGENTS.md was truncated to 32 KiB']);
  });

  it('counts commands the sandbox declined', () => {
    const report = parse([
      STARTED,
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'curl example.com', status: 'declined', exit_code: null } },
      { type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'npm test', status: 'completed', exit_code: 0 } },
      { type: 'turn.completed', usage: USAGE },
    ]);
    expect(report.denied).toBe(1);
    expect(report.deniedTools).toEqual(['command: curl example.com']);
  });

  it('flags a call to an MCP tool: workers run without MCP servers', () => {
    const report = parse([
      STARTED,
      { type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'projsrv', tool: 'run', arguments: {}, status: 'completed' } },
      { type: 'turn.completed', usage: USAGE },
    ]);
    expect(report.succeeded).toBe(true);
    expect(report.violations).toEqual(['Codex called an MCP tool (projsrv: run), but workers run without MCP servers.']);
    expect(parse([{ type: 'item.completed', item: { type: 'mcp_tool_call' } }]).violations).toEqual([
      'Codex called an MCP tool (?: ?), but workers run without MCP servers.',
    ]);
  });

  it('gives no verdict without a finished turn', () => {
    expect(parse([STARTED, { type: 'turn.started' }]).succeeded).toBeNull();
  });

  it('ignores unknown events and fields of the wrong type, and counts unreadable lines', () => {
    const report = parse([
      'garbage',
      { type: 'thread.started', thread_id: 5 },
      { type: 'item.updated', item: { type: 'todo_list', items: [] } },
      { type: 'item.completed', item: 'x' },
      { type: 'item.completed', item: { type: 'agent_message', text: 9 } },
      { type: 'turn.failed', error: 'x' },
      { type: 'turn.completed', usage: { input_tokens: 'a', output_tokens: 1 } },
    ]);
    expect(report.sessionId).toBeNull();
    expect(report.result).toBeNull();
    expect(report.tokens).toBeNull();
    expect(report.unreadableLines).toBe(1);
    expect(report.succeeded).toBe(false);
    expect(report.problems).toEqual(['Codex reported a failed turn.']);
  });

  it('keeps missing optional token kinds as null', () => {
    const report = parse([{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }]);
    expect(report.tokens).toEqual({ input: 10, output: 2, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null });
  });
});
