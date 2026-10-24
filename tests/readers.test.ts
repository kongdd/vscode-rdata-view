import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { ArrowFileReader, ArrowStreamError } from '../src/extension/reader/Arrow.js';
import type { PagedReader } from '../src/extension/reader/Paged.js';
import { exportCsv } from '../src/extension/exportCsv.js';
import type { CellValue } from '../src/shared/schema.js';

/** 最小 PagedReader，用于导出测试，不依赖任何文件格式。 */
function stub(rows: CellValue[][]): PagedReader {
  const names = ['id', 'text'];
  return {
    schema: names.map((name, index) => ({ name, index, inferredType: 'string', nullable: true })),
    totalRows: rows.length,
    readRows: async (start, end) => rows.slice(start, end),
    suspend: async () => {}, resume: () => {}, dispose: async () => {},
  };
}

let dir: string;
let readers: PagedReader[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rdata-test-')); });
afterEach(async () => {
  await Promise.all(readers.map(reader => reader.dispose()));
  readers = [];
  await rm(dir, { recursive: true, force: true });
});
describe('Arrow paging', () => {
  it.each(['uncompressed', 'lz4', 'zstd'])('reads %s batches, dates and dictionaries', async codec => {
    const reader = await ArrowFileReader.open(`tests/fixtures/${codec}.feather`);
    readers.push(reader);
    expect(reader.totalRows).toBe(1024);
    const rows = await reader.readRows(0, 2);
    expect(rows[0]).toEqual([0, 50136, '1957-04-01T00:00:00.000Z', -8.8, 'cold', null]);
    expect(rows[1][3]).toBeNull();
    expect(rows[1][4]).toBe('warm');
    expect((await reader.readRows(1023, 5000))).toHaveLength(1);
    await reader.suspend();
    expect(reader['cache'].size).toBe(0);
    expect(reader['handle']).toBeNull();
    await expect(reader.readRows(0, 1)).rejects.toThrow('suspended');
    reader.resume();
    expect(await reader.readRows(0, 2)).toEqual(rows);
  });

  it('rejects streams, invalid ranges, modified sources and use after disposal', async () => {
    const path = join(dir, 'file.arrow');
    await writeFile(path, tableToIPC(tableFromArrays({ id: [1, 2] }), 'stream'));
    await expect(ArrowFileReader.open(path)).rejects.toBeInstanceOf(ArrowStreamError);
    await copyFile('tests/fixtures/lz4.feather', path);
    const reader = await ArrowFileReader.open(path);
    readers.push(reader);
    for (const [start, end] of [[-1, 1], [1, 0], [0.5, 2], [0, Infinity]]) {
      await expect(reader.readRows(start, end)).rejects.toThrow('Invalid row range');
    }
    await appendFile(path, 'changed');
    await expect(reader.readRows(0, 1)).rejects.toThrow('changed');
    await reader.dispose();
    reader.resume();
    await expect(reader.readRows(0, 1)).rejects.toThrow('suspended');
  });
});

describe('CSV export', () => {
  it('exports bounded batches, quotes values and supports sorted/filtered row order', async () => {
    const reader = stub([[1, 'a,b'], [2, 'multi\nline']]);
    const path = join(dir, 'source.csv');
    const out = join(dir, 'export.csv');
    await exportCsv(reader, path, out, new AbortController().signal, () => {}, [1, 0]);
    expect(await readFile(out, 'utf8')).toBe('id,text\r\n2,"multi\nline"\r\n1,"a,b"\r\n');
    await exportCsv(reader, path, out, new AbortController().signal, () => {}, []);
    expect(await readFile(out, 'utf8')).toBe('id,text\r\n');
    await expect(exportCsv(reader, path, path, new AbortController().signal, () => {})).rejects.toThrow('source');
  });

  it('prevents a query result from overwriting any ancestor source', async () => {
    const source = join(dir, 'original.csv');
    await writeFile(source, 'original');
    await expect(exportCsv(stub([[1]]), join(dir, 'query.arrow'), source,
      new AbortController().signal, () => {}, undefined, [source])).rejects.toThrow('source');
    expect(await readFile(source, 'utf8')).toBe('original');
    expect((await readdir(dir)).filter(name => name.startsWith('.rdata-export'))).toEqual([]);
  });

  it('keeps an existing destination intact on cancellation and rejects invalid order', async () => {
    const reader = stub([[1], [2]]);
    const path = join(dir, 'source.csv');
    const out = join(dir, 'export.csv');
    await writeFile(out, 'original');
    await expect(exportCsv(reader, path, out, AbortSignal.abort(), () => {})).rejects.toThrow();
    expect(await readFile(out, 'utf8')).toBe('original');
    expect((await readdir(dir)).filter(name => name.startsWith('.rdata-export'))).toEqual([]);
    await expect(exportCsv(reader, path, out, new AbortController().signal, () => {}, [-1])).rejects.toThrow('Invalid export');
  });
});
