/**
 * Fitting a result into its file's size limit (step 9). A gate or a finalize report holds every acceptance
 * command's output (up to 256 KiB per stream, step 6), and a finalize report repeats each command once per task
 * that lists it. Output a worker's tests print can also grow sixfold as JSON (a control character is written as
 * `\u0007`). So when a result would be larger than its file may be, the outputs in a copy of it are cut, more
 * and more, until it fits: each keeps its start and its end, with a marker line between them, and is marked
 * `truncated`. Everything else in the result is kept as it is.
 */

/** Characters kept per output, tried in turn until the result fits. */
const STEPS = [64 * 1024, 16 * 1024, 4 * 1024, 1024, 0];

export function serializedSize(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function cutMiddle(text: string, keep: number): string {
  const head = Math.floor(keep / 4);
  const tail = keep - head;
  const left = text.length - keep;
  return `${text.slice(0, head)}\n[... ${left} characters left out by Orchestra to fit the run folder ...]\n${tail > 0 ? text.slice(-tail) : ''}`;
}

/** A captured output: exactly the fields of CapturedOutput (accept/run.ts). */
function isOutput(node: Record<string, unknown>): boolean {
  const keys = Object.keys(node);
  return (
    keys.length === 3 && typeof node.text === 'string' && typeof node.totalBytes === 'number' && typeof node.truncated === 'boolean'
  );
}

function cutOutputs(node: unknown, keep: number): void {
  if (Array.isArray(node)) {
    for (const item of node) cutOutputs(item, keep);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (isOutput(record)) {
    const text = record.text as string;
    if (text.length > keep) {
      record.text = cutMiddle(text, keep);
      record.truncated = true;
    }
    return;
  }
  for (const value of Object.values(record)) cutOutputs(value, keep);
}

/**
 * `value` itself when it fits in `maxBytes` as indented JSON, otherwise a copy with its command outputs cut until
 * it fits (or as far as they go: the write then reports what is still too large).
 */
export function fitOutputs<T>(value: T, maxBytes: number): T {
  if (serializedSize(value) <= maxBytes) return value;
  let copy = value;
  for (const keep of STEPS) {
    copy = JSON.parse(JSON.stringify(value)) as T;
    cutOutputs(copy, keep);
    if (serializedSize(copy) <= maxBytes) return copy;
  }
  return copy;
}
