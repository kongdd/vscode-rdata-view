import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readArrowIPC } from '../src/shared/arrowReader.js';

describe('Feather V2 compression', () => {
  it.each(['uncompressed', 'lz4', 'zstd'])('reads %s buffers and dictionaries', codec => {
    const bytes = readFileSync(`tests/fixtures/${codec}.feather`);
    const table = readArrowIPC(bytes);

    expect(table.numRows).toBe(1024);
    expect(table.getChild('site')?.get(0)).toBe(50136);
    expect(table.getChild('date')?.get(0)).toBe(Date.UTC(1957, 3, 1));
    expect(table.getChild('temperature')?.get(0)).toBe(-8.8);
    expect(table.getChild('temperature')?.get(1)).toBeNull();
    expect(table.getChild('label')?.get(1)).toBe('warm');
    expect(table.getChild('empty')?.get(0)).toBeNull();
  });

  it('rejects a truncated Feather file', () => {
    const bytes = readFileSync('tests/fixtures/uncompressed.feather');
    expect(() => readArrowIPC(bytes.subarray(0, 128))).toThrow();
  });
});
