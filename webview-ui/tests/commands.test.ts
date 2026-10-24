import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { HostMessage } from '@shared/messages.js';

vi.mock('../src/bridge/vscode.js', () => ({ postMessage: vi.fn() }));
vi.mock('../src/bridge/readHostRows.js', () => ({
  readHostRows: vi.fn().mockResolvedValue([[1]]), cancelPages: vi.fn(), receivePage: vi.fn(),
}));
import Toolbar from '../src/components/Toolbar.svelte';
import RCommand from '../src/components/RCommand.svelte';
import { gridStore } from '../src/stores/grid.svelte.js';
import { uiStore } from '../src/stores/ui.svelte.js';
import { setupMessageHandler } from '../src/bridge/messageHandler.js';

let receive: (event: { data: HostMessage }) => void;
let cleanup: () => void;
beforeEach(() => {
  gridStore.init({
    fileType: 'arrow', fileName: 'test.arrow', totalRows: 1, totalBytes: 100,
    schema: [{ name: 'id', index: 0, inferredType: 'number', nullable: false }],
    rows: [[1]], paged: false, choices: [], selected: '',
  });
  uiStore.error = null;
  uiStore.queryRunning = false;
  vi.stubGlobal('window', {
    addEventListener: (_: string, handler: typeof receive) => { receive = handler; },
    removeEventListener: vi.fn(),
  });
  cleanup = setupMessageHandler();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('R controls', () => {
  it('offers a dplyr filter in paged Arrow mode and shows the active backend', () => {
    gridStore.paged = true;
    let html = render(Toolbar).body;
    expect(html).toContain('aria-label="dplyr filter"');
    expect(html).toContain('TypeScript Arrow backend');
    expect(html.match(/<input[^>]*aria-label="dplyr filter"[^>]*>/)?.[0]).not.toContain('disabled');
    gridStore.dplyrFilter = 'id > 0';
    html = render(Toolbar).body;
    expect(html).toContain('R / dplyr');
    expect(html).toContain('Export all dplyr-filtered rows');
    gridStore.fileType = 'rds';
    expect(render(Toolbar).body).not.toContain('aria-label="dplyr filter"');
  });

  it('renders only the code box and execution controls without explanatory messages', () => {
    let html = render(RCommand).body;
    expect(html).toContain('aria-label="R command"');
    expect(html).toContain('执行 R');
    expect(html).not.toContain('返回表格');
    expect(html).not.toContain('执行本地 R 代码；可能整表载入内存');
    expect(html).toContain('collect()');
    expect(html).not.toContain('data.table::as.data.table()');
    expect(html).not.toContain('取消');
    uiStore.queryRunning = true;
    html = render(RCommand).body;
    expect(html).toContain('取消');
    expect(html.match(/<textarea[^>]*>/)?.[0]).toContain('disabled');
  });

  it('restores the original view after filter errors and finishes commands without replacing it', () => {
    gridStore.applyDplyrFilter('id >');
    receive({ data: { type: 'ERROR', payload: { message: 'Invalid filter' } } });
    expect(uiStore.loading).toBe(false);
    expect(uiStore.error).toBe('Invalid filter');
    expect(gridStore.getCell(0, 0)).toBe(1);
    uiStore.queryRunning = true;
    receive({ data: { type: 'QUERY_DONE', payload: { error: 'Expected a data.frame, data.table, tibble or matrix' } } });
    expect(uiStore.queryRunning).toBe(false);
    expect(uiStore.error).toBe('Expected a data.frame, data.table, tibble or matrix');
    expect(gridStore.getCell(0, 0)).toBe(1);
    uiStore.queryRunning = true;
    receive({ data: { type: 'QUERY_DONE', payload: {} } });
    expect(uiStore.queryRunning).toBe(false);
  });
});
