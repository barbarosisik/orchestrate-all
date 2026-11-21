/**
 * What Orchestra makes of an engine's event stream (step 10), the same for every engine: the session id, whether
 * the engine said it finished, its final message, the tokens it reported, the actions it refused (a headless
 * run has nobody to ask, so a refused action is a signal, research §5.0), its errors, and anything that breaks
 * the conditions Orchestra started it under (`violations`: API billing, another permission mode, MCP servers,
 * a shell that should be off). A violation makes the run count as failed.
 *
 * An engine's output is untrusted input: every field is checked for its type, unknown events are ignored, and
 * what is kept is bounded (a few problems and tool names, a final message cut at MAX_RESULT_CHARS).
 */

import type { TokenUsage } from '../store/schema.js';

export const MAX_RESULT_CHARS = 256 * 1024;
/** Problems, violations and refused tool names kept per run. */
export const MAX_LISTED = 10;
const MAX_ITEM_CHARS = 500;

export type Billing = 'subscription' | 'api' | 'unknown';

export interface EngineReport {
  /** The engine's own id for the session, or null if it gave none. */
  readonly sessionId: string | null;
  /** Whether the engine reported finishing its work; null when no final result was seen. */
  readonly succeeded: boolean | null;
  /** The engine's final message, cut to MAX_RESULT_CHARS. */
  readonly result: string | null;
  readonly tokens: TokenUsage | null;
  /** Actions the engine refused because nobody could approve them. */
  readonly denied: number;
  /** The first refused tools' names. */
  readonly deniedTools: readonly string[];
  /** Errors and warnings the engine reported, as plain sentences. */
  readonly problems: readonly string[];
  /** Conditions of Orchestra's that the run broke; any makes the run fail. */
  readonly violations: readonly string[];
  /** Lines that were not JSON objects, or too long to read. */
  readonly unreadableLines: number;
  /** How the run was billed, when the engine says (Claude reports it). */
  readonly billing: Billing;
}

export interface EngineParser {
  /** One line of the engine's standard output. */
  line(text: string): void;
  /** A line too long to read was skipped. */
  skipped(bytes: number): void;
  report(): EngineReport;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A token count: a non-negative whole number, or null. */
export function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function costOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A JSON object from one line, or null when the line is not one. */
export function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Collects a report while lines arrive. */
export class ReportBuilder {
  sessionId: string | null = null;
  succeeded: boolean | null = null;
  tokens: TokenUsage | null = null;
  denied = 0;
  billing: Billing = 'unknown';
  private resultText: string | null = null;
  private readonly tools: string[] = [];
  private readonly problemList: string[] = [];
  private readonly violationList: string[] = [];
  private unreadable = 0;

  set result(text: string | null) {
    this.resultText = text === null ? null : clip(text, MAX_RESULT_CHARS);
  }

  problem(message: string): void {
    add(this.problemList, clip(message, MAX_ITEM_CHARS));
  }

  violation(message: string): void {
    add(this.violationList, clip(message, MAX_ITEM_CHARS));
  }

  deniedTool(name: string): void {
    add(this.tools, clip(name, 100));
  }

  unreadableLine(): void {
    this.unreadable += 1;
  }

  /** Reads `line` as a JSON object, counting it as unreadable when it isn't one. */
  object(line: string): Record<string, unknown> | null {
    const event = parseObject(line);
    if (event === null) this.unreadableLine();
    return event;
  }

  report(): EngineReport {
    return {
      sessionId: this.sessionId,
      succeeded: this.succeeded,
      result: this.resultText,
      tokens: this.tokens,
      denied: this.denied,
      deniedTools: [...this.tools],
      problems: [...this.problemList],
      violations: [...this.violationList],
      unreadableLines: this.unreadable,
      billing: this.billing,
    };
  }
}

function add(list: string[], item: string): void {
  if (list.length < MAX_LISTED && !list.includes(item)) list.push(item);
}
