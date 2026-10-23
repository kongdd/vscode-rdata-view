import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { promisify } from 'node:util';
import { ArrowFileReader } from './ArrowFileReader.js';
import { runR } from './RWorker.js';
import { FilePager, fileStamp } from '../paging/PagedReader.js';
import type { CellValue } from '../../shared/schema.js';

const exec = promisify(execFile);
export interface ROptions {
  executable: string; script: string; timeout: number; server?: string;
  signal?: AbortSignal; selected?: string; paged?: boolean;
}

/** 一次扫描得到换行数与是否含引号（约 4GB/s）。带引号时行号与记录号不一致，需整体转换。 */
async function scanCsv(path: string): Promise<{ lines: number; quoted: boolean }> {
  let lines = 0, quoted = false, tail = 10;
  for await (const buffer of createReadStream(path, { highWaterMark: 8 << 20 })) {
    for (let i = -1; (i = buffer.indexOf(10, i + 1)) >= 0;) lines++;
    if (!quoted) quoted = buffer.includes(34);
    tail = buffer[buffer.length - 1];
  }
  return { lines: tail === 10 ? lines : lines + 1, quoted };
}

async function prepare(path: string, options: ROptions, start = 0, end = 1, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rdata-view-'));
  const output = join(dir, 'table.arrow');
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    if (options.server) {
      // 常驻进程：一次请求完成同样的转换，省去启动与包加载。
      const request = [path, output, options.selected ?? '', start, end,
        extra.RDATA_PAGED === '1' ? '1' : '0', extra.RDATA_SAMPLE === '1' ? '1' : '0',
        extra.RDATA_CLASSES ?? ''].join('\t');
      const reply = await runR(options.executable, options.server, request, options.signal, options.timeout);
      if (reply !== 'ok') throw new Error(reply.replace(/^error\t/, ''));
    } else {
      const result = await exec(options.executable, ['--vanilla', '--slave', '-f', options.script], {
        env: {
          ...process.env, RDATA_INPUT: path, RDATA_OUTPUT: output,
          RDATA_SELECTED: options.selected ?? '', RDATA_START: String(start), RDATA_END: String(end),
          ...extra,
        },
        signal: options.signal, timeout: options.timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      // Some R frontends report a zero exit code even when the script fails.
      await stat(output).catch(() => { throw new Error(result.stderr.trim() || result.stdout.trim() || 'R did not produce an Arrow table'); });
    }
    options.signal?.throwIfAborted();
    return { path: output, dispose };
  } catch (error) {
    await dispose();
    if (options.signal?.aborted) throw new Error('R loading cancelled');
    const e = error as Error & { code?: string; stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') throw new Error('R not found. Set rdataView.r.executable to R or arf.');
    if (e.killed) throw new Error('R timed out. Increase rdataView.r.timeoutSeconds.');
    throw new Error(e.stderr?.trim() || e.message);
  }
}

/** fst slices rows in R; serialized R objects decode once to a temporary Arrow file. */
export class RReader extends FilePager {
  choices: string[] = [];
  selected = '';
  bytes = 0;
  private arrow?: ArrowFileReader;
  private cleanup?: () => Promise<void>;
  private dir = '';
  private controller?: AbortController;
  private readonly fst: boolean;
  private ranged: boolean;

  private constructor(path: string, private options: ROptions) {
    super(path);
    this.fst = extname(path).toLowerCase() === '.fst';
    this.ranged = !this.fst && options.paged === true;
    if (!this.fst && !this.ranged) this.notice = 'This format is decoded once in R to a temporary Arrow file, then read by page.';
  }

  static async open(path: string, options: ROptions): Promise<RReader> {
    const reader = new RReader(path, options);
    await reader.initialize();
    const before = await fileStamp(path);
    try {
      if (reader.ranged && await reader.openRanged(options, before)) return reader;
      const file = await prepare(path, options);
      reader.cleanup = file.dispose;
      reader.arrow = await ArrowFileReader.open(file.path);
      reader.schema = reader.arrow.schema;
      reader.totalRows = reader.fst ? Number(await readFile(file.path + '.rows', 'utf8')) : reader.arrow.totalRows;
      if (!Number.isSafeInteger(reader.totalRows) || reader.totalRows < 0) throw new Error('Invalid R row count');
      const names = (await readFile(file.path + '.names', 'utf8')).trimEnd().split('\n').map(name => Buffer.from(name, 'hex').toString('utf8'));
      reader.selected = names.shift() ?? '';
      reader.choices = names;
      reader.bytes = (await stat(file.path)).size;
      if (await fileStamp(path) !== before) throw new Error('File changed during R conversion. Reopen the editor.');
      if (reader.fst) {
        await reader.arrow.dispose();
        reader.arrow = undefined;
        await file.dispose();
        reader.cleanup = undefined;
      }
      return reader;
    } catch (error) {
      await reader.dispose();
      throw error;
    }
  }

  /** 大 CSV 不落地：一次采样定型，行数按换行符统计，翻页交给 fread(skip, nrow)。 */
  private async openRanged(options: ROptions, before: string): Promise<boolean> {
    const { lines, quoted } = await scanCsv(this.path);
    if (quoted) {
      // 引号内换行会让行号与记录号错位，退回整体转换。
      this.ranged = false;
      this.notice = 'Quoted multi-line fields need a one-off conversion; rows are then read by page.';
      return false;
    }
    this.dir = await mkdtemp(join(tmpdir(), 'rdata-csv-'));
    const file = await prepare(this.path, options, 0, 0, {
      RDATA_PAGED: '1', RDATA_SAMPLE: '1', RDATA_CLASSES: this.classFile,
    });
    try {
      const sample = await ArrowFileReader.open(file.path);
      this.schema = sample.schema;
      await sample.dispose();
    } finally {
      await file.dispose();
    }
    this.totalRows = Math.max(0, lines - 1);
    this.notice = 'Rows are read on demand with data.table::fread() to keep memory flat.';
    if (await fileStamp(this.path) !== before) throw new Error('File changed while indexing. Reopen the editor.');
    return true;
  }

  protected async loadRows(start: number, end: number): Promise<CellValue[][]> {
    if (!this.fst && !this.ranged) return this.arrow!.readRows(start, end);
    if (start === end) return [];
    this.controller = new AbortController();
    try {
      const extra: Record<string, string> = this.ranged ? { RDATA_PAGED: '1', RDATA_CLASSES: this.classFile } : {};
      const file = await prepare(this.path, { ...this.options, signal: this.controller.signal }, start, end, extra);
      let arrow: ArrowFileReader | undefined;
      try {
        arrow = await ArrowFileReader.open(file.path);
        const rows = await arrow.readRows(0, end - start);
        // 估算行数偏大时就地收敛，避免尾部空页。
        if (rows.length < end - start && end >= this.totalRows) this.totalRows = start + rows.length;
        return rows;
      } finally {
        try { await arrow?.dispose(); } finally { await file.dispose(); }
      }
    } finally { this.controller = undefined; }
  }

  private get classFile(): string { return join(this.dir, 'classes.rds'); }

  resume(): void { super.resume(); this.arrow?.resume(); }
  protected cancel(): void { this.controller?.abort(); }
  protected async close(): Promise<void> { await this.arrow?.suspend(); }
  protected async remove(): Promise<void> {
    try { await this.arrow?.dispose(); } finally {
      await this.cleanup?.();
      if (this.dir) await rm(this.dir, { recursive: true, force: true });
    }
  }
}
