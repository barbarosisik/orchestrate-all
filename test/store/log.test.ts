import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogWriter, maxLineBytes, parseLog, readLog, serializeRecord } from '../../src/store/log.js';
import type { LogRecord } from '../../src/store/schema.js';

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

const AT = '2026-11-21T12:00:00.000Z';
const now = (): Date => new Date(AT);

function logFile(content = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-log-'));
  scratch.push(dir);
  const file = join(dir, 'log.jsonl');
  writeFileSync(file, content);
  return file;
}

function note(message: string): LogRecord {
  return { v: 1, at: AT, kind: 'note', message };
}

describe('parseLog', () => {
  it('reads one record per line', () => {
    const text = serializeRecord(note('one')) + serializeRecord(note('two'));
    expect(parseLog(text)).toEqual({ records: [note('one'), note('two')], skipped: [], partialLastLine: false, truncated: false });
  });

  it('drops a partial last line and says so', () => {
    const text = `${serializeRecord(note('one'))}{"v":1,"at":"2026-11-21T12:0`;
    const parsed = parseLog(text);
    expect(parsed.records).toEqual([note('one')]);
    expect(parsed.partialLastLine).toBe(true);
    expect(parsed.skipped).toEqual([]);
  });

  it('skips and reports lines that are not valid records, and keeps the rest', () => {
    const lines = [
      serializeRecord(note('first')),
      'not json\n',
      `${JSON.stringify({ ...note('x'), v: 2 })}\n`,
      `${JSON.stringify({ v: 1, at: AT, kind: 'unknown' })}\n`,
      `${JSON.stringify({ ...note('x'), extra: true })}\n`,
      '\n',
      `${JSON.stringify(note('x'.repeat(3000)))}\n`,
      serializeRecord(note('last')),
    ];
    const parsed = parseLog(lines.join(''));
    expect(parsed.records).toEqual([note('first'), note('last')]);
    expect(parsed.skipped.map((s) => s.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(parsed.skipped[0]?.reason).toBe('not valid JSON');
    expect(parsed.skipped[1]?.reason).toMatch(/another version of Orchestra \(format 2\)/);
    expect(parsed.skipped[2]?.reason).toMatch(/not a valid record/);
    expect(parsed.skipped[4]?.reason).toBe('empty line');
    expect(parsed.skipped[5]?.reason).toMatch(/not a valid record/);
  });

  it('skips lines longer than a record may be', () => {
    const long = `${JSON.stringify(note('y'.repeat(1500)))}\n`;
    expect(parseLog(long, 8 * 1024).skipped[0]?.reason).toMatch(/longer than 1024 bytes/);
  });
});

describe('LogWriter', () => {
  it('appends stamped, checked records, one per line', async () => {
    const file = logFile();
    const writer = new LogWriter(file, { now });
    expect(await writer.append({ kind: 'note', message: 'hello' })).toEqual({ ok: true, value: undefined });
    expect(await writer.append({ kind: 'gate', task: 'api', round: 0, passed: true, summary: 'ok' })).toEqual({ ok: true, value: undefined });
    const read = await readLog(file);
    expect(read.ok && read.value.records).toEqual([
      note('hello'),
      { v: 1, at: AT, kind: 'gate', task: 'api', round: 0, passed: true, summary: 'ok' },
    ]);
  });

  it('refuses a record that does not match its kind, without writing', async () => {
    const file = logFile();
    const writer = new LogWriter(file, { now });
    const bad = await writer.append({ kind: 'gate', task: 'API', round: 0, passed: true, summary: 'ok' });
    expect(bad.ok ? 'ok' : bad.problem.code).toBe('invalid');
    const sneaky = { kind: 'note', message: 'x', v: 2, at: 'yesterday' } as unknown as Parameters<LogWriter['append']>[0];
    expect((await writer.append(sneaky)).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(serializeRecord(note('x')));
  });

  it('refuses a record over the line limit', async () => {
    const writer = new LogWriter(logFile(), { now, maxBytes: 8 * 1024 });
    const result = await writer.append({ kind: 'note', message: 'z'.repeat(1_500) });
    expect(result.ok ? 'ok' : result.problem.code).toBe('too-large');
  });

  it('reports a log that was deleted', async () => {
    const file = logFile();
    rmSync(file);
    const result = await new LogWriter(file, { now }).append({ kind: 'note', message: 'x' });
    expect(result.ok ? 'ok' : result.problem.code).toBe('missing');
  });

  it('stops when a folder on the way is not a real folder', async () => {
    const writer = new LogWriter(logFile(), { now, folders: () => Promise.resolve({ code: 'link', message: 'runs is a link' }) });
    const result = await writer.append({ kind: 'note', message: 'x' });
    expect(result.ok ? 'ok' : result.problem.message).toBe('runs is a link');
    expect((await writer.repair()).ok).toBe(false);
  });

  it('keeps the start and the end when the log reaches its cap, with a visible marker', async () => {
    const maxBytes = 4 * 1024;
    const file = logFile();
    const writer = new LogWriter(file, { now, maxBytes });
    for (let i = 0; i < 120; i++) {
      const result = await writer.append({ kind: 'note', message: `decision ${String(i).padStart(3, '0')} ${'.'.repeat(60)}` });
      expect(result.ok).toBe(true);
      expect(statSync(file).size).toBeLessThanOrEqual(maxBytes);
    }
    const read = await readLog(file, maxBytes);
    if (!read.ok) throw new Error(read.problem.message);
    const { records } = read.value;
    expect(read.value.truncated).toBe(true);
    expect(read.value.skipped).toEqual([]);
    const messages = records.map((r) => (r.kind === 'note' ? r.message.slice(0, 12) : r.kind));
    expect(messages[0]).toBe('decision 000');
    expect(messages.at(-1)).toBe('decision 119');
    // One marker, covering every record left out over all the rewrites.
    const markers = records.filter((r) => r.kind === 'log-truncated');
    expect(markers).toHaveLength(1);
    const kept = records.filter((r) => r.kind === 'note').length;
    expect(markers[0]?.kind === 'log-truncated' && markers[0].droppedRecords).toBe(120 - kept);
    const markerAt = records.findIndex((r) => r.kind === 'log-truncated');
    expect(records.slice(0, markerAt).every((r, i) => r.kind === 'note' && r.message.startsWith(`decision ${String(i).padStart(3, '0')}`))).toBe(true);
  });

  it('removes a partial last line before writing again, and records that', async () => {
    const file = logFile(`${serializeRecord(note('one'))}{"v":1,"at":"2026`);
    const writer = new LogWriter(file, { now });
    expect(await writer.repair()).toEqual({ ok: true, value: 17 });
    expect(await writer.repair()).toEqual({ ok: true, value: 0 });
    await writer.append({ kind: 'note', message: 'two' });
    const read = await readLog(file);
    expect(read.ok && read.value.records).toEqual([note('one'), { v: 1, at: AT, kind: 'log-repaired', droppedBytes: 17 }, note('two')]);
    expect(read.ok && read.value.partialLastLine).toBe(false);
  });

  it('builds the first content of a new log', () => {
    const writer = new LogWriter('unused', { now });
    expect(writer.initialContent({ kind: 'note', message: 'start' })).toEqual({ ok: true, value: serializeRecord(note('start')) });
    expect(writer.initialContent({ kind: 'note', message: 'x'.repeat(5000) }).ok).toBe(false);
  });
});

describe('LogWriter after damage', () => {
  it('repairs by bytes, so a damaged byte earlier in the log does not throw the counts off', async () => {
    const file = logFile();
    writeFileSync(file, Buffer.concat([Buffer.from(serializeRecord(note('one'))), Buffer.from([0xff, 0x0a]), Buffer.from('{"v":1,"at"')]));
    const writer = new LogWriter(file, { now });
    expect(await writer.repair()).toEqual({ ok: true, value: 11 });
    const read = await readLog(file);
    expect(read.ok && read.value.records.map((r) => r.kind)).toEqual(['note', 'log-repaired']);
    expect(read.ok && read.value.skipped.map((s) => s.line)).toEqual([2]);
  });

  it('shortens the log instead of failing when the repair record would pass the cap', async () => {
    const maxBytes = 4096;
    const lines: string[] = [];
    for (let i = 0; Buffer.byteLength(lines.join('')) < maxBytes - 40; i++) lines.push(serializeRecord(note(`n${i} ${'.'.repeat(40)}`)));
    const file = logFile(`${lines.join('')}{"v":1`);
    const writer = new LogWriter(file, { now, maxBytes });
    expect(await writer.repair()).toEqual({ ok: true, value: 6 });
    expect(statSync(file).size).toBeLessThanOrEqual(maxBytes);
    const read = await readLog(file, maxBytes);
    expect(read.ok && read.value.records.map((r) => r.kind).slice(-2)).toEqual(['note', 'log-repaired']);
    expect(read.ok && read.value.truncated).toBe(true);
  });

  it('repairs first when another program left an unfinished line while the run was open', async () => {
    const file = logFile();
    const writer = new LogWriter(file, { now });
    await writer.append({ kind: 'note', message: 'one' });
    writeFileSync(file, 'half a line', { flag: 'a' });
    expect((await writer.append({ kind: 'note', message: 'two' })).ok).toBe(true);
    const read = await readLog(file);
    expect(read.ok && read.value.records).toEqual([note('one'), { v: 1, at: AT, kind: 'log-repaired', droppedBytes: 11 }, note('two')]);
    expect(read.ok && read.value.skipped).toEqual([]);
  });

  it('shortens a log grown past its cap, and reports one far larger than Orchestra ever makes it', async () => {
    const maxBytes = 4096;
    const many = Array.from({ length: 100 }, (_, i) => serializeRecord(note(`n${i} ${'.'.repeat(40)}`))).join('');
    expect(Buffer.byteLength(many)).toBeGreaterThan(2 * maxBytes);
    expect(Buffer.byteLength(many)).toBeLessThan(4 * maxBytes);
    const file = logFile(many);
    expect(await new LogWriter(file, { now, maxBytes }).repair()).toEqual({ ok: true, value: 0 });
    expect(statSync(file).size).toBeLessThanOrEqual(maxBytes);
    const huge = logFile(many.repeat(3));
    const result = await new LogWriter(huge, { now, maxBytes }).repair();
    expect(result.ok ? 'ok' : result.problem.message).toMatch(/larger than Orchestra ever makes it/);
  });
});

describe('maxLineBytes', () => {
  it('is an eighth of the cap, at most 64 KiB', () => {
    expect(maxLineBytes(8 * 1024)).toBe(1024);
    expect(maxLineBytes(4 * 1024 * 1024)).toBe(64 * 1024);
  });
});
