/**
 * Splitting an engine's output into lines (step 10). Every engine prints JSON Lines; chunks from the pipe break
 * anywhere, even inside a character, so bytes are collected up to each newline and only whole lines are
 * decoded. A line longer than the limit (a tool result holding a large file, or a worker printing without end)
 * is skipped and counted rather than held in memory; the raw output file keeps it either way (store/stream.ts).
 */

export class LineSplitter {
  private parts: Buffer[] = [];
  private partBytes = 0;
  /** Bytes of the current line seen while skipping it, or -1 when not skipping. */
  private skipping = -1;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onSkipped: (bytes: number) => void,
  ) {}

  /** Bytes held for the line not finished yet. */
  get bufferedBytes(): number {
    return this.partBytes;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    for (let newline = rest.indexOf(0x0a); newline !== -1; newline = rest.indexOf(0x0a)) {
      this.add(rest.subarray(0, newline));
      this.finishLine();
      rest = rest.subarray(newline + 1);
    }
    this.add(rest);
  }

  /** The output ended: a last line without a newline still counts. */
  end(): void {
    this.finishLine();
  }

  private add(bytes: Buffer): void {
    if (bytes.length === 0) return;
    if (this.skipping >= 0) {
      this.skipping += bytes.length;
      return;
    }
    if (this.partBytes + bytes.length > this.maxLineBytes) {
      this.skipping = this.partBytes + bytes.length;
      this.parts = [];
      this.partBytes = 0;
      return;
    }
    this.parts.push(bytes);
    this.partBytes += bytes.length;
  }

  private finishLine(): void {
    if (this.skipping >= 0) {
      this.onSkipped(this.skipping);
      this.skipping = -1;
      return;
    }
    let line = Buffer.concat(this.parts).toString('utf8');
    this.parts = [];
    this.partBytes = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > 0) this.onLine(line);
  }
}
