import { open, type FileHandle } from 'node:fs/promises';
import { MessageReader, RecordBatchReader, type AsyncRecordBatchFileReader, type RecordBatch } from 'apache-arrow';
import { arrowTypeToInferred, coerceArrowValue } from '../../shared/arrowReader.js';
import type { CellValue } from '../../shared/schema.js';
import { FilePager } from '../paging/PagedReader.js';

const CACHE_BYTES = 32 * 1024 * 1024;

/** Signals an IPC stream, which has no footer and must be indexed instead. */
export class ArrowStreamError extends Error {}

/** Random-access Feather V2 reader. Only metadata and at most two batches stay resident. */
export class ArrowFileReader extends FilePager {
  private handle: FileHandle | null = null;
  private reader: AsyncRecordBatchFileReader | null = null;
  private rowEnds: number[] = [];
  private cache = new Map<number, RecordBatch>();
  private cacheBytes = 0;

  private constructor(path: string) {
    super(path);
  }

  static async open(path: string): Promise<ArrowFileReader> {
    const file = new ArrowFileReader(path);
    await file.initialize();
    try {
      const reader = await file.openReader();
      file.schema = reader.schema.fields.map((field, index) => ({
        name: field.name,
        index,
        inferredType: arrowTypeToInferred(field.type),
        nullable: field.nullable,
      }));
      for (const block of reader.footer!.recordBatches()) {
        const bytes = new Uint8Array(block.metaDataLength);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.handle!.read(bytes, offset, bytes.length - offset, block.offset + offset);
          if (bytesRead === 0) throw new Error('Truncated Arrow batch metadata');
          offset += bytesRead;
        }
        const message = new MessageReader(bytes).readMessage();
        if (!message?.isRecordBatch()) throw new Error('Invalid Arrow record batch');
        file.totalRows += message.header().length;
        if (!Number.isSafeInteger(file.totalRows)) throw new Error('Arrow row count exceeds the safe integer range');
        file.rowEnds.push(file.totalRows);
      }
      return file;
    } catch (error) {
      await file.dispose();
      throw error;
    }
  }

  protected async loadRows(start: number, end: number): Promise<CellValue[][]> {
    const rows: CellValue[][] = [];
    let index = 0;
    while (index < this.rowEnds.length && this.rowEnds[index] <= start) index++;
    while (start < end) {
      const batch = await this.readBatch(index);
      if (!this.active) throw new Error('Arrow reader is suspended');
      const batchStart = index === 0 ? 0 : this.rowEnds[index - 1];
      const batchEnd = Math.min(end, this.rowEnds[index]);
      const columns = batch.schema.fields.map((_, col) => batch.getChildAt(col)!);
      for (; start < batchEnd; start++) {
        rows.push(columns.map((column, col) => {
          const value = coerceArrowValue(column.get(start - batchStart));
          return this.schema[col].inferredType === 'date' && typeof value === 'number' && Number.isFinite(value)
            ? new Date(value).toISOString() : value;
        }));
      }
      index++;
    }
    return rows;
  }

  protected async close(): Promise<void> {
    this.cache.clear();
    this.cacheBytes = 0;
    const { reader, handle } = this;
    this.reader = null;
    this.handle = null;
    if (reader) await reader.cancel();
    else if (handle) await handle.close();
  }

  private async openReader(): Promise<AsyncRecordBatchFileReader> {
    if (this.reader) return this.reader;
    const handle = this.handle = await open(this.path, 'r');
    const { size } = await handle.stat();
    const tail = new Uint8Array(10);
    if (size < 18 || (await handle.read(tail, 0, 10, size - 10)).bytesRead !== 10 ||
        new TextDecoder().decode(tail.subarray(4)) !== 'ARROW1') {
      throw new ArrowStreamError('Not an Arrow IPC file');
    }
    const reader = await RecordBatchReader.from(handle);
    if (!reader.isFile() || !reader.isAsync()) throw new Error('Expected an Arrow IPC file');
    this.reader = reader;
    await reader.open({ autoDestroy: false });
    return reader;
  }

  private async readBatch(index: number): Promise<RecordBatch> {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    let batch: RecordBatch;
    try {
      batch = (await (await this.openReader()).readRecordBatch(index))!;
      if (!batch) throw new Error('Arrow record batch is missing');
    } catch (error) {
      await this.close();
      throw error;
    }
    const bytes = batch.data.byteLength;
    if (bytes <= CACHE_BYTES) {
      this.cache.set(index, batch);
      this.cacheBytes += bytes;
      while (this.cache.size > 2 || this.cacheBytes > CACHE_BYTES) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.data.byteLength;
        this.cache.delete(oldest);
      }
    }
    return batch;
  }
}
