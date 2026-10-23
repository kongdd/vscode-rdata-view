import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitPayload } from '@shared/messages.js';

const { read, post } = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn() }));
vi.mock('../src/bridge/readHostRows.js', () => ({ readHostRows: read, cancelPages: vi.fn() }));
vi.mock('../src/bridge/vscode.js', () => ({ postMessage: post }));
import { gridStore } from '../src/stores/grid.svelte.js';

const payload = (paged = false): InitPayload => ({
  fileType: 'rds', fileName: 'test.rds', totalRows: 3, totalBytes: 100,
  schema: [{ name: 'id', index: 0, inferredType: 'number', nullable: false }],
  rows: paged ? [] : [[3], [1], [2]], paged, choices: [], selected: '',
});
beforeEach(() => {
  gridStore.setDataVisible(false);
  read.mockReset().mockResolvedValue([[3], [1], [2]]);
  post.mockReset();
  gridStore.init({ ...payload(), fileName: crypto.randomUUID() });
});

describe('small tables share one data path', () => {
  it('sorts, filters, searches and treats zero matches as an empty view, not identity', () => {
    gridStore.setSort({ colIndex: 0, direction: 'asc' });
    expect(gridStore.getCell(0, 0)).toBe(1);
    gridStore.setFilter({ colIndex: 0, op: 'gt', value: 1 });
    expect(gridStore.filteredRows).toBe(2);
    expect(gridStore.getCell(0, 0)).toBe(2);
    gridStore.setGlobalSearch('missing');
    expect(gridStore.filteredRows).toBe(0);
    expect(gridStore.getCell(0, 0)).toBeNull();
  });

  it('exports the filtered/sorted row order, without modifying the source', () => {
    gridStore.setSort({ colIndex: 0, direction: 'asc' });
    gridStore.setFilter({ colIndex: 0, op: 'gt', value: 1 });
    gridStore.exportCsv();
    expect(post).toHaveBeenCalledWith({ type: 'EXPORT', payload: { order: [2, 0] } });
    expect(gridStore.computeColumnStats(0)?.numeric?.mean).toBe(2);
  });

  it('preserves view settings on hide/reveal and resets them for another object', () => {
    gridStore.init(payload());
    gridStore.setFilter({ colIndex: 0, op: 'gt', value: 1 });
    gridStore.toggleFreezeCol(0);
    gridStore.toggleFreezeRow(1);
    gridStore.setDataVisible(false);
    expect(gridStore.getAllRowsInMemory()).toEqual([]);
    gridStore.init(payload());
    expect(gridStore.filteredRows).toBe(2);
    expect(gridStore.frozenCols.has(0)).toBe(true);
    expect(gridStore.frozenRow).toBe(1);
    gridStore.init({ ...payload(), selected: 'other' });
    expect(gridStore.filters).toEqual([]);
    expect(gridStore.frozenCols.size).toBe(0);
  });
});

describe('row navigation', () => {
  it('uses 1-based row numbers and replaces the previous selection', () => {
    gridStore.selectCell(0, 0);
    gridStore.selectCol(0);
    expect(gridStore.goToRow(3)).toBe(true);
    expect(gridStore.selectedRow).toBe(2);
    expect(gridStore.selectedCell).toBeNull();
    expect(gridStore.selectedCol).toBeNull();
    expect(gridStore.rowJump).toEqual({ row: 2 });
    const previous = gridStore.rowJump;
    gridStore.goToRow(3);
    expect(gridStore.rowJump).not.toBe(previous);
  });

  it.each([0, -1, 4, 1.5, NaN, Infinity])('rejects invalid row %s without changing selection', row => {
    gridStore.goToRow(2);
    expect(gridStore.goToRow(row)).toBe(false);
    expect(gridStore.selectedRow).toBe(1);
  });

  it('navigates the current view and clears the jump when the view changes', () => {
    gridStore.setSort({ colIndex: 0, direction: 'asc' });
    gridStore.goToRow(2);
    expect(gridStore.getCell(gridStore.selectedRow!, 0)).toBe(2);
    gridStore.setGlobalSearch('missing');
    expect(gridStore.rowJump).toBeNull();
    expect(gridStore.goToRow(1)).toBe(false);
  });

  it('supports distant rows without scanning a paged table', () => {
    gridStore.init({ ...payload(true), totalRows: 5_000_000 });
    read.mockClear();
    expect(gridStore.goToRow(4_000_000)).toBe(true);
    expect(gridStore.rowJump).toEqual({ row: 3_999_999 });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('paged tables', () => {
  it('deduplicates pages and does not scan/filter the whole table', async () => {
    gridStore.init(payload(true));
    gridStore.getCell(0, 0);
    gridStore.getCell(1, 0);
    await vi.waitFor(() => expect(gridStore.getCell(1, 0)).toBe(1));
    expect(read).toHaveBeenCalledTimes(1);
    gridStore.setGlobalSearch('1');
    gridStore.setSort({ colIndex: 0, direction: 'asc' });
    expect(gridStore.globalSearch).toBe('');
    expect(gridStore.sort).toBeNull();
    expect(gridStore.computeDatasetStats()).toBeNull();
    gridStore.setDataVisible(false);
    expect(gridStore['cache'].size).toBe(0);
  });

  it('ignores stale pages from an earlier table', async () => {
    let finish!: (rows: number[][]) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    gridStore.init(payload(true));
    gridStore.init({ ...payload(), fileName: 'new.rds' });
    finish([[999]]);
    await Promise.resolve();
    expect(gridStore.getCell(0, 0)).toBe(3);
    expect(gridStore['cache'].size).toBe(0);
  });

  it('routes object/worksheet switching to the host', () => {
    gridStore.selectSheet('对象');
    expect(post).toHaveBeenCalledWith({ type: 'SELECT_TABLE', payload: { name: '对象' } });
  });
});
