import { mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PagedReader } from './reader/Paged.js';
import type { CellValue } from '../shared/schema.js';

const escape = (value: CellValue): string => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};

/** Write beside the destination, then rename. Cancellation never leaves a partial CSV. */
export async function exportCsv(
  reader: PagedReader, source: string, target: string, signal: AbortSignal,
  progress: (pct: number) => void, order?: number[], protectedPaths: readonly string[] = [],
): Promise<void> {
  const canonical = async (path: string) => (await realpath(path).catch(() => resolve(path)));
  const destination = await canonical(target);
  const sources = await Promise.all([source, ...protectedPaths].map(canonical));
  if (sources.includes(destination)) throw new Error('Export cannot overwrite a source file.');
  if (order && (order.length > 100_000 || order.some(row => !Number.isSafeInteger(row) || row < 0 || row >= reader.totalRows))) {
    throw new Error('Invalid export row order');
  }
  const dir = await mkdtemp(join(dirname(target), '.rdata-export-'));
  const path = join(dir, 'table.csv');
  const file = await open(path, 'wx');
  try {
    await file.writeFile(reader.schema.map(field => escape(field.name)).join(',') + '\r\n');
    // Small tables may export their filtered/sorted view; paged tables export in source order.
    const smallRows = order ? await reader.readRows(0, reader.totalRows) : undefined;
    const count = order?.length ?? reader.totalRows;
    for (let start = 0; start < count; start += 5000) {
      signal.throwIfAborted();
      const rows = order
        ? order.slice(start, start + 5000).map(index => smallRows![index])
        : await reader.readRows(start, Math.min(start + 5000, count));
      await file.writeFile(rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n');
      progress(Math.round(Math.min(start + 5000, count) / count * 100));
    }
    signal.throwIfAborted();
    await file.close();
    await rename(path, target);
  } finally {
    await file.close();
    await rm(dir, { recursive: true, force: true });
  }
}
