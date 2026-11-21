import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CappedOutput, maxOutputFileBytes, readCappedOutput, truncationMarker } from '../../src/store/stream.js';

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function outFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-out-'));
  scratch.push(dir);
  return join(dir, 'worker-0.out');
}

async function open(path: string, maxBytes: number): Promise<CappedOutput> {
  const created = await CappedOutput.create(path, { maxBytes });
  if (!created.ok) throw new Error(created.problem.message);
  return created.value;
}

describe('CappedOutput', () => {
  it('keeps everything while under the cap', async () => {
    const file = outFile();
    const out = await open(file, 1000);
    out.write('{"type":"init"}\n');
    out.write(Buffer.from('{"type":"result"}\n'));
    out.write('');
    expect(await out.close()).toEqual({ ok: true, value: { totalBytes: 34, keptBytes: 34, truncated: false } });
    expect(readFileSync(file, 'utf8')).toBe('{"type":"init"}\n{"type":"result"}\n');
    const read = await readCappedOutput(file, 1000);
    expect(read.ok && read.value).toEqual({ data: readFileSync(file), truncated: false, droppedBytes: null });
  });

  it('keeps the start and the end of long output, with a marker between them', async () => {
    const file = outFile();
    const maxBytes = 1000;
    const out = await open(file, maxBytes);
    const chunks = Array.from({ length: 500 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`);
    for (const chunk of chunks) {
      out.write(chunk);
      if (chunks.indexOf(chunk) % 50 === 0) {
        expect(await out.flush()).toBeNull();
        expect(statSync(file).size).toBeLessThanOrEqual(maxOutputFileBytes(maxBytes));
      }
    }
    const all = chunks.join('');
    const closed = await out.close();
    expect(closed).toEqual({ ok: true, value: { totalBytes: all.length, keptBytes: maxBytes, truncated: true } });
    const expected = all.slice(0, 250) + truncationMarker(all.length - maxBytes) + all.slice(all.length - 750);
    expect(readFileSync(file, 'utf8')).toBe(expected);
    const read = await readCappedOutput(file, maxBytes);
    expect(read.ok && { truncated: read.value.truncated, dropped: read.value.droppedBytes }).toEqual({
      truncated: true,
      dropped: all.length - maxBytes,
    });
  });

  it('after a crash, the file holds everything up to the last write', async () => {
    const file = outFile();
    const out = await open(file, 1000);
    out.write('a'.repeat(1200));
    await out.flush();
    // No close: the conductor stopped here. Under one and a half times the cap, nothing was cut yet.
    expect(readFileSync(file, 'utf8')).toBe('a'.repeat(1200));
    out.write('b'.repeat(400));
    await out.flush();
    expect(readFileSync(file, 'utf8')).toBe(`${'a'.repeat(250)}${truncationMarker(600)}${'a'.repeat(350)}${'b'.repeat(400)}`);
  });

  it('cuts one giant chunk the same way', async () => {
    const file = outFile();
    const out = await open(file, 100);
    out.write(`${'s'.repeat(25)}${'m'.repeat(10_000)}${'e'.repeat(75)}`);
    expect((await out.close()).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(`${'s'.repeat(25)}${truncationMarker(10_000)}${'e'.repeat(75)}`);
  });

  it('replaces the file of an earlier attempt', async () => {
    const file = outFile();
    writeFileSync(file, 'old output');
    const out = await open(file, 100);
    out.write('new');
    await out.close();
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('refuses writes after close', async () => {
    const out = await open(outFile(), 100);
    await out.close();
    expect(() => out.write('late')).toThrow(/closed/);
  });

  it('stops writing when a folder on the way became a link, and reports it', async () => {
    const file = outFile();
    let broken = false;
    const created = await CappedOutput.create(file, {
      maxBytes: 100,
      folders: () => Promise.resolve(broken ? { code: 'link', message: 'tasks is a link' } : null),
    });
    if (!created.ok) throw new Error('not created');
    const out = created.value;
    out.write('fine ');
    await out.flush();
    broken = true;
    out.write('blocked');
    expect((await out.flush())?.code).toBe('link');
    expect(out.problem?.code).toBe('link');
    out.write('counted only');
    const closed = await out.close();
    expect(closed.ok ? 'ok' : closed.problem.message).toBe('tasks is a link');
    expect(readFileSync(file, 'utf8')).toBe('fine ');
    const refused = await CappedOutput.create(outFile(), { folders: () => Promise.resolve({ code: 'link', message: 'no' }) });
    expect(refused.ok).toBe(false);
  });

  it('reports a rewrite that fails', async () => {
    const file = outFile();
    let calls = 0;
    const created = await CappedOutput.create(file, {
      maxBytes: 100,
      folders: () => Promise.resolve(++calls > 1 ? { code: 'io', message: 'disk gone' } : null),
    });
    if (!created.ok) throw new Error('not created');
    created.value.write('x'.repeat(500));
    const closed = await created.value.close();
    expect(closed.ok ? 'ok' : closed.problem.message).toBe('disk gone');
  });

  it('only counts chunks after a write failed, holding nothing more in memory', async () => {
    const created = await CappedOutput.create(outFile(), { maxBytes: 1000, folders: () => Promise.resolve(null) });
    if (!created.ok) throw new Error('not created');
    const out = created.value;
    (out as unknown as { opts: { folders: () => Promise<unknown> } }).opts.folders = () => Promise.resolve({ code: 'io', message: 'disk gone' });
    out.write('x');
    await out.flush();
    out.write('y');
    expect((out as unknown as { pending: Buffer[] }).pending).toHaveLength(0);
    for (let i = 0; i < 1000; i++) out.write('y'.repeat(1000));
    expect((out as unknown as { pending: Buffer[] }).pending).toHaveLength(0);
    const closed = await out.close();
    expect(closed.ok ? 'ok' : closed.problem.message).toBe('disk gone');
  });

  it('holds at most the end it keeps while a slow write is in flight, and still writes start + marker + end', async () => {
    const file = outFile();
    let release: () => void = () => undefined;
    let slow = false;
    const created = await CappedOutput.create(file, {
      maxBytes: 1000,
      folders: () => (slow ? new Promise((done) => { release = () => done(null); }) : Promise.resolve(null)),
    });
    if (!created.ok) throw new Error('not created');
    const out = created.value;
    slow = true;
    const chunks = Array.from({ length: 400 }, (_, i) => `chunk ${String(i).padStart(4, '0')}\n`);
    for (const chunk of chunks) out.write(chunk);
    const pending = (out as unknown as { pending: Buffer[] }).pending.reduce((sum, b) => sum + b.length, 0);
    expect(pending).toBeLessThanOrEqual(750);
    slow = false;
    release();
    expect((await out.close()).ok).toBe(true);
    const all = chunks.join('');
    expect(readFileSync(file, 'utf8')).toBe(all.slice(0, 250) + truncationMarker(all.length - 1000) + all.slice(-750));
  });

  it('can be closed twice, and tells listeners once', async () => {
    const out = await open(outFile(), 100);
    let told = 0;
    out.onClose(() => (told += 1));
    out.write('a');
    const [first, second] = await Promise.all([out.close(), out.close()]);
    expect(first).toEqual(second);
    expect(told).toBe(1);
    expect(out.isClosed).toBe(true);
  });

  it('reports a missing file when reading', async () => {
    const read = await readCappedOutput(outFile());
    expect(read.ok ? 'ok' : read.problem.code).toBe('missing');
  });
});
