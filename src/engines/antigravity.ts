/**
 * The Antigravity CLI (`agy`) adapter (step 10, research §5.3 and research/03-gemini-antigravity.md), for the
 * Google lane the owner chose: `agy` on the user's Gemini API key (research §3, D1). Detection (detect.ts)
 * confirms API-key mode before any task goes to `agy`; Google's consumer terms don't allow wrapping it on a
 * subscription sign-in.
 *
 * Command line, as research §5.3 recommends:
 * - `--input-format stream-json --output-format stream-json`: the brief goes on stdin as one JSON line
 *   (`{"event":"user","message":{"content":…}}`), then stdin is closed, which ends the session.
 * - `--mode accept-edits`: edits inside the workspace (the worktree) are allowed; anything that needs approval
 *   is soft-denied in a headless run: the run goes on, exits 0 and lists it in `denied_actions`.
 * - `--sandbox`: commands the user's settings allow still run sandboxed where agy supports it (on Windows only
 *   with Windows 11 24H2 and its August 2026 update; elsewhere it has no effect).
 * - `--disable-slash-commands`: a brief starting with "/" is text, not a command.
 * Never used: `--dangerously-skip-permissions`.
 *
 * This lane is the least verified (research §10): the flags and event shapes come from Antigravity's docs and
 * changelog, not from runs. Step 15 checks them on the owner's machine.
 */

import { checkedModel, type EngineAdapter, type WorkerRequest } from './adapter.js';
import { countOf, isObject, ReportBuilder, textOf, type EngineParser } from './report.js';

function launch(request: WorkerRequest) {
  return {
    args: [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '--model',
      checkedModel(request.model),
      '--disable-slash-commands',
      '--sandbox',
    ],
    stdin: `${JSON.stringify({ event: 'user', message: { content: request.brief } })}\n`,
  };
}

function describeDenial(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return null;
  return textOf(value.tool) ?? textOf(value.name) ?? textOf(value.action);
}

function parser(): EngineParser {
  const report = new ReportBuilder();

  const result = (value: unknown): void => {
    if (!isObject(value)) return;
    report.sessionId ??= textOf(value.conversation_id);
    const status = textOf(value.status);
    report.succeeded = status === 'SUCCESS';
    report.result = textOf(value.response);
    if (status !== 'SUCCESS') report.problem(`Antigravity ended with status ${status ?? 'unknown'}.`);
    const error = textOf(value.error) ?? (isObject(value.error) ? textOf(value.error.message) : null);
    if (error !== null) report.problem(error);
    const usage = value.usage;
    const input = isObject(usage) ? countOf(usage.input_tokens) : null;
    const output = isObject(usage) ? countOf(usage.output_tokens) : null;
    report.tokens =
      isObject(usage) && input !== null && output !== null
        ? { input, output, cacheRead: countOf(usage.cache_read_tokens), cacheWrite: null, reasoning: countOf(usage.thinking_tokens), costUsd: null }
        : null;
    if (Array.isArray(value.denied_actions)) {
      report.denied = value.denied_actions.length;
      for (const denial of value.denied_actions) {
        const name = describeDenial(denial);
        if (name !== null) report.deniedTool(name);
      }
    }
  };

  return {
    line(text: string): void {
      const event = report.object(text);
      if (event === null) return;
      if (event.event === 'init') report.sessionId = textOf(event.conversation_id) ?? report.sessionId;
      else if (event.event === 'result') result(event.result);
    },
    skipped(): void {
      report.unreadableLine();
    },
    report: () => report.report(),
  };
}

export const antigravityAdapter: EngineAdapter = { engine: 'antigravity', label: 'Antigravity', launch, parser };
