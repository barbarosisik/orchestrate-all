/**
 * The run's decision log (step 9): `log.jsonl`, one JSON record per line, each checked against the record
 * schema (schema.ts) and carrying its format version `v`, its time `at` and its `kind`. Only the conductor
 * writes it, one record at a time, fsynced: a decision written down stays written down.
 *
 * Size: the log is capped (DEFAULT_MAX_LOG_BYTES). When an append would pass the cap, the log is rewritten
 * atomically keeping its start (up to a quarter of the cap: how the run began) and its end (up to half: the
 * latest decisions), with one `log-truncated` record between them counting the records and bytes left out
 * (earlier markers are added in, so the count covers the whole run). Records are never cut in half. A single
 * record may not be larger than an eighth of the cap (and never over 64 KiB); entries.ts keeps them short.
 *
 * Crashes: a crash during an append can leave a partial last line. Readers drop it and say so. The writer
 * removes it before writing again and records `log-repaired` with the bytes removed (shortening the log as
 * above if that record would pass the cap). The writer also notices when the file changed since its own last
 * write (another program wrote to it, or an append failed half-way) and repairs it first, so a new record is
 * never glued onto a broken line. Repairs work on bytes, so a damaged byte can't throw the counts off. The
 * writer can repair and shorten a log of up to four times the cap; a larger one was not written by Orchestra
 * and is reported.
 *
 * Reading: a line that isn't JSON, has another format version, is too long or isn't a known record is
 * skipped and reported by line number; the other lines are still read. A file over the cap is refused.
 */

import { lstat } from 'node:fs/promises';
import { appendFileSafe, readFileCapped, writeFileAtomic, type AtomicWriteOptions, type FileProblem, type FileResult } from './files.js';
import { issueText, storeFail, type StoreResult } from './documents.js';
import { LogRecordSchema, STORE_SCHEMA_VERSION, type LogEntry, type LogRecord } from './schema.js';

export const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

export function maxLineBytes(maxLogBytes: number): number {
  return Math.min(MAX_LINE_BYTES, Math.floor(maxLogBytes / 8));
}

export interface SkippedLine {
  /** 1-based line number. */
  readonly line: number;
  readonly reason: string;
}

export interface ParsedLog {
  readonly records: LogRecord[];
  readonly skipped: SkippedLine[];
  /** The file ended in the middle of a line (an interrupted write); that piece was dropped. */
  readonly partialLastLine: boolean;
  /** Older records were left out to keep the log under its cap (a `log-truncated` record says how many). */
  readonly truncated: boolean;
}

function lineProblem(line: string, maxLine: number): { record: LogRecord } | { reason: string } {
  if (line.length === 0) return { reason: 'empty line' };
  if (Buffer.byteLength(line, 'utf8') > maxLine) return { reason: `longer than ${maxLine} bytes` };
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { reason: 'not valid JSON' };
  }
  const version = typeof json === 'object' && json !== null ? (json as { v?: unknown }).v : undefined;
  if (typeof version === 'number' && version !== STORE_SCHEMA_VERSION) {
    return { reason: `written by another version of Orchestra (format ${version})` };
  }
  const parsed = LogRecordSchema.safeParse(json);
  return parsed.success ? { record: parsed.data } : { reason: `not a valid record (${issueText(parsed.error)})` };
}

export function parseLog(data: Buffer | string, maxLogBytes = DEFAULT_MAX_LOG_BYTES): ParsedLog {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const lines = text.split('\n');
  // After the last "\n" comes "" for a complete file, or the piece of an interrupted write.
  const partialLastLine = (lines.pop() ?? '') !== '';
  const records: LogRecord[] = [];
  const skipped: SkippedLine[] = [];
  const maxLine = maxLineBytes(maxLogBytes);
  lines.forEach((line, index) => {
    const result = lineProblem(line, maxLine);
    if ('record' in result) records.push(result.record);
    else skipped.push({ line: index + 1, reason: result.reason });
  });
  return { records, skipped, partialLastLine, truncated: records.some((r) => r.kind === 'log-truncated') };
}

export async function readLog(path: string, maxLogBytes = DEFAULT_MAX_LOG_BYTES): Promise<FileResult<ParsedLog>> {
  const read = await readFileCapped(path, maxLogBytes);
  return read.ok ? { ok: true, value: parseLog(read.value, maxLogBytes) } : read;
}

/** The line for a record: one JSON object and "\n". */
export function serializeRecord(record: LogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const NEWLINE = 0x0a;
/** The writer reads a log of up to this many times its cap, to repair or shorten it. */
const READ_FACTOR = 4;

/** The complete lines of `data` (without their "\n") and the bytes after the last one. */
function splitLines(data: Buffer): { lines: Buffer[]; rest: number } {
  const lines: Buffer[] = [];
  let start = 0;
  for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
    lines.push(data.subarray(start, end));
    start = end + 1;
  }
  return { lines, rest: data.length - start };
}

/** How many records and bytes a dropped line stands for: a marker counts what it had counted. */
function droppedBy(line: Buffer): { records: number; bytes: number } {
  try {
    const parsed = LogRecordSchema.safeParse(JSON.parse(line.toString('utf8')));
    if (parsed.success && parsed.data.kind === 'log-truncated') {
      return { records: parsed.data.droppedRecords, bytes: parsed.data.droppedBytes };
    }
  } catch {
    // Not JSON: it counts as one line.
  }
  return { records: 1, bytes: line.length + 1 };
}

export interface LogWriterOptions {
  readonly maxBytes?: number;
  readonly now?: () => Date;
  /** Checks the folders on the way to the log (no links) before each write. */
  readonly folders?: () => Promise<FileProblem | null>;
  readonly atomic?: AtomicWriteOptions;
}

/** Appends records to one run's log. Not safe for parallel calls: the run store queues them. */
export class LogWriter {
  private readonly maxBytes: number;
  private readonly now: () => Date;
  /** The log's size after this writer's last write; null when it must be checked before appending. */
  private knownSize: number | null = null;

  constructor(
    private readonly path: string,
    private readonly opts: LogWriterOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  /** The record as it will be written: stamped with the format version and the time, then checked. */
  stamp(entry: LogEntry): StoreResult<LogRecord> {
    // v and at come first in the line, and nothing in the entry can replace them.
    const stamp = { v: STORE_SCHEMA_VERSION, at: this.now().toISOString() };
    const parsed = LogRecordSchema.safeParse(Object.assign({ ...stamp }, entry, stamp));
    if (!parsed.success) return storeFail('invalid', `Refused a log record of kind "${entry.kind}": ${issueText(parsed.error)}`);
    return { ok: true, value: parsed.data };
  }

  /** The first content of a new log (used when a run is created). */
  initialContent(entry: LogEntry): StoreResult<string> {
    const stamped = this.stamp(entry);
    return stamped.ok ? { ok: true, value: serializeRecord(stamped.value) } : stamped;
  }

  private async readAll(): Promise<StoreResult<Buffer>> {
    const folders = (await this.opts.folders?.()) ?? null;
    if (folders !== null) return { ok: false, problem: folders };
    const read = await readFileCapped(this.path, this.maxBytes * READ_FACTOR);
    if (read.ok) return read;
    if (read.problem.code !== 'too-large') return read;
    return storeFail('too-large', `The log ${this.path} is larger than Orchestra ever makes it: it was changed outside Orchestra. Move it aside to go on.`);
  }

  /**
   * Removes a partial last line left by an interrupted write and records that, and shortens a log over the
   * cap. Returns the bytes of the partial line removed (0 when there was none).
   */
  async repair(): Promise<StoreResult<number>> {
    const read = await this.readAll();
    if (!read.ok) return read;
    const { lines, rest } = splitLines(read.value);
    if (rest === 0 && read.value.length <= this.maxBytes) {
      this.knownSize = read.value.length;
      return { ok: true, value: 0 };
    }
    let trailing = '';
    if (rest > 0) {
      const marker = this.stamp({ kind: 'log-repaired', droppedBytes: rest });
      if (!marker.ok) return marker;
      trailing = serializeRecord(marker.value);
    }
    const written = await this.rewrite(lines, trailing);
    return written.ok ? { ok: true, value: rest } : written;
  }

  async append(entry: LogEntry): Promise<StoreResult> {
    const stamped = this.stamp(entry);
    if (!stamped.ok) return stamped;
    const line = serializeRecord(stamped.value);
    const maxLine = maxLineBytes(this.maxBytes);
    if (bytes(line) > maxLine) return storeFail('too-large', `A log record of kind "${entry.kind}" is ${bytes(line)} bytes, over the limit of ${maxLine}.`);

    const folders = (await this.opts.folders?.()) ?? null;
    if (folders !== null) return { ok: false, problem: folders };
    let size: number;
    try {
      size = (await lstat(this.path)).size;
    } catch {
      return storeFail('missing', `The log ${this.path} is missing. It may have been deleted while the run was going.`);
    }
    if (size !== this.knownSize) {
      // Changed since this writer last wrote (or not checked yet): it must end with a complete line first.
      const repaired = await this.repair();
      if (!repaired.ok) return repaired;
      size = this.knownSize ?? size;
    }
    let result: FileResult;
    if (size + bytes(line) > this.maxBytes) {
      const read = await this.readAll();
      if (!read.ok) return read;
      result = await this.rewrite(splitLines(read.value).lines, line);
    } else {
      result = await appendFileSafe(this.path, line, { sync: true });
      this.knownSize = result.ok ? size + bytes(line) : null;
    }
    return result.ok ? { ok: true, value: undefined } : result;
  }

  /**
   * Writes `lines` and then `trailing` atomically. Over the cap, keeps the start and the end of `lines` with a
   * `log-truncated` marker between them.
   */
  private async rewrite(lines: Buffer[], trailing: string): Promise<FileResult> {
    const newline = Buffer.from('\n');
    const join = (part: Buffer[]): Buffer[] => part.flatMap((l) => [l, newline]);
    const total = lines.reduce((sum, l) => sum + l.length + 1, 0) + bytes(trailing);
    let parts: Buffer[];
    if (total <= this.maxBytes) {
      parts = join(lines);
    } else {
      let headCount = 0;
      for (let used = 0; headCount < lines.length; headCount++) {
        used += (lines[headCount] as Buffer).length + 1;
        if (used > Math.floor(this.maxBytes / 4)) break;
      }
      let tailStart = lines.length;
      for (let used = 0; tailStart > headCount; tailStart--) {
        used += (lines[tailStart - 1] as Buffer).length + 1;
        if (used > Math.floor(this.maxBytes / 2)) break;
      }
      const dropped = lines.slice(headCount, tailStart).map(droppedBy);
      const marker = this.stamp({
        kind: 'log-truncated',
        droppedRecords: dropped.reduce((sum, d) => sum + d.records, 0),
        droppedBytes: dropped.reduce((sum, d) => sum + d.bytes, 0),
      });
      if (!marker.ok) return { ok: false, problem: { code: 'io', message: marker.problem.message } };
      parts = [...join(lines.slice(0, headCount)), Buffer.from(serializeRecord(marker.value)), ...join(lines.slice(tailStart))];
    }
    const content = Buffer.concat([...parts, Buffer.from(trailing)]);
    const written = await writeFileAtomic(this.path, content, { ...this.opts.atomic, maxBytes: this.maxBytes });
    this.knownSize = written.ok ? content.length : null;
    return written;
  }
}
