/**
 * Log entries for the conductor's decisions (step 9), built from the results the earlier steps return. An
 * entry is a summary: counts, codes and the first problems, with long text cut (ending in "…") and long lists
 * counted in `more`. Text is measured as it will be written, in bytes of JSON (non-ASCII letters take 2-4
 * bytes, a control character 6), so even paths a worker chose to be long and strange keep a record near
 * 32 KiB at most (LOG_LIMITS), well under the log's line limit. The full results are saved separately: each
 * gate per task and round, and the last finalize report.
 */

import type { FinalizeReport } from '../finalize/check.js';
import type { IntegrityReport } from '../integrity/check.js';
import type { MergeResult } from '../merge/integration.js';
import type { GateSummary, TaskReview, Transition } from '../review/state.js';
import type { ScopeCheck } from '../scope/check.js';
import { LOG_LIMITS, type LogEntry, type LoggedProblem, type LoggedProblems } from './schema.js';

/** Bytes `text` takes inside a JSON string. */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** The first `count` characters, without splitting a character made of two UTF-16 units. */
function head(text: string, count: number): string {
  const cut = text.slice(0, count);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** `text`, cut so that it takes at most `maxBytes` bytes as JSON, with "…" at the end when cut. */
export function clipText(text: string, maxBytes: number = LOG_LIMITS.text): string {
  if (jsonBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(`${head(text, mid)}…`) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${head(text, low)}…`;
}

interface ProblemLike {
  readonly code: string;
  readonly message: string;
  readonly paths?: readonly string[];
}

function loggedProblem(p: ProblemLike): LoggedProblem {
  return {
    code: clipText(p.code, LOG_LIMITS.code),
    message: clipText(p.message, LOG_LIMITS.message),
    paths: (p.paths ?? []).slice(0, LOG_LIMITS.paths).map((path) => clipText(path, LOG_LIMITS.path)),
  };
}

export function loggedProblems(items: readonly ProblemLike[]): LoggedProblems {
  return { shown: items.slice(0, LOG_LIMITS.items).map(loggedProblem), more: Math.max(0, items.length - LOG_LIMITS.items) };
}

export function integrityEntry(task: string, round: number, report: IntegrityReport): LogEntry {
  return { kind: 'integrity', task, round, ok: report.ok, problems: loggedProblems(report.violations) };
}

export function scopeEntry(task: string, round: number, check: ScopeCheck): LogEntry {
  if (!check.ok) return { kind: 'scope', task, round, clean: false, files: 0, problems: loggedProblems([check.error]) };
  const { report } = check;
  return {
    kind: 'scope',
    task,
    round,
    clean: report.clean,
    files: report.changes.length,
    problems: loggedProblems(report.violations.map((v) => ({ code: v.code, message: v.message, paths: [v.path] }))),
  };
}

export function commitEntry(task: string, round: number, commit: string, files: number): LogEntry {
  return { kind: 'commit', task, round, commit, files };
}

/** From a GateResult or the GateSummary the review state keeps. */
export function gateEntry(task: string, round: number, gate: GateSummary): LogEntry {
  return { kind: 'gate', task, round, passed: gate.passed, summary: clipText(gate.summary) };
}

/** A review submitted for `before`, and what recordReview made of it. */
export function reviewEntry(before: TaskReview, result: Transition): LogEntry {
  const round = before.attempts.at(-1)?.round ?? 0;
  if (!result.ok) {
    return { kind: 'review', task: before.taskId, round, verdict: null, status: before.status, refused: loggedProblem(result.error) };
  }
  const verdict = result.state.attempts.at(-1)?.review?.verdict ?? null;
  return { kind: 'review', task: before.taskId, round, verdict, status: result.state.status, refused: null };
}

export function mergeEntry(task: string, result: MergeResult): LogEntry {
  if (!result.ok) return { kind: 'merge', task, merged: false, tip: null, files: 0, refused: loggedProblem(result.error) };
  return { kind: 'merge', task, merged: result.merged, tip: result.tip, files: result.changes.length, refused: null };
}

export function finalizeEntry(report: FinalizeReport): LogEntry {
  return {
    kind: 'finalize-check',
    ready: report.ready,
    tip: report.target?.tip ?? null,
    tree: report.target?.tree ?? null,
    problems: loggedProblems(report.problems),
  };
}

export function noteEntry(message: string): LogEntry {
  return { kind: 'note', message: clipText(message) };
}
