import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../src/shared/messages.js';
import type { PagedReader } from '../src/extension/reader/Paged.js';

const { settings } = vi.hoisted(() => ({ settings: { threshold: 64, idleTimeoutSeconds: 60 } }));
vi.mock('vscode', async () => {
  const { join } = await import('node:path');
  return {
    Uri: { joinPath: (root: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(root.fsPath, ...parts), toString() { return this.fsPath; } }) },
    workspace: {
      getConfiguration: () => ({ get: (name: string, fallback: unknown) => {
        if (name === 'pagingThresholdMB') return settings.threshold;
        if (name === 'r.idleTimeoutSeconds') return settings.idleTimeoutSeconds;
        return fallback;
      } }),
      getWorkspaceFolder: () => undefined,
    },
    window: { showSaveDialog: vi.fn().mockResolvedValue(undefined) },
  };
});
import { TableView } from '../src/extension/TableView.js';
import { ArrowFileReader } from '../src/extension/reader/Arrow.js';
import { RReader } from '../src/extension/reader/R.js';

const uri = (fsPath: string) => ({ fsPath, scheme: 'file' }) as vscode.Uri;
let dir: string;
let view: TableView;
let messages: HostMessage[];
let visible: boolean;
let changeVisibility: () => void;
let receive: (message: WebviewMessage) => void;

function open(path: string): TableView {
  visible = true;
  const panel = {
    get visible() { return visible; },
    webview: {
      options: {}, html: '', cspSource: 'test',
      asWebviewUri: (value: vscode.Uri) => value,
      postMessage: (message: HostMessage) => { messages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; },
    },
    onDidChangeViewState: (handler: () => void) => { changeVisibility = handler; },
  } as unknown as vscode.WebviewPanel;
  return view = new TableView(uri(path), panel, uri(resolve('.')));
}
const init = () => messages.filter(message => message.type === 'INIT').at(-1)!;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rdata-view-test-'));
  messages = [];
  settings.threshold = 64;
  settings.idleTimeoutSeconds = 60;
});
afterEach(async () => {
  const reader = view?.['reader'];
  view?.dispose();
  await view?.['loadQueue'];
  await reader?.dispose();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('single read-only table provider', () => {
  it('passes the configured R idle timeout in seconds', async () => {
    settings.idleTimeoutSeconds = 180;
    const path = join(dir, 'table.rds');
    await writeFile(path, 'mock');
    const reader = {
      totalRows: 0, schema: [], readRows: async () => [],
      resume() {}, suspend: async () => {}, dispose: async () => {},
    } satisfies PagedReader;
    const opening = vi.spyOn(RReader, 'open').mockResolvedValue(reader as unknown as RReader);
    open(path);
    await view['receive']({ type: 'READY' });
    expect(opening).toHaveBeenCalledWith(path, expect.objectContaining({ idleTimeoutSeconds: 180 }));
  });

  it('loads small tables completely and reloads rows after hide/reveal', async () => {
    const path = join(dir, 'table.csv');
    await writeFile(path, 'id,name\n1,a\n2,b\n');
    open(path);
    await view['receive']({ type: 'READY' });
    expect(init().payload).toMatchObject({ fileType: 'csv', paged: false, totalRows: 2, rows: [[1, 'a'], [2, 'b']] });
    visible = false;
    changeVisibility();
    expect(messages.at(-1)).toEqual({ type: 'DATA_VISIBILITY', payload: { visible: false } });
    visible = true;
    changeVisibility();
    await view['loadQueue'];
    expect(init().payload.rows).toEqual([[1, 'a'], [2, 'b']]);
    const reader = view['reader']!;
    view.dispose();
    await reader.dispose();
    expect(view['reader']).toBeUndefined();
  });

  it('promotes highly compressed small files to paging when decoded rows exceed the budget', async () => {
    settings.threshold = 1;
    const path = join(dir, 'compressed.rds');
    await writeFile(path, 'tiny compressed source');
    open(path);
    view['reader'] = {
      totalRows: 1, schema: [{ name: 'text', index: 0, inferredType: 'string', nullable: false }],
      readRows: async () => [['x'.repeat(600_000)]],
      resume() {}, suspend: async () => {}, dispose: async () => {},
    } satisfies PagedReader;
    await view['receive']({ type: 'READY' });
    expect(init().payload).toMatchObject({ paged: true, rows: [] });
  });

  it('pages Arrow without a full dataset message, rejects invalid requests and releases batches', async () => {
    settings.threshold = 0;
    open(resolve('tests/fixtures/lz4.feather'));
    await view['receive']({ type: 'READY' });
    expect(init().payload).toMatchObject({ paged: true, rows: [], totalRows: 1024 });
    await view['receive']({ type: 'REQUEST_CHUNK', payload: { requestId: 'first', startRow: 0, endRow: 2 } });
    expect(messages.at(-1)).toMatchObject({ type: 'CHUNK', payload: { requestId: 'first', rows: expect.any(Array) } });
    const reader = view['reader'] as ArrowFileReader;
    expect(reader['cache'].size).toBe(1);
    receive({ type: 'REQUEST_CHUNK', payload: { requestId: 'bad', startRow: -1, endRow: 1 } });
    await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ type: 'ERROR', payload: { requestId: 'bad' } }));
    visible = false;
    changeVisibility();
    await reader['queue'];
    expect(reader['cache'].size).toBe(0);
    expect(reader['handle']).toBeNull();
    visible = true;
    changeVisibility();
    await view['loadQueue'];
    await view['receive']({ type: 'REQUEST_CHUNK', payload: { requestId: 'last', startRow: 1023, endRow: 1024 } });
    expect(messages.at(-1)).toMatchObject({ type: 'CHUNK', payload: { requestId: 'last', rows: [expect.any(Array)] } });
  });

  it('serializes rapid hide/reveal while opening, disposes the aborted reader and publishes only the latest INIT', async () => {
    const first = await ArrowFileReader.open(resolve('tests/fixtures/lz4.feather'));
    let finish!: (reader: ArrowFileReader) => void;
    vi.spyOn(ArrowFileReader, 'open').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    open(resolve('tests/fixtures/lz4.feather'));
    const opening = view['receive']({ type: 'READY' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    visible = false;
    changeVisibility();
    visible = true;
    changeVisibility();
    finish(first);
    await opening;
    await view['loadQueue'];
    expect(first['handle']).toBeNull();
    expect(messages.filter(message => message.type === 'INIT')).toHaveLength(1);
    expect(view['reader']).not.toBe(first);
  });

  it.skipIf(!process.env.RDATA_TEST_ARROW)('pages a production Arrow file without changing it', async () => {
    const path = process.env.RDATA_TEST_ARROW!;
    const before = await stat(path);
    open(path);
    await view['receive']({ type: 'READY' });
    const payload = init().payload;
    expect(payload.paged).toBe(true);
    expect(payload.rows).toEqual([]);
    expect(payload.totalRows).toBeGreaterThan(100_000);
    const reader = view['reader'] as ArrowFileReader;
    const first = await reader.readRows(0, 2);
    const last = await reader.readRows(payload.totalRows - 1, payload.totalRows);
    expect(first).toHaveLength(2);
    expect(last).toHaveLength(1);
    expect(reader['cache'].size).toBeLessThanOrEqual(2);
    visible = false;
    changeVisibility();
    await reader['queue'];
    expect(reader['handle']).toBeNull();
    visible = true;
    changeVisibility();
    await view['loadQueue'];
    expect(await reader.readRows(0, 2)).toEqual(first);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('ignores chunk requests that arrive while the panel is hidden', async () => {
    settings.threshold = 0;
    open(resolve('tests/fixtures/lz4.feather'));
    await view['receive']({ type: 'READY' });
    visible = false;
    changeVisibility();
    const before = messages.length;
    await view['receive']({ type: 'REQUEST_CHUNK', payload: { requestId: 'stale', startRow: 0, endRow: 2 } });
    expect(messages.slice(before).some(message => message.type === 'CHUNK' || message.type === 'ERROR')).toBe(false);
  });

  it.skipIf(!process.env.RDATA_TEST_R)('switches between tabular objects saved in one RDA', async () => {
    const r = process.env.RDATA_TEST_R!;
    const path = join(dir, 'objects.rda');
    execFileSync(r, ['--vanilla', '--slave', '-e',
      `t <- data.frame(id = 1:3, g = c('a','b','c')); m <- matrix(1:6, nrow = 3); save(t, m, file = '${path}')`]);
    open(path);
    const inits = () => messages.filter(message => message.type === 'INIT');
    await view['receive']({ type: 'READY' });
    await vi.waitFor(() => expect(inits()).toHaveLength(1), { timeout: 60_000 });
    expect(inits()[0].payload).toMatchObject({ choices: ['t', 'm'], selected: 't' });
    receive({ type: 'SELECT_TABLE', payload: { name: 'm' } });
    await vi.waitFor(() => expect(inits()).toHaveLength(2), { timeout: 60_000 });
    expect(inits()[1].payload).toMatchObject({ selected: 'm', choices: ['t', 'm'] });
    expect(inits()[1].payload.schema[0].name).toBe('V1');
  });

  it('finishes a cancelled export dialog without leaving UI progress active', async () => {
    open(resolve('tests/fixtures/lz4.feather'));
    await view['receive']({ type: 'READY' });
    await view['receive']({ type: 'EXPORT', payload: {} });
    expect(messages.at(-1)).toEqual({ type: 'EXPORT_DONE', payload: {} });
  });
});
