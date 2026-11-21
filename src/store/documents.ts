/**
 * Reading and writing the run store's JSON files (step 9). A read is checked in three steps, each with its
 * own plain message: the file (missing, a link, too large), then valid JSON with the expected
 * `schemaVersion` (another version is named as such), then the schema. A write is checked against the same
 * schema first, so the store never writes what it would refuse to read, and is atomic (files.ts).
 */

import { basename } from 'node:path';
import type { z } from 'zod';
import { readFileCapped, writeFileAtomic, type AtomicWriteOptions, type FileProblemCode } from './files.js';
import { STORE_SCHEMA_VERSION } from './schema.js';

export type StoreProblemCode =
  | FileProblemCode
  | 'bad-name'
  | 'exists'
  | 'busy'
  | 'closed'
  | 'corrupt'
  | 'wrong-version'
  | 'inconsistent'
  | 'invalid'
  | 'home-overlaps-repo'
  | 'git-failed';

export interface StoreProblem {
  readonly code: StoreProblemCode;
  readonly message: string;
}

export type StoreResult<T = undefined> = { ok: true; value: T } | { ok: false; problem: StoreProblem };

export function storeFail<T>(code: StoreProblemCode, message: string): StoreResult<T> {
  return { ok: false, problem: { code, message } };
}

/** Up to five zod issues as "path: message". */
export function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(top)'}: ${issue.message}`)
    .join('; ');
}

const DAMAGED = 'It may have been edited by hand or by a worker.';

/** Parses a stored JSON document. `what` names it in messages, e.g. "state.json of run X". */
export function parseDocument<T>(data: Buffer, schema: z.ZodType<T>, what: string): StoreResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    return storeFail('corrupt', `${what} is not valid JSON (an interrupted write or damage). ${DAMAGED}`);
  }
  const version = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version === 'number' && version !== STORE_SCHEMA_VERSION) {
    return storeFail(
      'wrong-version',
      `${what} was written by another version of Orchestra (format ${version}; this version reads format ${STORE_SCHEMA_VERSION}).`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return storeFail('corrupt', `${what} is not in the expected format (${issueText(parsed.error)}). ${DAMAGED}`);
  return { ok: true, value: parsed.data };
}

export async function readDocument<T>(path: string, schema: z.ZodType<T>, maxBytes: number, what: string): Promise<StoreResult<T>> {
  const read = await readFileCapped(path, maxBytes);
  if (!read.ok) return read;
  return parseDocument(read.value, schema, what);
}

/** Checks `value` against `schema`, then writes it atomically as indented JSON. */
export async function writeDocument(
  path: string,
  value: unknown,
  schema: z.ZodType,
  maxBytes: number,
  opts: AtomicWriteOptions = {},
): Promise<StoreResult> {
  const checked = schema.safeParse(value);
  if (!checked.success) return storeFail('invalid', `Refused to save ${basename(path)}: ${issueText(checked.error)}`);
  const written = await writeFileAtomic(path, `${JSON.stringify(checked.data, null, 2)}\n`, { ...opts, maxBytes });
  return written.ok ? { ok: true, value: undefined } : written;
}
