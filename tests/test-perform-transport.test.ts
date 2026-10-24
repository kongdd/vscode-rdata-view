import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ArrowFileReader } from '../src/extension/reader/Arrow.js';
import { arrowTypeToInferred, coerceArrowValue, readArrowIPC } from '../src/shared/arrowReader.js';
import type { CellValue } from '../src/shared/schema.js';
import { createFrameReader } from './frameReader.js';

const methods = ['arrow', 'binary', 'json'] as const;
type Method = typeof methods[number];
type Times = Record<`${Method}_ms`, number>;
interface Metadata { rows: number; columns: number; integer64: number[] }

// RDATA_PERF=1 RDATA_TEST_R=arf npx vitest run tests/test-perform-transport.test.ts
it.skipIf(process.env.RDATA_PERF !== '1')('R memory → Arrow file / binary pipe / JSON pipe', async () => {
  const executable = process.env.RDATA_TEST_R || 'arf';
  const repeats = 15;
  const samples: (Times & { page_rows: number; position: string; repeat: number })[] = [];
  const summary: Record<string, string | number>[] = [];
  const proc = spawn(executable, ['--vanilla', '--slave', '-f', resolve('tests/test-perform-transport.R')]);
  const readFrame = createFrameReader(proc.stdout);
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  proc.on('error', error => { stderr = error.message; });
  proc.stdin.on('error', () => undefined);
  let metadata: Metadata;
  // 测试客户端串行请求；三种方式使用同一进程、同一长度帧读取器。
  const request = async (...fields: (string | number)[]) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000).unref();
    try {
      proc.stdin.write(fields.join('\t') + '\n');
      const reply = await readFrame();
      if (reply.subarray(0, 6).toString() === 'error\t') throw new Error(reply.toString().slice(6));
      return reply;
    } catch (error) {
      throw new Error(`${(error as Error).message}${stderr ? '\n' + stderr : ''}`);
    } finally { clearTimeout(timer); }
  };
  const read = async (method: Method, start: number, end: number) => {
    const t = performance.now();
    let rows: CellValue[][];
    if (method === 'json') {
      rows = JSON.parse((await request(method, start, end)).toString('utf8'));
      for (const row of rows) for (const col of metadata.integer64) {
        if (row[col] !== null && Number.isSafeInteger(Number(row[col]))) row[col] = Number(row[col]);
      }
    } else if (method === 'binary') {
      const table = readArrowIPC(await request(method, start, end));
      const columns = table.schema.fields.map((field, index) => ({
        vector: table.getChildAt(index)!, date: arrowTypeToInferred(field.type) === 'date',
      }));
      rows = Array.from({ length: table.numRows }, (_, row) => columns.map(({ vector, date }) => {
        const value = coerceArrowValue(vector.get(row));
        return date && typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : value;
      }));
    } else {
      // 包含临时目录创建、R 编码/写入、Arrow 解码和文件清理。
      const dir = await mkdtemp(join(tmpdir(), 'rdata-transport-'));
      let reader: ArrowFileReader | undefined;
      try {
        if ((await request(method, start, end, join(dir, 'page.arrow'))).toString() !== 'ok') throw new Error('Missing Arrow page');
        reader = await ArrowFileReader.open(join(dir, 'page.arrow'));
        rows = await reader.readRows(0, end - start);
      } finally {
        try { await reader?.dispose(); } finally { await rm(dir, { recursive: true, force: true }); }
      }
    }
    return { rows, ms: performance.now() - t };
  };
  const percentile = (values: number[], p: number) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return +sorted[Math.ceil(sorted.length * p) - 1].toFixed(2);
  };
  try {
    metadata = JSON.parse((await request('fixture')).toString());
    for (const [start, end] of [[0, 3], [0, 0], [1, 2]]) {
      const expected = (await read('arrow', start, end)).rows;
      for (const method of ['binary', 'json'] as const) expect((await read(method, start, end)).rows).toEqual(expected);
    }
    metadata = JSON.parse((await request('load', resolve('data/big.rds'))).toString());
    expect(metadata).toMatchObject({ rows: 2_000_000, columns: 10 });
    for (const pageRows of [500, 5000, 50_000]) {
      const positions = { first: 0, middle: Math.floor(metadata.rows / 2), last: metadata.rows - pageRows };
      for (const [position, start] of Object.entries(positions)) {
        const end = start + pageRows;
        // 每组预热两轮；整页逐值对齐后再测量，断言不计时。
        for (let warmup = 0; warmup < 2; warmup++) {
          const expected = (await read('arrow', start, end)).rows;
          for (const method of ['binary', 'json'] as const) expect((await read(method, start, end)).rows).toEqual(expected);
        }
        const runs: Times[] = [];
        for (let repeat = 1; repeat <= repeats; repeat++) {
          const run: Times = { arrow_ms: 0, binary_ms: 0, json_ms: 0 };
          // 轮换先后顺序，均不复用 JS 页缓存，也不在请求中强制 GC。
          const offset = repeat % methods.length;
          const order = [...methods.slice(offset), ...methods.slice(0, offset)];
          if (repeat % 2) order.reverse();
          for (const method of order) {
            const result = await read(method, start, end);
            run[`${method}_ms`] = result.ms;
            expect(result.rows).toHaveLength(pageRows);
          }
          runs.push(run);
          samples.push({ page_rows: pageRows, position, repeat, ...run });
        }
        const row: Record<string, string | number> = { page_rows: pageRows, position };
        for (const method of methods) {
          const values = runs.map(run => run[`${method}_ms`]);
          row[`${method}_p50_ms`] = percentile(values, 0.5);
          row[`${method}_p95_ms`] = percentile(values, 0.95);
        }
        summary.push(row);
        console.log(JSON.stringify(row));
      }
    }
  } finally { proc.stdin.end(); proc.kill(); }
  await writeFile('data/test-perform-transport.json', JSON.stringify({
    measured_at: new Date().toISOString(), node: process.version, platform: process.platform,
    arch: process.arch, executable, source: 'data/big.rds', rows: metadata.rows, columns: metadata.columns,
    repeats, warmup: 2, framing: 'uint32 LE length + payload, all three methods', arrow_compression: 'zstd',
    scope: 'Same R memory table and framed binary reader; rotating method order; includes IPC, encoding, JS decoding and Arrow temporary-file lifecycle. Excludes R startup, file decoding, UI communication/rendering and value assertions.',
    summary, samples,
  }, null, 2) + '\n');
  console.table(summary);
}, 600_000);
