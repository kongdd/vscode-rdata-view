import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { RReader } from '../src/extension/reader/RReader.js';

const executable = process.env.RDATA_TEST_R;
const options = { executable: executable ?? 'R', script: resolve('src/extension/scripts/read-table.R'), timeout: 120_000 };
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
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

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

  it('lists and switches Excel worksheets through the same R → Arrow path', async () => {
    const reader = await RReader.open(resolve('tests/fixtures/workbook.xlsx'), { ...options, selected: '中文' });
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
