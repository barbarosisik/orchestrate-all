/**
 * The Claude Code adapter (step 10, research §5.1 and research/01-claude-code.md).
 *
 * Command line, and why each part is there:
 * - `-p --output-format stream-json --verbose`: a headless run printing JSON events (stream-json needs
 *   `--verbose`). The brief goes on stdin.
 * - `--permission-mode acceptEdits`: Claude may edit files inside its working directory (the worktree); any
 *   other action needs approval, which a headless run refuses. Orchestra passes no allow rules of its own.
 *   The mode is always passed explicitly: before 2.1.302, `-p` could start in auto mode.
 * - `--setting-sources project`: the project's CLAUDE.md, rules and settings load; the user's personal
 *   settings, hooks and MCP servers don't (PLAN §4, "project rules only"). Before Claude Code 2.1.101 this
 *   flag could delete conversation history older than 30 days, so detection (detect.ts) refuses older versions.
 * - `--strict-mcp-config`: no MCP servers, not even the project's `.mcp.json`, which `-p` would otherwise start
 *   without asking (research §5.6).
 * - `--settings '{"disableAllHooks":true}'`, given inline: the project's hooks don't run (PLAN §4: no project
 *   hooks). Inline, so no settings file exists that another worker could rewrite before Claude reads it (Codex's
 *   sandbox may write the temp folder).
 * - `--disallowedTools Bash Monitor` unless the run allows a shell (PLAN §4): the tools that run commands (turning
 *   off Bash also turns off PowerShell).
 * - A brief may not start with "/": Claude would read it as one of its commands.
 *
 * Its event stream is checked against these choices, failing closed: the init event must be there and report
 * subscription billing (`apiKeySource: "none"`), the `acceptEdits` mode, an empty list of MCP servers, the
 * worktree as its folder (when it says) and, with the shell off, a list of tools without a shell tool. Anything
 * missing or different is a violation and fails the run. A run can end in "success" with refused actions
 * (`permission_denials`); they are counted, not hidden.
 *
 * Known limits (see docs/HANDOFF.md): a repository the user trusted in Claude Code can widen what the worker
 * may do with its own `.claude/settings.json` (allow rules, extra directories, an API key helper). The
 * conductor's checks after the worker (integrity, scope, agent config folders) stay the final word.
 */

import { canonicalPath, DEFAULT_CASE_INSENSITIVE, samePath } from '../repo/canonical.js';
import { checkedModel, type EngineAdapter, type WorkerRequest } from './adapter.js';
import { costOf, countOf, isObject, ReportBuilder, textOf, type EngineParser } from './report.js';

export const CLAUDE_PERMISSION_MODE = 'acceptEdits';
/** The settings every Claude worker starts with, given on the command line. */
export const CLAUDE_WORKER_SETTINGS = JSON.stringify({ disableAllHooks: true });
/** Tools that run commands. */
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor'];

const ENDINGS: Readonly<Record<string, string>> = {
  error_max_turns: 'Claude stopped at its turn limit.',
  error_max_budget_usd: 'Claude stopped at its budget limit.',
  error_during_execution: 'Claude failed while working.',
  error_max_structured_output_retries: 'Claude could not produce its structured result.',
};

function launch(request: WorkerRequest) {
  if (request.brief.trimStart().startsWith('/')) throw new Error('A brief for Claude Code must not start with "/": Claude would read it as a command.');
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    checkedModel(request.model),
    '--permission-mode',
    CLAUDE_PERMISSION_MODE,
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--settings',
    CLAUDE_WORKER_SETTINGS,
  ];
  // A list option takes every value up to the next option, so it comes last; nothing follows it (the brief is on stdin).
  if (!request.shell) args.push('--disallowedTools', 'Bash', 'Monitor');
  return { args, stdin: request.brief };
}

function toolNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tool): tool is string => typeof tool === 'string') : [];
}

function parser(request: WorkerRequest): EngineParser {
  const report = new ReportBuilder();
  let streamDenials = 0;
  let resultDenials: number | null = null;
  let initSeen = false;

  const init = (event: Record<string, unknown>): void => {
    initSeen = true;
    report.sessionId = textOf(event.session_id) ?? report.sessionId;
    const source = textOf(event.apiKeySource);
    if (source === null) report.violation('Claude did not report how it is billed (apiKeySource).');
    else {
      report.billing = source === 'none' ? 'subscription' : 'api';
      if (source !== 'none') report.violation(`Claude ran on ${source} instead of your subscription.`);
    }
    const mode = textOf(event.permissionMode);
    if (mode !== CLAUDE_PERMISSION_MODE) {
      report.violation(mode === null ? 'Claude did not report its permission mode.' : `Claude started in "${mode}" mode, not "${CLAUDE_PERMISSION_MODE}".`);
    }
    if (!Array.isArray(event.mcp_servers)) report.violation('Claude did not list its MCP servers.');
    else if (event.mcp_servers.length > 0) {
      const names = event.mcp_servers.map((server) => (isObject(server) ? textOf(server.name) : null) ?? '?');
      report.violation(`Claude loaded MCP servers (${names.join(', ')}), which workers run without.`);
    }
    const cwd = textOf(event.cwd);
    if (cwd !== null && !samePath(canonicalPath(cwd) ?? cwd, canonicalPath(request.worktree) ?? request.worktree, DEFAULT_CASE_INSENSITIVE)) {
      report.violation(`Claude worked in ${cwd}, not in the task's worktree.`);
    }
    if (!request.shell) {
      if (!Array.isArray(event.tools)) report.violation('Claude did not list its tools, so the shell being off could not be checked.');
      for (const tool of toolNames(event.tools).filter((name) => SHELL_TOOLS.includes(name))) {
        report.violation(`Claude had its shell tool (${tool}), which this run turns off.`);
      }
    }
  };

  const result = (event: Record<string, unknown>): void => {
    report.sessionId = textOf(event.session_id) ?? report.sessionId;
    const subtype = textOf(event.subtype);
    report.succeeded = subtype === 'success' && event.is_error !== true;
    report.result = subtype === 'success' ? textOf(event.result) : null;
    if (subtype !== 'success') {
      // The subtype is the engine's text: only the table's own entries count ("constructor" is not one).
      const known = subtype !== null && Object.hasOwn(ENDINGS, subtype) ? ENDINGS[subtype] : undefined;
      report.problem(known ?? `Claude ended with "${subtype ?? 'no result'}".`);
    }
    for (const error of toolNames(event.errors)) report.problem(error);
    const usage = event.usage;
    const input = isObject(usage) ? countOf(usage.input_tokens) : null;
    const output = isObject(usage) ? countOf(usage.output_tokens) : null;
    report.tokens =
      isObject(usage) && input !== null && output !== null
        ? {
            input,
            output,
            cacheRead: countOf(usage.cache_read_input_tokens),
            cacheWrite: countOf(usage.cache_creation_input_tokens),
            reasoning: null,
            costUsd: costOf(event.total_cost_usd),
          }
        : null;
    if (Array.isArray(event.permission_denials)) {
      resultDenials = event.permission_denials.length;
      for (const denial of event.permission_denials) {
        const name = isObject(denial) ? textOf(denial.tool_name) : null;
        if (name !== null) report.deniedTool(name);
      }
    }
  };

  return {
    line(text: string): void {
      const event = report.object(text);
      if (event === null) return;
      if (event.type === 'system' && event.subtype === 'init') init(event);
      else if (event.type === 'system' && event.subtype === 'permission_denied') {
        streamDenials += 1;
        const name = textOf(event.tool_name);
        if (name !== null) report.deniedTool(name);
      } else if (event.type === 'result') result(event);
    },
    skipped(): void {
      report.unreadableLine();
    },
    report() {
      report.denied = resultDenials ?? streamDenials;
      if (!initSeen) report.violation('Claude did not report how it started (no init event), so its billing and permission mode could not be checked.');
      return report.report();
    },
  };
}

export const claudeAdapter: EngineAdapter = { engine: 'claude', label: 'Claude Code', launch, parser };
