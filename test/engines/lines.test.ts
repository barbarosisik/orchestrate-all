import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../../src/engines/lines.js';

function collect(maxLineBytes = 1024) {
  const lines: string[] = [];
  const skipped: number[] = [];
  const splitter = new LineSplitter(maxLineBytes, (line) => lines.push(line), (bytes) => skipped.push(bytes));
  return { splitter, lines, skipped };
}

describe('LineSplitter', () => {
  it('splits chunks into lines, wherever the chunks break', () => {
    const { splitter, lines } = collect();
    splitter.push(Buffer.from('{"a":1}\n{"b"'));
    splitter.push(Buffer.from(':2}\n\n{"c":3}'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('drops a carriage return before the newline and skips empty lines', () => {
    const { splitter, lines } = collect();
    splitter.push(Buffer.from('one\r\n\r\ntwo\n'));
    expect(lines).toEqual(['one', 'two']);
  });

  it('keeps a character split across two chunks whole', () => {
    const { splitter, lines } = collect();
    const bytes = Buffer.from('é€😀\n');
    for (const byte of bytes) splitter.push(Buffer.from([byte]));
    expect(lines).toEqual(['é€😀']);
  });

  it('skips a line longer than the limit, counting its bytes, and goes on with the next', () => {
    const { splitter, lines, skipped } = collect(10);
    splitter.push(Buffer.from('short\n'));
    splitter.push(Buffer.from('x'.repeat(8)));
    splitter.push(Buffer.from('x'.repeat(8)));
    splitter.push(Buffer.from('x'.repeat(8) + '\nafter\n'));
    expect(lines).toEqual(['short', 'after']);
    expect(skipped).toEqual([24]);
  });

  it('holds at most the limit in memory while skipping', () => {
    const { splitter } = collect(10);
    for (let i = 0; i < 1000; i++) splitter.push(Buffer.from('y'.repeat(100)));
    expect(splitter.bufferedBytes).toBeLessThanOrEqual(10);
  });

  it('counts an over-long last line without a newline', () => {
    const { splitter, lines, skipped } = collect(4);
    splitter.push(Buffer.from('abcdefgh'));
    splitter.end();
    expect(lines).toEqual([]);
    expect(skipped).toEqual([8]);
  });

  it('accepts a line exactly at the limit', () => {
    const { splitter, lines, skipped } = collect(5);
    splitter.push(Buffer.from('12345\n123456\n'));
    expect(lines).toEqual(['12345']);
    expect(skipped).toEqual([6]);
  });
});
