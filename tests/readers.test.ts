import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { ArrowFileReader, ArrowStreamError } from '../src/extension/ArrowFileReader.js';
import { CsvReader } from '../src/extension/CsvReader.js';
import type { PagedReader } from '../src/extension/paging/PagedReader.js';
import { exportCsv } from '../src/extension/exportCsv.js';

let dir: string;
let readers: PagedReader[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rdata-test-')); });
afterEach(async () => {
  await Promise.all(readers.map(reader => reader.dispose()));
  readers = [];
  await rm(dir, { recursive: true, force: true });
});
async function csv(text: string, name = 'data.csv') {
  const path = join(dir, name);
  await writeFile(path, text);
  const reader = await CsvReader.open(path);
  readers.push(reader);
  return { reader, path };
}

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

describe('CSV disk index', () => {
  it.each([',', '\t', ';', '|'])('detects %j and preserves quoted multiline/unicode cells', async delimiter => {
    const { reader } = await csv(`id${delimiter}text${delimiter}flag\n1${delimiter}"中文\nline ""2"""${delimiter}true\n2${delimiter}${delimiter}false\n`);
    expect(reader.schema.map(col => col.name)).toEqual(['id', 'text', 'flag']);
    expect(await reader.readRows(0, 2)).toEqual([[1, '中文\nline "2"', true], [2, null, false]]);
    const cacheDir = reader['dir'];
    await reader.dispose();
    await expect(readdir(cacheDir)).rejects.toThrow();
  });

  it('reads around sparse-index boundaries and rejects source changes', async () => {
    const { reader, path } = await csv('id,text\n' + Array.from({ length: 1100 }, (_, i) => `${i},row-${i}\n`).join(''));
    expect((await reader.readRows(499, 502)).map(row => row[0])).toEqual([499, 500, 501]);
    await reader.suspend();
    reader.resume();
    expect((await reader.readRows(1099, 5000))[0][0]).toBe(1099);
    await appendFile(path, '1100,new\n');
    await expect(reader.readRows(0, 1)).rejects.toThrow('changed');
  });

  it('handles empty/header-only files and cancellation without silently dropping extra fields', async () => {
    expect((await csv('')).reader.totalRows).toBe(0);
    const { reader } = await csv('a,b\n');
    expect(reader.schema.map(col => col.name)).toEqual(['a', 'b']);
    expect(await reader.readRows(0, 1)).toEqual([]);
    const path = join(dir, 'bad.csv');
    await writeFile(path, 'a,b\n1,2,3\n');
    await expect(CsvReader.open(path)).rejects.toThrow('more fields');
    const signal = AbortSignal.abort();
    await expect(CsvReader.open(path, signal)).rejects.toThrow();
  });
});

describe('CSV export', () => {
  it('exports bounded batches, quotes values and supports sorted/filtered row order', async () => {
    const { reader, path } = await csv('id,text\n1,"a,b"\n2,"multi\nline"\n');
    const out = join(dir, 'export.csv');
    await exportCsv(reader, path, out, new AbortController().signal, () => {}, [1, 0]);
    expect(await readFile(out, 'utf8')).toBe('id,text\r\n2,"multi\nline"\r\n1,"a,b"\r\n');
    await exportCsv(reader, path, out, new AbortController().signal, () => {}, []);
    expect(await readFile(out, 'utf8')).toBe('id,text\r\n');
    await expect(exportCsv(reader, path, path, new AbortController().signal, () => {})).rejects.toThrow('source');
  });

  it('keeps an existing destination intact on cancellation and rejects invalid order', async () => {
    const { reader, path } = await csv('id\n1\n2\n');
    const out = join(dir, 'export.csv');
    await writeFile(out, 'original');
    await expect(exportCsv(reader, path, out, AbortSignal.abort(), () => {})).rejects.toThrow();
    expect(await readFile(out, 'utf8')).toBe('original');
    expect((await readdir(dir)).filter(name => name.startsWith('.rdata-export'))).toEqual([]);
    await expect(exportCsv(reader, path, out, new AbortController().signal, () => {}, [-1])).rejects.toThrow('Invalid export');
  });
});
