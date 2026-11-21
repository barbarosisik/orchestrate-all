import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/engines/claude.js';
import type { WorkerRequest } from '../../src/engines/adapter.js';

const REQUEST: WorkerRequest = { model: 'opus', worktree: '/wt/run/task', brief: 'Do the task.', shell: false };

function parse(lines: readonly (string | object)[], request: WorkerRequest = REQUEST) {
  const parser = claudeAdapter.parser(request);
  for (const line of lines) parser.line(typeof line === 'string' ? line : JSON.stringify(line));
  return parser.report();
}

const INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/wt/run/task',
  session_id: 'b379-session',
  tools: ['Task', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
  mcp_servers: [],
  model: 'claude-opus',
  permissionMode: 'acceptEdits',
  apiKeySource: 'none',
  claude_code_version: '2.1.328',
};

const SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 5,
  result: 'DONE',
  session_id: 'b379-session',
  total_cost_usd: 0.0019,
  usage: { input_tokens: 60, output_tokens: 83, cache_read_input_tokens: 1200, cache_creation_input_tokens: 40 },
  permission_denials: [],
};

describe('claudeAdapter.launch', () => {
  it('starts a headless run on project settings only, editing within its worktree, without hooks, MCP servers or a shell', () => {
    const launch = claudeAdapter.launch(REQUEST);
    expect(launch.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
      '--permission-mode',
      'acceptEdits',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--disallowedTools',
      'Bash',
      'Monitor',
    ]);
    // Given inline: no settings file exists that another worker could rewrite before Claude reads it.
    expect(Object.keys(launch)).toEqual(['args', 'stdin']);
  });

  it('puts the brief on stdin, never on the command line', () => {
    const launch = claudeAdapter.launch({ ...REQUEST, brief: 'secret plan -- --flag' });
    expect(launch.stdin).toBe('secret plan -- --flag');
    expect(launch.args.join(' ')).not.toContain('secret plan');
  });

  it('keeps the shell tools when the run allows them', () => {
    const launch = claudeAdapter.launch({ ...REQUEST, shell: true });
    expect(launch.args).not.toContain('--disallowedTools');
    expect(launch.args).not.toContain('Bash');
  });

  it('refuses a brief starting with "/", which Claude would read as one of its commands', () => {
    expect(() => claudeAdapter.launch({ ...REQUEST, brief: '/init' })).toThrow('must not start with "/"');
    expect(() => claudeAdapter.launch({ ...REQUEST, brief: '  \n/compact' })).toThrow();
    expect(claudeAdapter.launch({ ...REQUEST, brief: 'Edit src/a.ts, not /etc' }).stdin).toBe('Edit src/a.ts, not /etc');
  });

  it('refuses a model name the plan schema would not accept (a bug in the caller)', () => {
    expect(() => claudeAdapter.launch({ ...REQUEST, model: '--dangerously-skip-permissions' })).toThrow();
    expect(() => claudeAdapter.launch({ ...REQUEST, model: 'opus extra' })).toThrow();
  });
});

describe('claudeAdapter.parser', () => {
  it('reads a successful run: session, final message, tokens, cost and subscription billing', () => {
    const report = parse([INIT, { type: 'assistant', message: { content: [] } }, SUCCESS]);
    expect(report).toEqual({
      sessionId: 'b379-session',
      succeeded: true,
      result: 'DONE',
      tokens: { input: 60, output: 83, cacheRead: 1200, cacheWrite: 40, reasoning: null, costUsd: 0.0019 },
      denied: 0,
      deniedTools: [],
      problems: [],
      violations: [],
      unreadableLines: 0,
      billing: 'subscription',
    });
  });

  it('counts refused actions, even in a run that ends in "success"', () => {
    const report = parse([
      INIT,
      { type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 't1' },
      { ...SUCCESS, permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: {} }, { tool_name: 'WebFetch' }] },
    ]);
    expect(report.succeeded).toBe(true);
    expect(report.denied).toBe(2);
    expect(report.deniedTools).toEqual(['Write', 'WebFetch']);
  });

  it('counts refusals from the stream when the result lists none', () => {
    const report = parse([INIT, { type: 'system', subtype: 'permission_denied', tool_name: 'Edit' }, { ...SUCCESS, permission_denials: undefined }]);
    expect(report.denied).toBe(1);
    expect(report.deniedTools).toEqual(['Edit']);
  });

  it('reports a run that stopped at its turn limit as not finished', () => {
    const report = parse([INIT, { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (2)'], usage: SUCCESS.usage }]);
    expect(report.succeeded).toBe(false);
    expect(report.result).toBeNull();
    expect(report.problems).toEqual(['Claude stopped at its turn limit.', 'Reached maximum number of turns (2)']);
    expect(report.tokens?.input).toBe(60);
  });

  it('treats a "success" marked as an error as not finished', () => {
    expect(parse([INIT, { ...SUCCESS, is_error: true }]).succeeded).toBe(false);
  });

  it('describes other endings plainly', () => {
    expect(parse([{ type: 'result', subtype: 'error_during_execution', is_error: true }]).problems).toEqual(['Claude failed while working.']);
    expect(parse([{ type: 'result', subtype: 'error_max_budget_usd', is_error: true }]).problems).toEqual(['Claude stopped at its budget limit.']);
    expect(parse([{ type: 'result', subtype: 'something_new', is_error: true }]).problems).toEqual(['Claude ended with "something_new".']);
    expect(parse([{ type: 'result', is_error: true }]).problems).toEqual(['Claude ended with "no result".']);
  });

  it('reads endings named like built-in object properties as unknown endings', () => {
    for (const subtype of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parse([{ type: 'result', subtype, is_error: true }]).problems).toEqual([`Claude ended with "${subtype}".`]);
    }
  });

  it('flags a run billed to an API key instead of the subscription', () => {
    const report = parse([{ ...INIT, apiKeySource: 'ANTHROPIC_API_KEY' }, SUCCESS]);
    expect(report.billing).toBe('api');
    expect(report.violations).toEqual(['Claude ran on ANTHROPIC_API_KEY instead of your subscription.']);
  });

  it('flags a run that started in another permission mode than Orchestra asked for', () => {
    const report = parse([{ ...INIT, permissionMode: 'bypassPermissions' }, SUCCESS]);
    expect(report.violations).toEqual(['Claude started in "bypassPermissions" mode, not "acceptEdits".']);
  });

  it('flags MCP servers that were loaded', () => {
    const report = parse([{ ...INIT, mcp_servers: [{ name: 'projsrv', status: 'connected' }] }, SUCCESS]);
    expect(report.violations).toEqual(['Claude loaded MCP servers (projsrv), which workers run without.']);
  });

  it('flags a shell tool when the run has the shell off', () => {
    expect(parse([{ ...INIT, tools: ['Read', 'Bash'] }]).violations).toEqual(['Claude had its shell tool (Bash), which this run turns off.']);
    expect(parse([{ ...INIT, tools: ['Read', 'PowerShell'] }]).violations).toEqual([
      'Claude had its shell tool (PowerShell), which this run turns off.',
    ]);
    expect(parse([{ ...INIT, tools: ['Read', 'Monitor'] }]).violations).toEqual(['Claude had its shell tool (Monitor), which this run turns off.']);
    expect(parse([{ ...INIT, tools: ['Read', 'Bash'] }], { ...REQUEST, shell: true }).violations).toEqual([]);
  });

  it('fails closed: a run without an init event, or with fields missing from it, is a violation', () => {
    expect(parse([SUCCESS]).violations).toEqual([
      'Claude did not report how it started (no init event), so its billing and permission mode could not be checked.',
    ]);
    const { apiKeySource: _a, permissionMode: _p, mcp_servers: _m, tools: _t, ...bare } = INIT;
    expect(parse([bare, SUCCESS]).violations).toEqual([
      'Claude did not report how it is billed (apiKeySource).',
      'Claude did not report its permission mode.',
      'Claude did not list its MCP servers.',
      'Claude did not list its tools, so the shell being off could not be checked.',
    ]);
    // With the shell allowed, the tool list is not needed.
    const { tools: _tools, ...noTools } = INIT;
    expect(parse([noTools, SUCCESS], { ...REQUEST, shell: true }).violations).toEqual([]);
  });

  it('flags a run that reports working in another folder than its worktree', () => {
    expect(parse([{ ...INIT, cwd: '/home/user/project' }, SUCCESS]).violations).toEqual(['Claude worked in /home/user/project, not in the task\'s worktree.']);
    expect(parse([{ ...INIT, cwd: '/wt/run/task/' }, SUCCESS]).violations).toEqual([]);
  });

  it('ignores unknown events and counts lines that are not JSON objects', () => {
    const report = parse(['not json', '[1,2]', '"text"', { type: 'system', subtype: 'ui_invalidate' }, { type: 'stream_event' }, INIT, SUCCESS]);
    expect(report.succeeded).toBe(true);
    expect(report.unreadableLines).toBe(3);
  });

  it('counts skipped long lines as unreadable', () => {
    const parser = claudeAdapter.parser(REQUEST);
    parser.skipped(10_000_000);
    expect(parser.report().unreadableLines).toBe(1);
  });

  it('gives no verdict when no result arrived', () => {
    const report = parse([INIT]);
    expect(report.succeeded).toBeNull();
    expect(report.tokens).toBeNull();
  });

  it('keeps only well-formed token counts', () => {
    const report = parse([{ ...SUCCESS, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: -1, cache_creation_input_tokens: 'x' }, total_cost_usd: -3 }]);
    expect(report.tokens).toEqual({ input: 5, output: 7, cacheRead: null, cacheWrite: null, reasoning: null, costUsd: null });
    expect(parse([{ ...SUCCESS, usage: { input_tokens: 1.5, output_tokens: 7 } }]).tokens).toBeNull();
    expect(parse([{ ...SUCCESS, usage: 'none' }]).tokens).toBeNull();
  });

  it('takes fields of the wrong type as missing, and fails the checks they serve', () => {
    const report = parse([
      { type: 'system', subtype: 'init', session_id: 42, apiKeySource: 7, permissionMode: null, mcp_servers: 'x', tools: 'Bash' },
      { type: 'result', subtype: 'success', is_error: false, result: { text: 'x' }, permission_denials: 'many', errors: 'x' },
    ]);
    expect(report.sessionId).toBeNull();
    expect(report.billing).toBe('unknown');
    expect(report.violations).toEqual([
      'Claude did not report how it is billed (apiKeySource).',
      'Claude did not report its permission mode.',
      'Claude did not list its MCP servers.',
      'Claude did not list its tools, so the shell being off could not be checked.',
    ]);
    expect(report.result).toBeNull();
    expect(report.succeeded).toBe(true);
  });

  it('cuts a very long final message', () => {
    const report = parse([{ ...SUCCESS, result: 'x'.repeat(300 * 1024) }]);
    expect(report.result?.length).toBeLessThan(300 * 1024);
    expect(report.result?.endsWith('…')).toBe(true);
  });
});
