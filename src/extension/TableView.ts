import * as vscode from 'vscode';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ArrowFileReader, ArrowStreamError } from './reader/Arrow.js';
import { RReader, runRQuery, type RQueryResult } from './reader/R.js';
import { warmR } from './reader/RWorker.js';
import { exportCsv } from './exportCsv.js';
import type { PagedReader } from './reader/Paged.js';
import type { HostMessage, WebviewMessage } from '../shared/messages.js';
import { CHUNK_SIZE, type FileType } from '../shared/constants.js';
import type { CellValue } from '../shared/schema.js';

const PAGED_CSV_BYTES = 512 * 1024 * 1024;

function fileType(path: string): FileType {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === 'tsv') return 'csv';
  if (ext === 'xlsx') return 'excel';
  if (ext === 'feather') return 'arrow';
  if (ext === 'rdata') return 'rda';
  if (['csv', 'arrow', 'rda', 'rds', 'fst', 'qs2', 'qdata', 'shp', 'gpkg', 'geojson'].includes(ext)) return ext as FileType;
  throw new Error('Unsupported file format: ' + ext);
}

function rExecutable(uri: vscode.Uri): string {
  const own = vscode.workspace.getConfiguration('rdataView').get<string>('r.executable', '').trim();
  const r = vscode.workspace.getConfiguration('r');
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const configured = [r.get<string>(`rpath.${platform}`), r.get<string>('consolePath'), r.get<string>(`rterm.${platform}`)]
    .find(path => path && /^(R|arf)(\.exe)?$/i.test(basename(path)));
  const path = own || configured || 'R';
  return path.replace(/^~(?=$|[/\\])/, homedir())
    .replace(/\$\{workspaceFolder\}/g, vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? '');
}

interface ViewOptions {
  title?: string;
  cleanup?: () => Promise<void>;
  protectedPaths?: string[];
  openQuery?: (result: RQueryResult, title: string, sources: string[]) => void;
}

/** One panel owns one reader and one cancellable load; no document patch/save machinery. */
export class TableView implements vscode.Disposable {
  private reader?: PagedReader;
  private loading?: AbortController;
  private exporting?: AbortController;
  private querying?: AbortController;
  private selected = '';
  private filter = '';
  private ready = false;
  private disposed = false;
  private paged = true;
  private loadQueue: Promise<void> = Promise.resolve();

  constructor(private uri: vscode.Uri, private panel: vscode.WebviewPanel, private root: vscode.Uri,
    private options: ViewOptions = {}) {
    if (fileType(uri.fsPath) !== 'arrow') this.prewarmR();
    const webRoot = vscode.Uri.joinPath(root, 'webview-ui', 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [webRoot] };
    const nonce = randomBytes(16).toString('hex');
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(webRoot, name));
    panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('index.css')}"></head><body>
      <div id="app"></div><script nonce="${nonce}" type="module" src="${asset('main.js')}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.receive(message).catch(error => this.fail(error, message?.type === 'REQUEST_CHUNK' ? message.payload.requestId : undefined));
    });
    panel.onDidChangeViewState(() => {
      if (!this.ready || this.disposed) return;
      if (!panel.visible) {
        this.loading?.abort();
        this.exporting?.abort();
        this.querying?.abort();
        this.send({ type: 'DATA_VISIBILITY', payload: { visible: false } });
        void this.reader?.suspend().catch(error => this.fail(error));
      } else {
        this.reader?.resume();
        void this.load().catch(error => this.fail(error));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loading?.abort();
    this.exporting?.abort();
    this.querying?.abort();
    const closing = this.reader?.dispose();
    void closing?.catch(() => undefined);
    this.reader = undefined;
    if (this.options.cleanup) {
      void Promise.allSettled([this.loadQueue, closing]).then(() => this.options.cleanup!()).catch(() => undefined);
    }
  }

  private send(message: HostMessage): void { if (!this.disposed) void this.panel.webview.postMessage(message); }
  private fail(error: unknown, requestId?: string): void {
    this.send({ type: 'ERROR', payload: { message: error instanceof Error ? error.message : String(error), requestId } });
  }

  private rOptions(signal?: AbortSignal) {
    const config = vscode.workspace.getConfiguration('rdataView');
    const source = vscode.Uri.file(this.options.protectedPaths?.at(-1) ?? this.uri.fsPath);
    const cwd = vscode.workspace.getWorkspaceFolder(source)?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? dirname(source.fsPath);
    return {
      cwd, executable: rExecutable(this.uri), script: join(this.root.fsPath, 'dist', 'read-table.R'),
      server: join(this.root.fsPath, 'dist', 'read-table-server.R'),
      timeout: config.get<number>('r.timeoutSeconds', 120) * 1000,
      idleTimeoutSeconds: config.get<number>('r.idleTimeoutSeconds', 300), signal,
    };
  }

  private prewarmR(dplyr = false): void {
    const options = this.rOptions();
    void warmR(options.executable, options.server, options.timeout, options.idleTimeoutSeconds, dplyr)
      .catch(() => undefined); // 真正读取时报告错误，预热不阻塞文件打开。
  }

  private load(selected?: string, filter = this.filter): Promise<void> {
    this.loading?.abort();
    this.querying?.abort();
    const controller = this.loading = new AbortController();
    const task = this.loadQueue.then(() => this.loadTable(controller, selected, filter));
    this.loadQueue = task.catch(() => undefined);
    return task;
  }

  private async loadTable(controller: AbortController, selected: string | undefined, filter: string): Promise<void> {
    let opened: PagedReader | undefined;
    try {
      controller.signal.throwIfAborted();
      if (this.disposed || !this.panel.visible) return;
      this.send({ type: 'LOADING', payload: { active: true, message: 'Opening table…' } });
      if (selected !== undefined) {
        const previous = this.reader;
        this.reader = undefined;
        await previous?.dispose();
        this.selected = selected;
      }
      const switching = filter !== this.filter;
      if (switching) await this.reader?.suspend();
      this.reader?.resume();
      const type = fileType(this.uri.fsPath);
      const totalBytes = (await stat(this.uri.fsPath)).size;
      const budget = vscode.workspace.getConfiguration('rdataView').get<number>('pagingThresholdMB', 64) * 1024 * 1024;
      if (!this.reader || switching) {
        const rOptions = {
          ...this.rOptions(controller.signal), selected: this.selected, filter,
          // 超大 CSV 不整体转换，改为按行 fread（阈值兼顾转换耗时与内存）。
          paged: type === 'csv' && (budget === 0 || totalBytes > Math.max(budget, PAGED_CSV_BYTES)),
        };
        if (type === 'arrow' && !filter) {
          try { opened = await ArrowFileReader.open(this.uri.fsPath); }
          catch (error) {
            if (!(error instanceof ArrowStreamError)) throw error;
            opened = await RReader.open(this.uri.fsPath, rOptions);
          }
        } else {
          opened = await RReader.open(this.uri.fsPath, rOptions);
        }
        controller.signal.throwIfAborted();
      }
      const reader = opened ?? this.reader!;
      this.paged = !!filter || budget === 0 || Math.max(totalBytes, reader instanceof RReader ? reader.bytes : 0,
        reader.totalRows * Math.max(reader.schema.length, 1) * 32) > budget || reader.totalRows > 100_000;
      let rows: CellValue[][] = [];
      let bytes = 0;
      for (let start = 0; !this.paged && start < reader.totalRows; start += CHUNK_SIZE) {
        controller.signal.throwIfAborted();
        const page = await reader.readRows(start, Math.min(start + CHUNK_SIZE, reader.totalRows));
        bytes += page.reduce((sum, row) => sum + JSON.stringify(row).length * 2 + row.length * 8, 0);
        if (bytes > budget) { this.paged = true; rows = []; break; }
        rows.push(...page);
      }
      controller.signal.throwIfAborted();
      const previous = this.reader;
      this.reader = reader;
      this.filter = filter;
      if (previous && previous !== reader) await previous.dispose();
      controller.signal.throwIfAborted();
      const choices = reader instanceof RReader ? reader.choices : [];
      this.selected = reader instanceof RReader ? reader.selected : '';
      // 对象名在表格左上角显示并可切换，标签页标题只留文件名，路径由面包屑给出。
      this.panel.title = this.options.title ?? basename(this.uri.fsPath);
      this.send({ type: 'INIT', payload: {
        fileType: type, fileName: basename(this.uri.fsPath), totalRows: reader.totalRows, totalBytes,
        schema: reader.schema, rows, paged: this.paged, choices, selected: this.selected, dplyrFilter: this.filter,
        spatial: reader instanceof RReader ? reader.spatial : undefined,
      } });
    } catch (error) {
      if (opened) {
        if (this.reader === opened) this.reader = undefined;
        await opened.dispose();
      }
      if (!controller.signal.aborted) throw error;
    } finally {
      if (this.loading === controller) this.loading = undefined;
    }
  }

  private async executeQuery(code: string): Promise<void> {
    if (this.querying) return;
    const controller = this.querying = new AbortController();
    let result: RQueryResult | undefined;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('R commands require a trusted workspace');
      if (!this.reader || !this.panel.visible || this.loading) throw new Error('Wait for the table to load');
      if (typeof code !== 'string' || !code.trim() || code.length > 1_000_000) throw new Error('Enter R code (maximum 1 MB)');
      if (!this.options.openQuery) throw new Error('Query tabs are unavailable');
      this.prewarmR(true);
      await this.reader.readRows(0, 0);
      controller.signal.throwIfAborted();
      result = this.reader instanceof RReader
        ? await this.reader.query(code, controller.signal)
        : await runRQuery(this.uri.fsPath, { ...this.rOptions(controller.signal), selected: this.selected }, code);
      controller.signal.throwIfAborted();
      this.options.openQuery(result, `Query — ${basename(this.uri.fsPath)}`,
        [this.uri.fsPath, ...(this.options.protectedPaths ?? [])]);
      result = undefined; // 新标签页拥有临时文件，关闭后清理。
      this.send({ type: 'QUERY_DONE', payload: {} });
    } catch (error) {
      await result?.dispose();
      this.send({ type: 'QUERY_DONE', payload: {
        error: controller.signal.aborted ? 'R query cancelled' : error instanceof Error ? error.message : String(error),
      } });
    } finally { if (this.querying === controller) this.querying = undefined; }
  }

  private async receive(message: WebviewMessage): Promise<void> {
    if (!message || this.disposed) return;
    if (message.type === 'READY') {
      this.ready = true;
      if (this.panel.visible) await this.load();
    } else if (message.type === 'SELECT_TABLE') {
      if (!(this.reader instanceof RReader) || !this.reader.choices.includes(message.payload.name)) throw new Error('Unknown table');
      this.exporting?.abort();
      await this.load(message.payload.name);
    } else if (message.type === 'PREPARE_R') {
      if (vscode.workspace.isTrusted) this.prewarmR(true);
    } else if (message.type === 'QUERY_CANCEL') {
      this.querying?.abort();
    } else if (message.type === 'EXECUTE_R_QUERY') {
      await this.executeQuery(message.payload.code);
    } else if (message.type === 'APPLY_DPLYR_FILTER') {
      if (fileType(this.uri.fsPath) !== 'arrow' || typeof message.payload.expression !== 'string') {
        throw new Error('dplyr filters are available only for Arrow / Feather files');
      }
      const expression = message.payload.expression.trim();
      if (expression && !vscode.workspace.isTrusted) throw new Error('dplyr filters require a trusted workspace');
      if (expression.length > 100_000) throw new Error('Filter expression is too long');
      this.exporting?.abort();
      if (expression) this.prewarmR(true);
      await this.load(undefined, expression);
    } else if (message.type === 'REQUEST_CHUNK') {
      const { requestId, startRow, endRow } = message.payload;
      // 切换对象、隐藏或加载中的请求一律丢弃：过渡期读到的是上一张表的行号，报错只会打扰用户。
      if (!this.reader || !this.panel.visible || this.loading) return;
      if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || startRow < 0 || endRow < startRow || endRow - startRow > 100_000) {
        throw new Error('Invalid page range');
      }
      const reader = this.reader;
      const rows = await reader.readRows(startRow, endRow);
      if (this.reader !== reader || this.loading || !this.panel.visible) return;
      this.send({ type: 'CHUNK', payload: { requestId, rows } });
    } else if (message.type === 'EXPORT') {
      if (this.exporting || !this.reader || !this.panel.visible) return;
      const reader = this.reader;
      const controller = this.exporting = new AbortController();
      try {
        const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Export CSV' });
        if (!target) { this.send({ type: 'EXPORT_DONE', payload: {} }); return; }
        if (target.scheme !== 'file') throw new Error('Export requires a local file');
        controller.signal.throwIfAborted();
        const protectedPaths = [...(this.options.protectedPaths ?? [])];
        if (fileType(this.uri.fsPath) === 'shp') {
          const dir = dirname(this.uri.fsPath);
          const stem = basename(this.uri.fsPath, extname(this.uri.fsPath)).toLowerCase();
          const siblings = await readdir(dir);
          protectedPaths.push(...siblings.filter(name => basename(name, extname(name)).toLowerCase() === stem &&
            ['.shx', '.dbf', '.prj', '.cpg', '.qix', '.sbn', '.sbx'].includes(extname(name).toLowerCase()))
            .map(name => join(dir, name)));
        }
        await exportCsv(reader, this.uri.fsPath, target.fsPath, controller.signal,
          pct => this.send({ type: 'EXPORT_PROGRESS', payload: { pct } }),
          this.paged ? undefined : message.payload.order, protectedPaths,
          reader instanceof RReader ? reader.spatial?.geometry : undefined);
        this.send({ type: 'EXPORT_DONE', payload: { path: target.fsPath } });
      } catch (error) {
        this.send({ type: 'EXPORT_DONE', payload: { error: controller.signal.aborted ? 'Export cancelled' : String(error) } });
      } finally { if (this.exporting === controller) this.exporting = undefined; }
    } else if (message.type === 'EXPORT_CANCEL') {
      this.exporting?.abort();
    } else if (message.type === 'OPEN_EXTERNAL' && /^https?:\/\//i.test(message.payload.url)) {
      await vscode.env.openExternal(vscode.Uri.parse(message.payload.url));
    }
  }
}
