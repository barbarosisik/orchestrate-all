/**
 * Capped output files (step 9), for the worker's raw output (step 10 feeds it, chunk by chunk, as the worker
 * prints). A worker can print without end, so each file keeps at most `maxBytes` of what was written:
 *
 * - the start (the first quarter of the cap: how the worker began, which model, which settings) and
 * - the end (the other three quarters: what it did last, its result and the tokens it used),
 * - with one marker line between them: `[... N bytes left out by Orchestra ...]`.
 *
 * How it stays crash-safe: chunks are appended to the file as they come, so after a crash the file holds
 * everything up to the last append. The start and the end are also kept in memory. Once the file would grow
 * past one and a half times the cap, it is rewritten atomically as start + marker + end, and appending goes
 * on from there. On close it is rewritten once more if anything was left out, so a finished file is never
 * more than the cap plus the marker.
 *
 * Memory stays bounded too: at most the cap (start and end) plus what waits to be written, and when more waits
 * than the end keeps (a slow disk), the waiting chunks are dropped and the file is rewritten from memory
 * instead. After a write fails, chunks are only counted.
 *
 * A worker restarted in the same round starts a new file: opening replaces what was there.
 */

import { appendFileSafe, readFileCapped, writeFileAtomic, type FileProblem, type FileResult } from './files.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MARKER = /\n\[\.\.\. (\d+) bytes left out by Orchestra \.\.\.\]\n/;

export function truncationMarker(droppedBytes: number): string {
  return `\n[... ${droppedBytes} bytes left out by Orchestra ...]\n`;
}

/** The most a capped file can hold while it is being written. */
export function maxOutputFileBytes(maxBytes: number): number {
  return maxBytes + Math.floor(maxBytes / 2) + truncationMarker(Number.MAX_SAFE_INTEGER).length;
}

export interface OutputSummary {
  /** Bytes written to the stream in total. */
  readonly totalBytes: number;
  /** Bytes of it kept in the file. */
  readonly keptBytes: number;
  readonly truncated: boolean;
}

export interface CappedOutputOptions {
  readonly maxBytes?: number;
  /** Checks the folders on the way to the file (no links) before each write. */
  readonly folders?: () => Promise<FileProblem | null>;
}

export class CappedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly fileLimit: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;
  private fileBytes = 0;
  /** `total` when the file was last rewritten as start + marker + end. */
  private compactedAt = -1;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** More waited than the end keeps: rewrite the file from memory rather than append. */
  private rewriteNext = false;
  private draining: Promise<void> | null = null;
  private failure: FileProblem | null = null;
  private closed = false;
  private closing: Promise<FileResult<OutputSummary>> | null = null;
  private readonly closeListeners: Array<() => void> = [];

  private constructor(
    readonly path: string,
    private readonly opts: CappedOutputOptions,
  ) {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.headLimit = Math.floor(maxBytes / 4);
    this.tailLimit = maxBytes - this.headLimit;
    this.fileLimit = maxBytes + Math.floor(maxBytes / 2);
  }

  /** Starts an empty file at `path`, replacing one an earlier attempt left. */
  static async create(path: string, opts: CappedOutputOptions = {}): Promise<FileResult<CappedOutput>> {
    const folders = (await opts.folders?.()) ?? null;
    if (folders !== null) return { ok: false, problem: folders };
    const created = await writeFileAtomic(path, '');
    return created.ok ? { ok: true, value: new CappedOutput(path, opts) } : created;
  }

  /** The first problem writing the file, if any. Later chunks are then only counted. */
  get problem(): FileProblem | null {
    return this.failure;
  }

  /** Adds a chunk. Returns at once; the file is written in the background, in order. */
  write(chunk: string | Uint8Array): void {
    if (this.closed) throw new Error(`${this.path} is closed.`);
    const bytes = Buffer.from(chunk);
    if (bytes.length === 0) return;
    this.total += bytes.length;
    this.remember(bytes);
    if (this.failure !== null) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.draining !== null && this.pendingBytes > this.tailLimit) {
      // A slow write is in flight and more waits than the end keeps. Memory already holds the start and the
      // end: a rewrite from it replaces all that waits.
      this.pending = [];
      this.pendingBytes = 0;
      this.rewriteNext = true;
    }
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Calls `listener` once the file is closed. */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Waits until everything written so far is in the file. */
  async flush(): Promise<FileProblem | null> {
    while (this.draining !== null) await this.draining;
    return this.failure;
  }

  /** Writes what is left and closes the file. Calling it again gives the same result. */
  close(): Promise<FileResult<OutputSummary>> {
    this.closing ??= this.finish().finally(() => {
      for (const listener of this.closeListeners) listener();
    });
    return this.closing;
  }

  private async finish(): Promise<FileResult<OutputSummary>> {
    this.closed = true;
    await this.flush();
    if (this.failure === null && this.dropped() > 0 && this.compactedAt !== this.total) await this.compact();
    if (this.failure !== null) return { ok: false, problem: this.failure };
    const truncated = this.dropped() > 0;
    return {
      ok: true,
      value: { totalBytes: this.total, keptBytes: truncated ? this.headBytes + this.tailBytes : this.total, truncated },
    };
  }

  private dropped(): number {
    return this.total - this.headBytes - this.tailBytes;
  }

  private remember(bytes: Buffer): void {
    let rest = bytes;
    if (this.headBytes < this.headLimit) {
      const take = rest.subarray(0, this.headLimit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > this.tailLimit) {
      const first = this.tail[0] as Buffer;
      const excess = this.tailBytes - this.tailLimit;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  private async drain(): Promise<void> {
    while ((this.pending.length > 0 || this.rewriteNext) && this.failure === null) {
      if (this.rewriteNext) {
        this.rewriteNext = false;
        this.pending = [];
        this.pendingBytes = 0;
        await this.compact();
        continue;
      }
      const data = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingBytes = 0;
      if (this.fileBytes + data.length <= this.fileLimit) {
        const folders = (await this.opts.folders?.()) ?? null;
        const appended = folders === null ? await appendFileSafe(this.path, data) : { ok: false as const, problem: folders };
        if (appended.ok) this.fileBytes += data.length;
        else this.failure = appended.problem;
      } else {
        // Memory already holds `data`: the rewrite includes it.
        await this.compact();
      }
    }
  }

  private async compact(): Promise<void> {
    const at = this.total;
    const dropped = this.dropped();
    const marker = dropped > 0 ? [Buffer.from(truncationMarker(dropped))] : [];
    const content = Buffer.concat([...this.head, ...marker, ...this.tail]);
    const folders = (await this.opts.folders?.()) ?? null;
    const written = folders === null ? await writeFileAtomic(this.path, content) : { ok: false as const, problem: folders };
    if (!written.ok) {
      this.failure = written.problem;
      return;
    }
    this.fileBytes = content.length;
    this.compactedAt = at;
  }
}

export interface StoredOutput {
  readonly data: Buffer;
  /** Part of the output was left out (a marker line shows where and how much). */
  readonly truncated: boolean;
  /** How many bytes were left out, as the marker says; null when nothing was. */
  readonly droppedBytes: number | null;
}

/** Reads a capped output file written with the same `maxBytes`. */
export async function readCappedOutput(path: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): Promise<FileResult<StoredOutput>> {
  const read = await readFileCapped(path, maxOutputFileBytes(maxBytes));
  if (!read.ok) return read;
  // The marker always follows a full start, so look for it exactly there.
  const headLimit = Math.floor(maxBytes / 4);
  const after = read.value.subarray(headLimit, headLimit + 64).toString('latin1');
  const match = MARKER.exec(after);
  const dropped = match !== null && match.index === 0 ? Number(match[1]) : null;
  return { ok: true, value: { data: read.value, truncated: dropped !== null, droppedBytes: dropped } };
}
