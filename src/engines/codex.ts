/**
 * The Codex adapter (step 10, research §5.2 and research/02-codex.md).
 *
 * Command line, and why each part is there:
 * - `exec --json … -`: a headless run printing JSON Lines, reading the brief from stdin (which is then
 *   closed: Codex waits for the end of stdin).
 * - `--sandbox workspace-write`: Codex's own OS sandbox. Its commands and its file edits may write only in the
 *   worktree and the temp folders; `.git` stays read-only (also the git folder a worktree's `.git` file points
 *   to), so a Codex worker cannot commit, which fits "only the conductor does git". Network is off by default.
 *   `codex exec` never asks for approval: whatever the sandbox refuses fails, and the model is told.
 * - `--cd <worktree>`: the working root.
 * - `--ignore-user-config`: the user's `config.toml` (MCP servers, profiles, project trust) doesn't load; the
 *   sign-in still does. A project's own `.codex/` config loads only for trusted projects, and without the
 *   user config nothing is trusted.
 * - `--ignore-rules`: the user's and the project's execpolicy rules can't let commands run outside the sandbox.
 * - `--disable hooks|apps|plugins`: no hooks, ChatGPT connectors or plugins (PLAN §4: no hooks, no MCP).
 * - `--ephemeral`: the session isn't kept for resuming; the run folder keeps the output instead.
 * Never used (research §5.2): `--yolo`, `--trust`, `danger-full-access`, `forced_login_method` (a mismatch
 * logs the user out).
 *
 * A call to an MCP tool means an MCP server was loaded after all; that is a violation and fails the run.
 *
 * Tokens come from `turn.completed`, whose usage is the thread's running total, so the last one counts.
 * Codex's `input_tokens` include the cached ones (Claude counts them apart); they are stored as reported.
 */

import { checkedModel, type EngineAdapter, type WorkerRequest } from './adapter.js';
import { countOf, isObject, ReportBuilder, textOf, type EngineParser } from './report.js';

function launch(request: WorkerRequest) {
  return {
    args: [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--cd',
      request.worktree,
      '--sandbox',
      'workspace-write',
      '--model',
      checkedModel(request.model),
      '--disable',
      'hooks',
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '-',
    ],
    stdin: request.brief,
  };
}

function message(value: unknown): string | null {
  return isObject(value) ? textOf(value.message) : null;
}

function parser(): EngineParser {
  const report = new ReportBuilder();
  let completed = false;
  let failed = false;

  const item = (value: unknown): void => {
    if (!isObject(value)) return;
    if (value.type === 'agent_message') {
      const text = textOf(value.text);
      if (text !== null) report.result = text;
    } else if (value.type === 'command_execution' && value.status === 'declined') {
      report.denied += 1;
      report.deniedTool(`command: ${textOf(value.command) ?? '?'}`);
    } else if (value.type === 'error') {
      const text = textOf(value.message);
      if (text !== null) report.problem(text);
    } else if (value.type === 'mcp_tool_call') {
      report.violation(`Codex called an MCP tool (${textOf(value.server) ?? '?'}: ${textOf(value.tool) ?? '?'}), but workers run without MCP servers.`);
    }
  };

  return {
    line(text: string): void {
      const event = report.object(text);
      if (event === null) return;
      switch (event.type) {
        case 'thread.started':
          report.sessionId = textOf(event.thread_id) ?? report.sessionId;
          break;
        case 'item.completed':
          item(event.item);
          break;
        case 'turn.completed': {
          completed = true;
          const usage = event.usage;
          const input = isObject(usage) ? countOf(usage.input_tokens) : null;
          const output = isObject(usage) ? countOf(usage.output_tokens) : null;
          report.tokens =
            isObject(usage) && input !== null && output !== null
              ? {
                  input,
                  output,
                  cacheRead: countOf(usage.cached_input_tokens),
                  cacheWrite: countOf(usage.cache_write_input_tokens),
                  reasoning: countOf(usage.reasoning_output_tokens),
                  costUsd: null,
                }
              : report.tokens;
          break;
        }
        case 'turn.failed':
          failed = true;
          report.problem(message(event.error) ?? 'Codex reported a failed turn.');
          break;
        case 'error':
          failed = true;
          report.problem(textOf(event.message) ?? 'Codex reported an error.');
          break;
        default:
          break;
      }
    },
    skipped(): void {
      report.unreadableLine();
    },
    report() {
      report.succeeded = failed ? false : completed ? true : null;
      return report.report();
    },
  };
}

export const codexAdapter: EngineAdapter = { engine: 'codex', label: 'Codex', launch, parser };
