import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ArrowFileReader, ArrowStreamError } from './reader/ArrowFileReader.js';
import { RReader } from './reader/RReader.js';
import { exportCsv } from './exportCsv.js';
import type { PagedReader } from './paging/PagedReader.js';
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
  if (['csv', 'arrow', 'rda', 'rds', 'fst', 'qs2', 'qdata'].includes(ext)) return ext as FileType;
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

/** One panel owns one reader and one cancellable load; no document patch/save machinery. */
export class TableView implements vscode.Disposable {
  private reader?: PagedReader;
  private loading?: AbortController;
  private exporting?: AbortController;
  private selected = '';
  private ready = false;
  private disposed = false;
  private paged = true;
  private loadQueue: Promise<void> = Promise.resolve();

  constructor(private uri: vscode.Uri, private panel: vscode.WebviewPanel, private root: vscode.Uri) {
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
    void this.reader?.dispose().catch(() => undefined);
    this.reader = undefined;
  }

  private send(message: HostMessage): void { if (!this.disposed) void this.panel.webview.postMessage(message); }
  private fail(error: unknown, requestId?: string): void {
    this.send({ type: 'ERROR', payload: { message: error instanceof Error ? error.message : String(error), requestId } });
  }

  private load(selected?: string): Promise<void> {
    this.loading?.abort();
    const controller = this.loading = new AbortController();
    const task = this.loadQueue.then(() => this.loadTable(controller, selected));
    this.loadQueue = task.catch(() => undefined);
    return task;
  }

  private async loadTable(controller: AbortController, selected?: string): Promise<void> {
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
      this.reader?.resume();
      const type = fileType(this.uri.fsPath);
      const totalBytes = (await stat(this.uri.fsPath)).size;
      const budget = vscode.workspace.getConfiguration('rdataView').get<number>('pagingThresholdMB', 64) * 1024 * 1024;
      if (!this.reader) {
        const config = vscode.workspace.getConfiguration('rdataView');
        const rOptions = {
          executable: rExecutable(this.uri), script: join(this.root.fsPath, 'dist', 'read-table.R'),
          server: join(this.root.fsPath, 'dist', 'read-table-server.R'),
          timeout: config.get<number>('r.timeoutSeconds', 120) * 1000,
          signal: controller.signal, selected: this.selected,
          // 超大 CSV 不整体转换，改为按行 fread（阈值兼顾转换耗时与内存）。
          paged: type === 'csv' && (budget === 0 || totalBytes > Math.max(budget, PAGED_CSV_BYTES)),
        };
        if (type === 'arrow') {
          try { opened = await ArrowFileReader.open(this.uri.fsPath); }
          catch (error) {
            if (!(error instanceof ArrowStreamError)) throw error;
            opened = await RReader.open(this.uri.fsPath, rOptions);
          }
        } else {
          opened = await RReader.open(this.uri.fsPath, rOptions);
        }
        controller.signal.throwIfAborted();
        this.reader = opened;
      }
      const reader = this.reader;
      this.paged = budget === 0 || Math.max(totalBytes, reader instanceof RReader ? reader.bytes : 0,
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
      const choices = reader instanceof RReader ? reader.choices : [];
      this.selected = reader instanceof RReader ? reader.selected : '';
      this.send({ type: 'INIT', payload: {
        fileType: type, fileName: basename(this.uri.fsPath), totalRows: reader.totalRows, totalBytes,
        schema: reader.schema, rows, paged: this.paged, notice: reader.notice, choices, selected: this.selected,
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

  private async receive(message: WebviewMessage): Promise<void> {
    if (!message || this.disposed) return;
    if (message.type === 'READY') {
      this.ready = true;
      if (this.panel.visible) await this.load();
    } else if (message.type === 'SELECT_TABLE') {
      if (!(this.reader instanceof RReader) || !this.reader.choices.includes(message.payload.name)) throw new Error('Unknown table');
      this.exporting?.abort();
      await this.load(message.payload.name);
    } else if (message.type === 'REQUEST_CHUNK') {
      const { requestId, startRow, endRow } = message.payload;
      if (!this.reader || !this.panel.visible) throw new Error('Table is not visible');
      if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || startRow < 0 || endRow < startRow || endRow - startRow > 100_000) {
        throw new Error('Invalid page range');
      }
      const rows = await this.reader.readRows(startRow, endRow);
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
        await exportCsv(reader, this.uri.fsPath, target.fsPath, controller.signal,
          pct => this.send({ type: 'EXPORT_PROGRESS', payload: { pct } }),
          this.paged ? undefined : message.payload.order);
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
