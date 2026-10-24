import { expect, it } from 'vitest';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ArrowFileReader } from '../src/extension/reader/Arrow.js';
import { RReader } from '../src/extension/reader/R.js';
import { disposeRWorker } from '../src/extension/reader/RWorker.js';
import { CHUNK_SIZE } from '../src/shared/constants.js';

// RDATA_PERF=1 RDATA_TEST_R=arf npx vitest run tests/test-perform.test.ts
// 只测实际 reader，不含 Webview 通信/绘制；冷加载指新 R 进程，不清理系统文件缓存。
it.skipIf(process.env.RDATA_PERF !== '1')('data/big.* loading and paging performance', async () => {
  const options = {
    executable: process.env.RDATA_TEST_R || 'arf',
    script: resolve('src/extension/scripts/read-table.R'),
    server: resolve('src/extension/scripts/read-table-server.R'),
    timeout: 120_000,
  };
  const budget = 64 * 1024 * 1024;
  const repeats = 3;
  const samples: Record<string, number | string>[] = [];
  const summary: Record<string, number | string>[] = [];
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const files = (await readdir('data')).filter(name => /^big\.(arrow|feather|csv|tsv|fst|qs2|qdata|rds|rda|rdata|xlsx)$/i.test(name)).sort();
  expect(files.length).toBeGreaterThan(0);
  try {
    for (const file of files) {
      const path = resolve('data', file);
      const ext = extname(file).toLowerCase();
      const bytes = (await stat(path)).size;
      const runs: Record<string, number>[] = [];
      const open = () => ['.arrow', '.feather'].includes(ext)
        ? ArrowFileReader.open(path)
        : RReader.open(path, {
          ...options,
          // 与 TableView 默认 64 MiB 配置一致：512 MiB 以上 CSV 才尝试行区间读取。
          paged: ['.csv', '.tsv'].includes(ext) && bytes > Math.max(budget, 512 * 1024 * 1024),
        });
      for (let repeat = 1; repeat <= repeats; repeat++) {
        disposeRWorker();
        let start = performance.now();
        const reader = await open();
        const run: Record<string, number> = { load_ms: performance.now() - start, rows: reader.totalRows, columns: reader.schema.length };
        try {
          const positions = {
            first_ms: 0,
            middle_ms: Math.floor(reader.totalRows / 2 / CHUNK_SIZE) * CHUNK_SIZE,
            last_ms: Math.max(0, Math.floor((reader.totalRows - 1) / CHUNK_SIZE) * CHUNK_SIZE),
          };
          for (const [key, from] of Object.entries(positions)) {
            const end = Math.min(from + CHUNK_SIZE, reader.totalRows);
            start = performance.now();
            const rows = await reader.readRows(from, end);
            run[key] = performance.now() - start;
            expect(rows).toHaveLength(end - from);
            expect(rows.every(row => row.length === reader.schema.length)).toBe(true);
          }
          run.ready_ms = run.load_ms + run.first_ms;
        } finally { await reader.dispose(); }
        start = performance.now();
        const warm = await open();
        run.warm_load_ms = performance.now() - start;
        await warm.dispose();
        runs.push(run);
        samples.push({ file, repeat, ...run });
      }
      const row: Record<string, number | string> = { file, MiB: +(bytes / 1024 ** 2).toFixed(1) };
      for (const key of Object.keys(runs[0])) row[key] = +median(runs.map(run => run[key])).toFixed(1);
      summary.push(row);
      console.log(file, JSON.stringify(row));
    }
  } finally { disposeRWorker(); }
  await writeFile('data/test-perform.json', JSON.stringify({
    measured_at: new Date().toISOString(), node: process.version, platform: process.platform,
    arch: process.arch, executable: options.executable, page_rows: CHUNK_SIZE, repeats,
    scope: 'Reader only; cold R process, OS file cache not cleared; warm load reopens the same file; pages read first/middle/last without UI prefetch.',
    summary, samples,
  }, null, 2) + '\n');
  console.table(summary);
}, 600_000);
