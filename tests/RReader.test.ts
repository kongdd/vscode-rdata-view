import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { RReader } from '../src/extension/reader/RReader.js';
import { disposeRWorker, runR } from '../src/extension/reader/RWorker.js';

const executable = process.env.RDATA_TEST_R;
const options = { executable: executable ?? 'R', script: resolve('src/extension/scripts/read-table.R'), timeout: 120_000 };
const served = { ...options, server: resolve('src/extension/scripts/read-table-server.R') };
let dir: string;
let readers: RReader[] = [];
describe.skipIf(!executable)('R formats (set RDATA_TEST_R to run)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdata-formats-'));
    await promisify(execFile)(options.executable, ['--vanilla', '--slave', '-f', resolve('tests/generate-fixtures.R')], {
      env: { ...process.env, RDATA_TEST_DIR: dir }, timeout: 120_000,
    });
  });
  afterEach(async () => { await Promise.all(readers.map(reader => reader.dispose())); readers = []; });
  afterAll(async () => { disposeRWorker(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it.each(['rds', 'qs2', 'qdata', 'fst'])('reads %s and releases resources on suspend/dispose', async ext => {
    const reader = await RReader.open(join(dir, 'table.' + ext), options);
    readers.push(reader);
    expect(reader.totalRows).toBe(1100);
    expect((await reader.readRows(499, 502)).map(row => row[0])).toEqual([500, 501, 502]);
    expect((await reader.readRows(0, 1))[0]).toEqual([1, '中文', true, '2025-01-01T00:00:00.000Z', 'a']);
    await reader.suspend();
    await expect(reader.readRows(0, 1)).rejects.toThrow('suspended');
    reader.resume();
    expect((await reader.readRows(1099, 5000))).toHaveLength(1);
    if (ext === 'fst') expect(reader['arrow']).toBeUndefined();
    else {
      const path = reader['arrow']!['path'];
      await reader.dispose();
      await expect(readdir(dirname(path))).rejects.toThrow();
    }
  });

  it('reads a large CSV by row range without converting the whole file', async () => {
    const path = join(dir, 'plain.csv');
    await writeFile(path, 'id,text,value\n' + Array.from({ length: 5000 }, (_, i) => `${i + 1},row-${i + 1},${i / 10}\n`).join(''));
    const reader = await RReader.open(path, { ...options, paged: true });
    readers.push(reader);
    expect(reader['ranged']).toBe(true);
    expect(reader.totalRows).toBe(5000);
    expect(await reader.readRows(0, 1)).toEqual([[1, 'row-1', 0]]);
    expect((await reader.readRows(499, 502)).map(row => row[0])).toEqual([500, 501, 502]);
    expect((await reader.readRows(4999, 9000))).toEqual([[5000, 'row-5000', 499.9]]);
  });

  it('falls back to a full conversion when quoted fields break line numbering', async () => {
    const reader = await RReader.open(join(dir, 'table.csv'), { ...options, paged: true });
    readers.push(reader);
    expect(reader['ranged']).toBe(false);
    expect(reader.totalRows).toBe(1100);
    expect((await reader.readRows(499, 502)).map(row => row[0])).toEqual([500, 501, 502]);
  });

  it('reuses one long-lived R process across formats and pages', async () => {
    const rds = await RReader.open(join(dir, 'table.rds'), served);
    readers.push(rds);
    expect((await rds.readRows(0, 2)).length).toBe(2);
    const fst = await RReader.open(join(dir, 'table.fst'), served);
    readers.push(fst);
    expect((await fst.readRows(10, 12)).map(row => row[0])).toEqual([11, 12]);
    await expect(RReader.open(join(dir, 'table.rds'), { ...served, signal: AbortSignal.abort() })).rejects.toThrow();
    expect((await rds.readRows(1, 2))[0][0]).toBe(2);
    disposeRWorker();
  });

  it.each(['rds', 'qs2', 'qdata'])('keeps %s in R, converts only pages and releases hidden/disposed tables', async ext => {
    const reader = await RReader.open(join(dir, 'table.' + ext), served);
    readers.push(reader);
    expect(reader['arrow']).toBeUndefined();
    expect(reader.totalRows).toBe(1100);
    expect((await reader.readRows(499, 502)).map(row => row[0])).toEqual([500, 501, 502]);
    expect((await reader.readRows(0, 1))[0]).toEqual([1, '中文', true, '2025-01-01T00:00:00.000Z', 'a']);
    const checkReleased = async () => {
      // 同一个 key 改读非表对象：必须重新解码并报错，不能命中旧表。
      const reply = await runR(served.executable, served.server, [
        join(dir, 'scalar.rds'), join(dir, 'probe.arrow'), '', 0, 0, 0, 0, '', reader['cacheKey'],
      ].join('\t'), undefined, served.timeout);
      expect(reply).toContain('Expected a data.frame');
    };
    await reader.suspend();
    await checkReleased();
    await expect(reader.readRows(0, 1)).rejects.toThrow('suspended');
    reader.resume();
    expect((await reader.readRows(1099, 5000)).map(row => row[0])).toEqual([1100]);
    disposeRWorker();
    expect((await reader.readRows(0, 1))[0][0]).toBe(1);
    await reader.dispose();
    await checkReleased();
  });

  it('isolates cached objects and restores selected names after a worker restart', async () => {
    const selected = "中文 ' object";
    const reader = await RReader.open(join(dir, 'objects.rda'), { ...served, selected });
    const matrix = await RReader.open(join(dir, 'objects.rda'), { ...served, selected: 'matrix' });
    readers.push(reader, matrix);
    expect(reader.selected).toBe(selected);
    await matrix.suspend();
    expect((await reader.readRows(0, 1))[0][0]).toBe(1);
    disposeRWorker();
    matrix.resume();
    expect(await matrix.readRows(0, 2)).toEqual([[1, 3, 5], [2, 4, 6]]);
    expect((await reader.readRows(1099, 1100))[0][0]).toBe(1100);
    const multi = await RReader.open(join(dir, 'objects.qs2'), served);
    readers.push(multi);
    expect(multi.choices).toEqual(['table']);
    expect(multi.selected).toBe('table');
  });

  it('preserves empty schemas, missing values, large integers, dates and list columns in memory mode', async () => {
    const empty = await RReader.open(join(dir, 'empty.rds'), served);
    const nested = await RReader.open(join(dir, 'nested.rds'), served);
    const semantics = await RReader.open(join(dir, 'semantics.rds'), served);
    readers.push(empty, nested, semantics);
    expect(empty.schema).toHaveLength(5);
    expect(empty.totalRows).toBe(0);
    expect(await empty.readRows(0, 1)).toEqual([]);
    expect((await nested.readRows(0, 1))[0][1]).toContain('c(1, 2)');
    expect(await semantics.readRows(0, 2)).toEqual([
      ['9007199254740993', '2025-01-01T00:00:00.000Z', null],
      [null, null, '中文'],
    ]);
    await expect(semantics.readRows(-1, 1)).rejects.toThrow('Invalid row range');
    await expect(RReader.open(join(dir, 'scalar.rds'), served)).rejects.toThrow('Expected a data.frame');
  });

  it('exposes variable names saved by qs_savem', async () => {
    const reader = await RReader.open(join(dir, 'objects.qs2'), options);
    readers.push(reader);
    expect(reader.choices).toEqual(['table']);
    expect(reader.selected).toBe('table');
    expect(reader.totalRows).toBe(1100);
  });

  it('lists only tabular RDA objects, selects exact Unicode names and renders matrices', async () => {
    const path = join(dir, 'objects.rda');
    const reader = await RReader.open(path, { ...options, selected: "中文 ' object" });
    readers.push(reader);
    expect(reader.choices).toContain("中文 ' object");
    expect(reader.choices).toContain('matrix');
    expect(reader.choices).not.toContain('not_table');
    expect(reader.selected).toBe("中文 ' object");
    const matrix = await RReader.open(path, { ...options, selected: 'matrix' });
    readers.push(matrix);
    expect(await matrix.readRows(0, 2)).toEqual([[1, 3, 5], [2, 4, 6]]);
    await expect(RReader.open(path, { ...options, selected: 'missing' })).rejects.toThrow('Unknown object');
  });

  it('opens empty fst and list columns; rejects non-tabular R objects', async () => {
    const empty = await RReader.open(join(dir, 'empty.fst'), options);
    readers.push(empty);
    expect(empty.totalRows).toBe(0);
    expect(empty.schema).toHaveLength(5);
    const nested = await RReader.open(join(dir, 'nested.rds'), options);
    readers.push(nested);
    expect((await nested.readRows(0, 1))[0][1]).toContain('c(1, 2)');
    await expect(RReader.open(join(dir, 'scalar.rds'), options)).rejects.toThrow('Expected a data.frame');
  });

  it.each([options, served])('lists and switches Excel worksheets through the same R → Arrow path (%j)', async settings => {
    const reader = await RReader.open(resolve('tests/fixtures/workbook.xlsx'), { ...settings, selected: '中文' });
    readers.push(reader);
    expect(reader.choices).toEqual(['first', '中文']);
    expect(reader.selected).toBe('中文');
    expect(await reader.readRows(0, 2)).toEqual([[3, 'a,b'], [4, '中文']]);
  });

  it('reports missing R and honors cancellation', async () => {
    await expect(RReader.open(join(dir, 'table.rds'), { ...options, executable: join(dir, 'missing') })).rejects.toThrow('R not found');
    await expect(RReader.open(join(dir, 'table.rds'), { ...options, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
  });
});
