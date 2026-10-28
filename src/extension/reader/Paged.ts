import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { CellValue, ColumnSchema } from '../../shared/schema.js';

export interface PagedReader {
  schema: ColumnSchema[];
  totalRows: number;
  readRows(start: number, end: number): Promise<CellValue[][]>;
  suspend(): Promise<void>;
  resume(): void;
  dispose(): Promise<void>;
}

export async function fileStamp(path: string): Promise<string> {
  const { size, mtimeMs, ino } = await stat(path);
  const stamp = `${size}:${mtimeMs}:${ino}`;
  if (extname(path).toLowerCase() !== '.shp') return stamp;
  const dir = dirname(path);
  const stem = basename(path, extname(path)).toLowerCase();
  const files = (await readdir(dir)).filter(name => basename(name, extname(name)).toLowerCase() === stem &&
    ['.shx', '.dbf', '.prj', '.cpg', '.qix', '.sbn', '.sbx'].includes(extname(name).toLowerCase())).sort();
  const parts = await Promise.all(files.map(async name => {
    const info = await stat(join(dir, name));
    return `${name}:${info.size}:${info.mtimeMs}:${info.ino}`;
  }));
  return JSON.stringify([stamp, ...parts]);
}

/** Serialize reads and teardown; never retain the last page in the queue's result. */
export abstract class FilePager implements PagedReader {
  schema: ColumnSchema[] = [];
  totalRows = 0;
  protected active = true;
  private queue: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private stamp = '';

  constructor(protected readonly path: string) {}

  protected async initialize(): Promise<void> {
    this.stamp = await fileStamp(this.path);
  }

  readRows(start: number, end: number): Promise<CellValue[][]> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return Promise.reject(new Error('Invalid row range'));
    }
    return this.enqueue(async () => {
      if (!this.active) throw new Error('Reader is suspended');
      if (await fileStamp(this.path) !== this.stamp) throw new Error('File changed on disk. Reopen the editor.');
      const rows = start >= this.totalRows ? [] : await this.loadRows(start, Math.min(end, this.totalRows));
      if (!this.active) throw new Error('Reader is suspended');
      return rows;
    });
  }

  suspend(): Promise<void> {
    this.active = false;
    this.cancel();
    return this.enqueue(() => this.close());
  }

  resume(): void {
    if (!this.disposal) this.active = true;
  }

  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      try { await this.suspend(); }
      finally { await this.remove(); }
    })();
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  protected abstract loadRows(start: number, end: number): Promise<CellValue[][]>;
  protected cancel(): void {}
  protected async close(): Promise<void> {}
  protected async remove(): Promise<void> {}
}
