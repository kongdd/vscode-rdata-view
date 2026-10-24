import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { RReader, runRQuery, type RQueryResult } from '../src/extension/reader/R.js';
import { ArrowFileReader } from '../src/extension/reader/Arrow.js';
import { exportCsv } from '../src/extension/exportCsv.js';
import { disposeRWorker, runR } from '../src/extension/reader/RWorker.js';

const executable = process.env.RDATA_TEST_R;
const options = { executable: executable ?? 'R', script: resolve('src/extension/scripts/read-table.R'), timeout: 120_000 };
const served = { ...options, server: resolve('src/extension/scripts/read-table-server.R') };
let dir: string;
let readers: RReader[] = [];
async function queryRows(result: RQueryResult) {
  const reader = await ArrowFileReader.open(result.path);
  try { return await reader.readRows(0, reader.totalRows); }
  finally { await reader.dispose(); await result.dispose(); }
}
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

  it.each(['lz4', 'zstd'])('filters %s Arrow batches with dplyr, preserving order and restoring released queries', async compression => {
    const path = join(dir, compression + '.feather');
    const before = await stat(path);
    const reader = await RReader.open(path, { ...served, filter: 'id >= 499, id <= 505, flag' });
    readers.push(reader);
    expect(reader.totalRows).toBe(4);
    expect(reader['arrow']).toBeUndefined();
    expect(reader.bytes).toBe(0);
    expect((await reader.readRows(1, 3)).map(row => row[0])).toEqual([501, 503]);
    expect((await reader.readRows(3, 99)).map(row => row[0])).toEqual([505]);
    expect((await reader.readRows(0, 1))[0]).toEqual([499, 'line\n2', true, '2026-05-14T00:00:00.000Z', 'a']);
    const target = join(dir, compression + '-filtered.csv');
    await exportCsv(reader, path, target, new AbortController().signal, () => {});
    const csv = await readFile(target, 'utf8');
    expect(csv).toContain('499,');
    expect(csv).toContain('505,');
    expect(csv).not.toContain('500,');
    await reader.suspend();
    await expect(reader.readRows(0, 1)).rejects.toThrow('suspended');
    reader.resume();
    expect((await reader.readRows(0, 1))[0][0]).toBe(499);
    disposeRWorker();
    expect((await reader.readRows(3, 4))[0][0]).toBe(505);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('supports single-shot filters, Unicode, multiline conditions, empty results and Arrow types', async () => {
    const oneShot = await RReader.open(join(dir, 'lz4.feather'), { ...options, filter: 'id >\n 1090,\tflag' });
    const unicode = await RReader.open(join(dir, 'zstd.feather'), { ...served, filter: 'text == "中文"' });
    const empty = await RReader.open(join(dir, 'empty.feather'), { ...served, filter: 'TRUE' });
    const noMatches = await RReader.open(join(dir, 'lz4.feather'), { ...served, filter: 'id < 0' });
    const semantics = await RReader.open(join(dir, 'semantics.feather'), { ...served, filter: '!is.na(big)' });
    readers.push(oneShot, unicode, empty, noMatches, semantics);
    expect((await oneShot.readRows(0, 10)).map(row => row[0])).toEqual([1091, 1093, 1095, 1097, 1099]);
    expect(unicode.totalRows).toBe(275);
    expect((await unicode.readRows(274, 275))[0][0]).toBe(1097);
    for (const reader of [empty, noMatches]) {
      expect(reader.totalRows).toBe(0);
      expect(reader.schema).toHaveLength(5);
      expect(await reader.readRows(0, 1)).toEqual([]);
    }
    expect(await semantics.readRows(0, 1)).toEqual([['9007199254740993', '2025-01-01T00:00:00.000Z', null]]);
  });

  it.each(['id >', 'unknown_column > 1'])('reports invalid filters without breaking the worker: %s', async filter => {
    await expect(RReader.open(join(dir, 'lz4.feather'), { ...served, filter })).rejects.toThrow();
    const reader = await RReader.open(join(dir, 'lz4.feather'), { ...served, filter: 'id == 1' });
    readers.push(reader);
    expect((await reader.readRows(0, 1))[0][0]).toBe(1);
  });

  it('executes dplyr commands on the active filtered table and returns an independent Arrow result', async () => {
    const path = join(dir, 'zstd.feather');
    const before = await stat(path);
    const reader = await RReader.open(path, { ...served, filter: 'id >= 499, id <= 505' });
    readers.push(reader);
    const rows = await queryRows(await reader.query(
      'cat("query output\\n"); print("ignored"); df |> filter(flag) |> arrange(desc(id)) |> collect() |> as.data.table()',
      new AbortController().signal));
    expect(rows.map(row => row[0])).toEqual([505, 503, 501, 499]);
    expect((await reader.readRows(0, 1))[0][0]).toBe(499);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect((await queryRows(await reader.query('df |> collect()', new AbortController().signal)))
      .map(row => row[0])).toEqual([499, 500, 501, 502, 503, 504, 505]);
    await expect(reader.query('42', new AbortController().signal)).rejects.toThrow('Expected a data.frame');
    await expect(reader.query('stop("query failed")', new AbortController().signal)).rejects.toThrow('query failed');
  });

  it.each([
    ['data.frame', 'data.frame(id = 1:2, value = 3:4)'],
    ['tibble', 'tibble::tibble(id = 1:2, value = 3:4)'],
    ['data.table', 'data.table::data.table(id = 1:2, value = 3:4)'],
    ['matrix', 'matrix(1:4, nrow = 2)'],
  ])('accepts %s command results without forcing data.table conversion', async (_, code) => {
    expect(await queryRows(await runRQuery(join(dir, 'lz4.feather'), served, code)))
      .toEqual([[1, 3], [2, 4]]);
  });

  it.each([options, served])('loads data.table, magrittr, dplyr and lubridate before commands (%j)', async settings => {
    const code = `
      stopifnot(all(paste0("package:", c("data.table", "magrittr", "dplyr", "lubridate")) %in% search()))
      x <- data.table(date = c("2025-01-02", "2026-03-04"), value = 1:2)
      x %<>% mutate(date = ymd(date))
      x %>% filter(year(date) == 2026) %>% transmute(year = year(date), value)
    `;
    expect(await queryRows(await runRQuery(join(dir, 'lz4.feather'), settings, code)))
      .toEqual([[2026, 2]]);
  });

  it('runs commands for TS Arrow and selected R objects, including single-shot execution', async () => {
    const rows = await queryRows(await runRQuery(join(dir, 'lz4.feather'), options,
      'df |> filter(id == 1100) |> collect() |> data.table::as.data.table()'));
    expect(rows[0][0]).toBe(1100);
    const reader = await RReader.open(join(dir, 'objects.rda'), { ...served, selected: "中文 ' object" });
    readers.push(reader);
    const result = await reader.query('df |> filter(id > 1097) |> as.data.table()', new AbortController().signal);
    expect((await queryRows(result)).map(row => row[0])).toEqual([1098, 1099, 1100]);
    await expect(readdir(dirname(result.path))).rejects.toThrow();
  });

  it('cancels R commands and restores filtered paging after the worker is stopped', async () => {
    const reader = await RReader.open(join(dir, 'lz4.feather'), { ...served, filter: 'id > 1090' });
    readers.push(reader);
    const controller = new AbortController();
    const pending = reader.query('Sys.sleep(10); df |> collect() |> as.data.table()', controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try { await expect(pending).rejects.toThrow(/cancelled/); }
    finally { clearTimeout(timer); }
    expect((await reader.readRows(9, 10))[0][0]).toBe(1100);
  });

  it.skipIf(!process.env.RDATA_TEST_ARROW)('filters and queries a production Arrow file without modifying it', async () => {
    const path = process.env.RDATA_TEST_ARROW!;
    const source = await ArrowFileReader.open(path);
    try {
      const before = await stat(path);
      const tail = await source.readRows(Math.max(0, source.totalRows - 1000), source.totalRows);
      const id = source.schema.findIndex(column => column.name === 'id');
      const flag = source.schema.findIndex(column => column.name === 'flag');
      expect(id).toBeGreaterThanOrEqual(0);
      expect(flag).toBeGreaterThanOrEqual(0);
      const expected = tail.filter(row => row[flag] === true);
      const reader = await RReader.open(path, { ...served, filter: `id >= ${Number(tail[0][id])}, flag` });
      readers.push(reader);
      expect(reader.totalRows).toBe(expected.length);
      expect(await reader.readRows(0, reader.totalRows)).toEqual(expected);
      expect(reader['arrow']).toBeUndefined();
      expect(await queryRows(await reader.query(
        'df |> summarise(n = n()) |> collect() |> as.data.table()', new AbortController().signal,
      ))).toEqual([[expected.length]]);
      expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    } finally { await source.dispose(); }
  });

  it('reports missing R and honors cancellation', async () => {
    await expect(RReader.open(join(dir, 'table.rds'), { ...options, executable: join(dir, 'missing') })).rejects.toThrow('R not found');
    await expect(RReader.open(join(dir, 'table.rds'), { ...options, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
  });
});
