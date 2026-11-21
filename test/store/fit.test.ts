import { describe, expect, it } from 'vitest';
import { fitOutputs, serializedSize } from '../../src/store/fit.js';

function output(text: string): { text: string; totalBytes: number; truncated: boolean } {
  return { text, totalBytes: Buffer.byteLength(text), truncated: false };
}

describe('fitOutputs', () => {
  it('returns the value itself when it already fits', () => {
    const value = { summary: 'ok', stdout: output('short') };
    expect(fitOutputs(value, 10_000)).toBe(value);
  });

  it('cuts command outputs in a copy until it fits, keeping each start and end, marked', () => {
    const noisy = `START${'\u0001'.repeat(200_000)}END`;
    const value = { summary: 'kept as is', commands: [{ argv: ['npm', 'test'], stdout: output(noisy), stderr: output('fine') }] };
    const fitted = fitOutputs(value, 50_000);
    expect(serializedSize(fitted)).toBeLessThanOrEqual(50_000);
    expect(value.commands[0]?.stdout.text).toBe(noisy);
    const cut = fitted.commands[0]?.stdout;
    expect(cut?.truncated).toBe(true);
    expect(cut?.text.startsWith('START')).toBe(true);
    expect(cut?.text.endsWith('END')).toBe(true);
    expect(cut?.text).toMatch(/characters left out by Orchestra to fit the run folder/);
    expect(cut?.totalBytes).toBe(Buffer.byteLength(noisy));
    expect(fitted.commands[0]?.stderr).toEqual(output('fine'));
    expect(fitted.summary).toBe('kept as is');
  });

  it('gives back its best try when even empty outputs do not fit', () => {
    const value = { big: 'x'.repeat(10_000), stdout: output('y'.repeat(10_000)) };
    const fitted = fitOutputs(value, 1_000);
    expect(serializedSize(fitted)).toBeGreaterThan(1_000);
    expect(fitted.big).toBe(value.big);
  });

  it('leaves objects alone that only look a bit like an output', () => {
    const value = { note: { text: 'x'.repeat(50_000), totalBytes: 1, truncated: false, extra: true } };
    expect(fitOutputs(value, 1_000).note.text).toHaveLength(50_000);
  });
});
