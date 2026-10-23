import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import Papa from 'papaparse';
import { FilePager, fileStamp } from './paging/PagedReader.js';
import { CHUNK_SIZE } from '../shared/constants.js';
import type { CellValue } from '../shared/schema.js';

/** One bounded streaming pass builds a sparse row index; the original stays untouched. */
export class CsvReader extends FilePager {
  private dir = '';
  private offsets: number[] = [];

  static async open(path: string, signal?: AbortSignal): Promise<CsvReader> {
    const reader = new CsvReader(path);
    await reader.initialize();
    const before = await fileStamp(path);
    let source: ReturnType<typeof createReadStream> | undefined;
    let output: ReturnType<typeof createWriteStream> | undefined;
    let parser: Duplex | undefined;
    try {
      let sample = '';
      for await (const chunk of createReadStream(path, { encoding: 'utf8', signal, highWaterMark: 64 * 1024 })) {
        sample = chunk;
        break;
      }
      const delimiter = extname(path).toLowerCase() === '.tsv' ? '\t' : Papa.parse(sample, { preview: 10 }).meta.delimiter;
      reader.dir = await mkdtemp(join(tmpdir(), 'rdata-csv-'));
      output = createWriteStream(join(reader.dir, 'rows.jsonl'));
      let writeError: Error | undefined;
      output.on('error', error => { writeError = error; });
      source = createReadStream(path, { signal });
      const stream = parser = Papa.parse(Papa.NODE_STREAM_INPUT, { delimiter, skipEmptyLines: 'greedy' });
      source.on('error', error => stream.destroy(error));
      source.pipe(stream);
      let offset = 0;
      let header = true;
      for await (const record of stream) {
        signal?.throwIfAborted();
        if (writeError) throw writeError;
        const values = record as string[];
        if (header) {
          reader.schema = values.map((name, index) => ({ name: name.replace(/^\uFEFF/, ''), index, inferredType: 'null', nullable: true }));
          header = false;
          continue;
        }
        if (values.length > reader.schema.length) throw new Error('CSV row has more fields than its header');
        const row = reader.schema.map((field, col) => {
          const raw = values[col] ?? '';
          const value: CellValue = raw === '' || raw === 'NA' ? null : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' :
            raw.trim() && Number.isFinite(Number(raw)) ? Number(raw) : raw;
          if (value !== null) {
            const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
            field.inferredType = field.inferredType === 'null' || field.inferredType === type ? type : 'string';
          }
          return value;
        });
        const line = JSON.stringify(row) + '\n';
        if (reader.totalRows % CHUNK_SIZE === 0) reader.offsets.push(offset);
        reader.totalRows++;
        offset += Buffer.byteLength(line);
        if (!output.write(line)) await once(output, 'drain', { signal });
      }
      output.end();
      await once(output, 'finish');
      if (writeError) throw writeError;
      if (await fileStamp(path) !== before) throw new Error('CSV changed while indexing');
      return reader;
    } catch (error) {
      parser?.destroy();
      source?.destroy();
      output?.destroy();
      if (output && !output.closed) await once(output, 'close').catch(() => undefined);
      await reader.dispose();
      throw error;
    } finally {
      parser?.destroy();
      source?.destroy();
      output?.destroy();
      if (output && !output.closed) await once(output, 'close').catch(() => undefined);
    }
  }

  protected async loadRows(start: number, end: number): Promise<CellValue[][]> {
    if (start === end) return [];
    const block = Math.floor(start / CHUNK_SIZE);
    const input = createReadStream(join(this.dir, 'rows.jsonl'), { start: this.offsets[block] });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const rows: CellValue[][] = [];
    let index = block * CHUNK_SIZE;
    try {
      for await (const line of lines) {
        if (!this.active) throw new Error('Reader is suspended');
        if (index++ >= start) rows.push(JSON.parse(line));
        if (index >= end) break;
      }
    } finally {
      lines.close();
      input.destroy();
      if (!input.closed) await once(input, 'close').catch(() => undefined);
    }
    return rows;
  }

  protected async remove(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
