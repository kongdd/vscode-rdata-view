import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { promisify } from 'node:util';
import { ArrowFileReader } from './ArrowFileReader.js';
import { FilePager, fileStamp } from '../paging/PagedReader.js';
import type { CellValue } from '../../shared/schema.js';

const exec = promisify(execFile);
export interface ROptions { executable: string; script: string; timeout: number; signal?: AbortSignal; selected?: string }

async function prepare(path: string, options: ROptions, start = 0, end = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'rdata-view-'));
  const output = join(dir, 'table.arrow');
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const result = await exec(options.executable, ['--vanilla', '--slave', '-f', options.script], {
      env: {
        ...process.env, RDATA_INPUT: path, RDATA_OUTPUT: output,
        RDATA_SELECTED: options.selected ?? '', RDATA_START: String(start), RDATA_END: String(end),
      },
      signal: options.signal, timeout: options.timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    options.signal?.throwIfAborted();
    // Some R frontends report a zero exit code even when the script fails.
    await stat(output).catch(() => { throw new Error(result.stderr.trim() || result.stdout.trim() || 'R did not produce an Arrow table'); });
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
  private controller?: AbortController;
  private readonly fst: boolean;

  private constructor(path: string, private options: ROptions) {
    super(path);
    this.fst = extname(path).toLowerCase() === '.fst';
    if (!this.fst) this.notice = 'This format is decoded once in R to a temporary Arrow file, then read by page.';
  }

  static async open(path: string, options: ROptions): Promise<RReader> {
    const reader = new RReader(path, options);
    await reader.initialize();
    const before = await fileStamp(path);
    const file = await prepare(path, options);
    reader.cleanup = file.dispose;
    try {
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

  protected async loadRows(start: number, end: number): Promise<CellValue[][]> {
    if (!this.fst) return this.arrow!.readRows(start, end);
    if (start === end) return [];
    this.controller = new AbortController();
    try {
      const file = await prepare(this.path, { ...this.options, signal: this.controller.signal }, start, end);
      let arrow: ArrowFileReader | undefined;
      try {
        arrow = await ArrowFileReader.open(file.path);
        return await arrow.readRows(0, end - start);
      } finally {
        try { await arrow?.dispose(); } finally { await file.dispose(); }
      }
    } finally { this.controller = undefined; }
  }

  resume(): void { super.resume(); this.arrow?.resume(); }
  protected cancel(): void { this.controller?.abort(); }
  protected async close(): Promise<void> { await this.arrow?.suspend(); }
  protected async remove(): Promise<void> {
    try { await this.arrow?.dispose(); } finally { await this.cleanup?.(); }
  }
}
