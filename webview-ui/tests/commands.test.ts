import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { HostMessage } from '@shared/messages.js';

vi.mock('../src/bridge/vscode.js', () => ({ postMessage: vi.fn() }));
vi.mock('../src/bridge/readHostRows.js', () => ({
  readHostRows: vi.fn().mockResolvedValue([[1]]), cancelPages: vi.fn(), receivePage: vi.fn(),
}));
import Toolbar from '../src/components/Toolbar.svelte';
import RCommand, { autosizeCommand, handleCommandKey } from '../src/components/RCommand.svelte';
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
    expect(html.match(/<textarea[^>]*>/)?.[0]).toContain('rows="1"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter Meta+Shift+M Tab"');
    expect(html).toContain('Cmd+Enter / Ctrl+Enter');
    expect(html).toContain('执行 R');
    expect(html).not.toContain('返回表格');
    expect(html).not.toContain('执行本地 R 代码；可能整表载入内存');
    expect(html).toContain('head(10)');
    expect(html).not.toContain('collect()');
    expect(html).not.toContain('data.table::as.data.table()');
    expect(html).not.toContain('取消');
    uiStore.queryRunning = true;
    html = render(RCommand).body;
    expect(html).toContain('取消');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/<textarea[^>]*>/)?.[0]).toContain('disabled');
  });

  it('resizes the command editor with its content and removes the listener on unmount', () => {
    const input = {
      style: { height: '' }, scrollHeight: 28,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const action = autosizeCommand(input as unknown as HTMLTextAreaElement);
    expect(input.style.height).toBe('28px');
    const resize = input.addEventListener.mock.calls[0][1];
    input.scrollHeight = 88;
    resize();
    expect(input.style.height).toBe('88px');
    input.scrollHeight = 28;
    resize();
    expect(input.style.height).toBe('28px');
    action.destroy();
    expect(input.removeEventListener).toHaveBeenCalledWith('input', resize);
  });

  it.each([
    ['Enter', true, false, false, true],
    ['Enter', false, true, false, true],
    ['Enter', false, false, false, false],
    ['a', true, false, false, false],
    ['Enter', true, false, true, false],
  ])('submits only modified Enter outside IME composition (%s, %s, %s, %s)',
    (key, metaKey, ctrlKey, isComposing, submits) => {
      const preventDefault = vi.fn();
      const requestSubmit = vi.fn();
      handleCommandKey({ key, metaKey, ctrlKey, isComposing, preventDefault, stopPropagation: vi.fn(),
        currentTarget: { form: { requestSubmit } },
      } as unknown as KeyboardEvent & { currentTarget: HTMLTextAreaElement });
      expect(requestSubmit).toHaveBeenCalledTimes(submits ? 1 : 0);
      expect(preventDefault).toHaveBeenCalledTimes(submits ? 1 : 0);
    });

  it.each([
    ['m', true, true, '%>% '],
    ['M', true, true, '%>% '],
    ['Tab', false, false, '  '],
  ])('inserts %s shortcuts at the caret or over selected text', (key, metaKey, shiftKey, text) => {
    for (const [start, end] of [[2, 2], [0, 2]]) {
      const input = { selectionStart: start, selectionEnd: end, setRangeText: vi.fn(), dispatchEvent: vi.fn() };
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      handleCommandKey({ key, metaKey, shiftKey, preventDefault, stopPropagation, currentTarget: input,
      } as unknown as KeyboardEvent & { currentTarget: HTMLTextAreaElement });
      expect(input.setRangeText).toHaveBeenCalledWith(text, start, end, 'end');
      expect(input.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input', bubbles: true }));
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { key: 'Tab', shiftKey: true },
    { key: 'Tab', ctrlKey: true },
    { key: 'Tab', metaKey: true },
    { key: 'Tab', altKey: true },
    { key: 'm', metaKey: true },
    { key: 'm', metaKey: true, shiftKey: true, isComposing: true },
    { key: 'Tab', isComposing: true },
  ])('leaves other editing keys and IME composition unchanged (%j)', keys => {
    const preventDefault = vi.fn();
    handleCommandKey({ ...keys, preventDefault } as unknown as KeyboardEvent & { currentTarget: HTMLTextAreaElement });
    expect(preventDefault).not.toHaveBeenCalled();
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
