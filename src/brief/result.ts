/**
 * The result every worker ends with (step 11, research §6.5): one JSON object, the last thing it prints, in a
 * ```json block. The brief shows its shape (RESULT_TEMPLATE); parseWorkerResult reads it back from the engine's
 * final message.
 *
 * It is the worker's own account, never the truth: the conductor checks the real diff (scope), runs the
 * commands itself (the gate), and the reviewer judges. What it adds is data for later steps: a summary and the
 * interfaces and decisions dependents need (quoted to them as data), reserved-file requests, blockers and
 * suspicious content found in the repository.
 *
 * Read leniently: lists the worker left out count as empty and unknown fields are dropped; the types, the
 * status and the task id must be right.
 */

import { z } from 'zod';

export const WORKER_RESULT_STATUSES = ['completed', 'partial', 'blocked', 'failed'] as const;
export type WorkerResultStatus = (typeof WORKER_RESULT_STATUSES)[number];

/** Only the end of a final message is searched. */
export const MAX_RESULT_TEXT_CHARS = 256 * 1024;

const text = (max: number) => z.string().max(max);
const required = (max: number) => z.string().min(1).max(max);
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max).default([]);

export const WorkerResultSchema = z.object({
  task_id: required(64),
  status: z.enum(WORKER_RESULT_STATUSES),
  summary: required(4_000),
  files_changed: list(z.object({ path: required(1_000), change: z.enum(['added', 'modified', 'deleted']), purpose: text(1_000).default('') }), 500),
  interfaces: list(
    z.object({
      name: required(200),
      kind: required(50),
      location: required(1_000),
      signature: text(2_000).default(''),
      change: z.enum(['added', 'changed', 'removed']),
      notes: text(1_000).optional(),
    }),
    100,
  ),
  decisions: list(z.object({ decision: required(1_000), reason: text(1_000).default(''), alternatives: text(1_000).optional() }), 50),
  assumptions: list(text(1_000), 50),
  verification: list(z.object({ command: required(1_000), exit_code: z.number().int().nullable(), result: text(2_000).default('') }), 50),
  deviations_from_brief: list(text(2_000), 50),
  reserved_change_requests: list(z.object({ path: required(1_000), change: required(2_000), reason: text(2_000).default('') }), 50),
  open_questions: list(z.object({ question: required(2_000), options: z.array(text(500)).max(10).default([]), chosen_for_now: text(500).optional() }), 20),
  blockers: list(z.object({ what: required(2_000), evidence: text(4_000).default(''), needed_to_unblock: text(2_000).default('') }), 20),
  follow_ups: list(text(2_000), 50),
  suspicious_content: list(text(2_000), 50),
});

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

/** The shape shown in every brief. Valid JSON; the "a | b" strings name the allowed values. */
export const RESULT_TEMPLATE = `{
  "task_id": "<this task's id>",
  "status": "completed | partial | blocked | failed",
  "summary": "2-5 sentences for someone who has not seen your work",
  "files_changed": [{ "path": "src/example.ts", "change": "added | modified | deleted", "purpose": "why" }],
  "interfaces": [{ "name": "parseThing", "kind": "function", "location": "src/example.ts", "signature": "parseThing(text: string): Thing", "change": "added | changed | removed" }],
  "decisions": [{ "decision": "what you chose", "reason": "why" }],
  "assumptions": [],
  "verification": [{ "command": "npm test", "exit_code": 0, "result": "what happened" }],
  "deviations_from_brief": [],
  "reserved_change_requests": [{ "path": "package.json", "change": "what to change", "reason": "why" }],
  "open_questions": [],
  "blockers": [{ "what": "what stopped you", "evidence": "what you saw", "needed_to_unblock": "what would let you go on" }],
  "follow_ups": [],
  "suspicious_content": []
}`;

export type ResultProblemCode = 'no-result' | 'invalid-json' | 'invalid' | 'wrong-task';

export type ParsedResult = { ok: true; result: WorkerResult } | { ok: false; problem: { code: ResultProblemCode; message: string } };

function fail(code: ResultProblemCode, message: string): ParsedResult {
  return { ok: false, problem: { code, message } };
}

/** The JSON text of the last ```json block (or the whole message when it is one JSON object), or null. */
function lastJson(message: string): string | null {
  const blocks = [...message.matchAll(/```json[^\n]*\n([\s\S]*?)\n?```/g)];
  const last = blocks[blocks.length - 1]?.[1];
  if (last !== undefined) return last;
  const whole = message.trim();
  return whole.startsWith('{') && whole.endsWith('}') ? whole : null;
}

/** Reads a worker's result from its final message (`EngineReport.result`). */
export function parseWorkerResult(message: string | null, taskId: string): ParsedResult {
  if (message === null) return fail('no-result', 'The worker ended without a final message.');
  const tail = message.length > MAX_RESULT_TEXT_CHARS ? message.slice(-MAX_RESULT_TEXT_CHARS) : message;
  const json = lastJson(tail);
  if (json === null) return fail('no-result', 'The final message has no JSON result block.');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return fail('invalid-json', `The result block is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = WorkerResultSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(result)'}: ${i.message}`);
    return fail('invalid', `The result doesn't match the expected shape. ${issues.join('; ')}`);
  }
  if (parsed.data.task_id !== taskId) return fail('wrong-task', `The result is for task "${parsed.data.task_id}", not "${taskId}".`);
  return { ok: true, result: parsed.data };
}
