import type { CellValue, ColumnSchema, FilterSpec, SortSpec } from '@shared/schema.js';
import type { InitPayload } from '@shared/messages.js';
import { CHUNK_SIZE } from '@shared/constants.js';
import { buildViewIndex, hasViewTransform } from './csvView.js';
import { readHostRows, cancelPages } from '../bridge/readHostRows.js';
import { postMessage } from '../bridge/vscode.js';
import { uiStore } from './ui.svelte.js';

export interface ColumnReport {
  colIndex: number;
  name: string;
  type: string;
  total: number;
  nulls: number;
  distinct: number;
  top: { value: string; count: number }[];
  numeric?: {
    min: number;
    max: number;
    mean: number;
    median: number;
    stddev: number;
    sum: number;
    histogram: { from: number; to: number; count: number }[];
  };
}

export interface DatasetReport {
  totalRows: number;
  totalCols: number;
  totalCells: number;
  nullCells: number;
  nullPct: number;
  typeCounts: Record<string, number>;
  columns: {
    index: number;
    name: string;
    type: string;
    nulls: number;
    nullPct: number;
    distinct: number;
    mean?: number;
    min?: number;
    max?: number;
  }[];
}


class GridStore {
  fileType = $state<InitPayload['fileType']>('csv');
  fileName = $state('');
  totalRows = $state(0);
  filteredRows = $state(0);
  totalBytes = $state(0);
  paged = $state(false);
  schema = $state<ColumnSchema[]>([]);
  hiddenCols = $state<Set<number>>(new Set());
  colWidths = $state<Map<string, number>>(new Map());
  colColors = $state<Map<number, string>>(new Map());
  columnOrder = $state<number[] | null>(null);
  frozenCols = $state<Set<number>>(new Set());
  frozenRow = $state<number | null>(null);
  filters = $state<FilterSpec[]>([]);
  sort = $state<SortSpec | null>(null);
  globalSearch = $state('');
  dplyrFilter = $state('');
  selectedCell = $state<{ row: number; col: number } | null>(null);
  selectedRange = $state<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  selectedRow = $state<number | null>(null);
  selectedCol = $state<number | null>(null);
  selectionAnchor = $state<{ row: number; col: number } | null>(null);
  rowJump = $state<{ row: number } | null>(null);
  availableSheets = $state<string[]>([]);
  selectedSheet = $state('');
  cacheVersion = $state(0);
  private rows: CellValue[][] = [];
  private view: number[] | null = null;
  private cache = new Map<number, { rows: CellValue[][]; bytes: number }>();
  private cacheBytes = 0;
  private pending = new Set<number>();
  private failed = new Set<number>();
  private autoWidths = $state<Map<string, number>>(new Map());
  private visible = true;
  private epoch = 0;
  private start = 0;
  private end = 50;

  init(payload: InitPayload): void {
    const sameTable = this.fileName === payload.fileName && this.selectedSheet === payload.selected &&
      this.dplyrFilter === (payload.dplyrFilter ?? '');
    this.resetData();
    Object.assign(this, {
      fileName: payload.fileName, fileType: payload.fileType, totalRows: payload.totalRows,
      totalBytes: payload.totalBytes, schema: payload.schema, paged: payload.paged,
      availableSheets: payload.choices, selectedSheet: payload.selected, dplyrFilter: payload.dplyrFilter ?? '',
    });
    if (!sameTable) {
      this.start = 0;
      this.end = 50;
      this.filters = [];
      this.sort = null;
      this.globalSearch = '';
      this.clearSelection();
      this.frozenRow = null;
      this.frozenCols = new Set();
      this.hiddenCols = new Set();
      this.colWidths = new Map();
      this.columnOrder = null;
      this.colColors = new Map();
      this.autoWidths = new Map();
    }
    if (this.paged) { this.filters = []; this.sort = null; this.globalSearch = ''; }
    this.visible = true;
    this.rows = payload.rows;
    if (payload.rows.length) this.fitColumns(payload.rows.slice(0, 200));
    this.rebuildView(!sameTable);
    uiStore.setLoading(false);
    this.updateViewport(this.start, this.end);
  }

  private resetData(): void {
    this.epoch++;
    cancelPages();
    this.rows = [];
    this.view = null;
    this.cache.clear();
    this.cacheBytes = 0;
    this.pending.clear();
    this.failed.clear();
    this.cacheVersion++;
  }

  setDataVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.resetData();
    else this.updateViewport(this.start, this.end);
  }

  selectSheet(name: string): void {
    if (name !== this.selectedSheet) {
      this.resetData();
      uiStore.setLoading(true, 'Opening table…');
      postMessage({ type: 'SELECT_TABLE', payload: { name } });
    }
  }

  applyDplyrFilter(expression: string): void {
    if (this.fileType !== 'arrow') return;
    // 保留旧视图，语法错误时可继续浏览；INIT 成功后再清空数据与视图设置。
    this.epoch++;
    cancelPages();
    this.pending.clear();
    this.failed.clear();
    uiStore.setLoading(true, expression.trim() ? 'Filtering with R / dplyr…' : 'Opening Arrow…');
    postMessage({ type: 'APPLY_DPLYR_FILTER', payload: { expression: expression.trim() } });
  }

  getCell(row: number, col: number): CellValue {
    void this.cacheVersion;
    if (row < 0 || row >= this.filteredRows) return null;
    if (!this.paged) return this.rows[this.view ? this.view[row] : row]?.[col] ?? null;
    const start = Math.floor(row / CHUNK_SIZE) * CHUNK_SIZE;
    const page = this.cache.get(start);
    if (!page) { this.requestPage(start); return null; }
    this.cache.delete(start);
    this.cache.set(start, page);
    return page.rows[row - start]?.[col] ?? null;
  }

  updateViewport(start: number, end: number): void {
    this.start = start;
    this.end = end;
    if (!this.paged || !this.visible) return;
    const first = Math.max(0, Math.floor(start / CHUNK_SIZE) - 1) * CHUNK_SIZE;
    const last = Math.min(this.totalRows, end + CHUNK_SIZE);
    for (let row = first; row < last; row += CHUNK_SIZE) this.requestPage(row);
  }

  private requestPage(start: number): void {
    // 加载中仍在渲染旧表，此时的行号属于上一张表，不发请求。
    if (!this.visible || uiStore.loading || start >= this.totalRows || this.cache.has(start) || this.pending.has(start) ||
        this.failed.has(start) || this.pending.size >= 4) return;
    const epoch = this.epoch;
    this.pending.add(start);
    void readHostRows(start, Math.min(start + CHUNK_SIZE, this.totalRows)).then(rows => {
      if (epoch !== this.epoch) return;
      const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row).length * 2 + row.length * 8, 0);
      this.cache.set(start, { rows, bytes });
      this.cacheBytes += bytes;
      while (this.cache.size > 1 && (this.cacheBytes > 32 * 1024 * 1024 || this.cache.size > 50)) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.bytes;
        this.cache.delete(oldest);
      }
      if (!this.autoWidths.size) this.fitColumns(rows);
      this.cacheVersion++;
    }).catch(error => {
      if (epoch === this.epoch) { this.failed.add(start); uiStore.setError(String(error)); }
    }).finally(() => {
      if (epoch === this.epoch) { this.pending.delete(start); this.updateViewport(this.start, this.end); }
    });
  }

  private rebuildView(clearFrozenRow = true): void {
    this.rowJump = null;
    this.view = !this.paged && hasViewTransform(this.filters, this.sort, this.globalSearch)
      ? buildViewIndex(this.rows, this.filters, this.sort, this.globalSearch) : null;
    this.filteredRows = this.view ? this.view.length : this.totalRows;
    if (clearFrozenRow) this.frozenRow = null;
    this.cacheVersion++;
  }

  setFilter(filter: FilterSpec): void {
    if (this.paged) return;
    this.filters = [...this.filters.filter(item => item.colIndex !== filter.colIndex), filter];
    this.rebuildView();
  }
  removeFilter(col: number): void { this.filters = this.filters.filter(item => item.colIndex !== col); this.rebuildView(); }
  clearFilters(): void { this.filters = []; this.rebuildView(); }
  setSort(sort: SortSpec | null): void { if (!this.paged) { this.sort = sort; this.rebuildView(); } }
  setGlobalSearch(search: string): void { if (!this.paged) { this.globalSearch = search; this.rebuildView(); } }

  exportCsv(): void {
    uiStore.exportProgress = 0;
    postMessage({ type: 'EXPORT', payload: { order: this.view ?? undefined } });
  }

  get visibleSchema(): ColumnSchema[] {
    return (this.columnOrder ?? this.schema.map(col => col.index))
      .map(index => this.schema[index]).filter(col => col && !this.hiddenCols.has(col.index));
  }

  toggleColumnVisibility(col: number): void {
    const hidden = new Set(this.hiddenCols);
    if (hidden.has(col)) hidden.delete(col); else hidden.add(col);
    this.hiddenCols = hidden;
  }

  setColumnWidth(name: string, width: number): void { this.colWidths = new Map(this.colWidths).set(name, width); }
  getAutoWidth(name: string): number | undefined { return this.autoWidths.get(name); }
  private fitColumns(rows: CellValue[][]): void {
    const widths = new Map<string, number>();
    for (const col of this.schema) {
      const length = Math.max(col.name.length + 2, ...rows.slice(0, 200).map(row => String(row[col.index] ?? '').length));
      widths.set(col.name, Math.max(60, Math.min(400, Math.ceil(length * 7.2) + 38)));
    }
    this.autoWidths = widths;
  }
  getColumnStringsForFit(col: number, limit = 5000): string[] {
    const rows = this.paged ? [...this.cache.values()].flatMap(page => page.rows) : this.rows;
    return rows.slice(0, limit).map(row => String(row[col] ?? ''));
  }
  toggleColColors(): void {
    const colors = ['rgba(100,149,237,.12)', 'rgba(144,238,144,.12)', 'rgba(255,182,193,.14)',
      'rgba(255,218,120,.13)', 'rgba(175,238,238,.14)', 'rgba(221,160,221,.14)'];
    this.colColors = this.colColors.size ? new Map() : new Map(this.schema.map(col => [col.index, colors[col.index % colors.length]]));
  }

  goToRow(rowNumber: number): boolean {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > this.filteredRows) return false;
    this.clearSelection();
    this.selectRow(rowNumber - 1);
    // A new object lets the same row be revealed again after scrolling away.
    this.rowJump = { row: rowNumber - 1 };
    return true;
  }

  selectCell(row: number, col: number): void {
    this.selectedCell = { row, col };
    this.selectedRow = null;
    this.selectedCol = null;
    this.selectedRange = null;
    this.selectionAnchor = { row, col };
  }

  // Row and column selections coexist so the user can see a "cross" at the intersection.
  // Selecting a row clears any previous single-cell selection or range.
  selectRow(row: number): void {
    this.selectedRow = row;
    this.selectedCell = null;
    this.selectedRange = null;
    this.selectionAnchor = null;
  }

  selectCol(col: number): void {
    this.selectedCol = col;
    this.selectedCell = null;
    this.selectedRange = null;
    this.selectionAnchor = null;
  }

  clearSelection(): void {
    this.selectedCell = null;
    this.selectedRow = null;
    this.selectedCol = null;
    this.selectedRange = null;
    this.selectionAnchor = null;
  }

  // Range selection: first click sets the anchor + selectedCell; a follow-up
  // shift-click (extendRange) builds the rectangle from anchor → target.
  extendRange(toRow: number, toCol: number): void {
    const anchor = this.selectionAnchor ?? this.selectedCell;
    if (!anchor) {
      // No anchor yet → behave like a single-cell click.
      this.selectCell(toRow, toCol);
      this.selectionAnchor = { row: toRow, col: toCol };
      return;
    }
    this.selectedCell = null;
    this.selectedRow = null;
    this.selectedCol = null;
    this.selectedRange = {
      r1: Math.min(anchor.row, toRow),
      c1: Math.min(anchor.col, toCol),
      r2: Math.max(anchor.row, toRow),
      c2: Math.max(anchor.col, toCol),
    };
  }


  async copySelectionToClipboard(): Promise<void> {
    const cell = this.selectedCell;
    const range = this.selectedRange;
    if (range) await this.copy(range.r1, range.r2 + 1, this.visibleSchema.filter(col => col.index >= range.c1 && col.index <= range.c2).map(col => col.index));
    else if (cell) await this.copy(cell.row, cell.row + 1, [cell.col]);
    else if (this.selectedRow !== null) await this.copyRowToClipboard(this.selectedRow);
    else if (this.selectedCol !== null) await this.copyColumnToClipboard(this.selectedCol);
  }
  async copyRowToClipboard(row: number): Promise<void> { await this.copy(row, row + 1, this.visibleSchema.map(col => col.index)); }
  async copyColumnToClipboard(col: number): Promise<void> { await this.copy(0, this.filteredRows, [col]); }

  private async copy(start: number, end: number, cols: number[]): Promise<void> {
    try {
      if (end - start > 10_000) throw new Error('Copy is limited to 10,000 rows. Use CSV export for the whole table.');
      const lines: string[] = [];
      for (let index = start; index < end; index += CHUNK_SIZE) {
        const stop = Math.min(index + CHUNK_SIZE, end);
        const rows = this.paged ? await readHostRows(index, stop) :
          Array.from({ length: stop - index }, (_, offset) => this.rows[this.view ? this.view[index + offset] : index + offset]);
        for (const row of rows) lines.push(cols.map(col => String(row[col] ?? '')).join('\t'));
      }
      await navigator.clipboard.writeText(lines.join('\n'));
    } catch (error) { uiStore.setError(String(error)); }
  }

  toggleFreezeCol(colIndex: number): void {
    const next = new Set(this.frozenCols);
    if (next.has(colIndex)) {
      next.delete(colIndex);
    } else {
      next.add(colIndex);
    }
    this.frozenCols = next;
  }

  unfreezeAllCols(): void {
    this.frozenCols = new Set();
  }

  // Pin a visible row to the top (or unpin if already frozen). Only one row can
  // be frozen at a time — freezing a different row replaces the previous one.
  toggleFreezeRow(row: number): void {
    this.frozenRow = this.frozenRow === row ? null : row;
  }

  clearFrozenRow(): void {
    this.frozenRow = null;
  }

  // ── Column reorder ────────────────────────────────────────────────────────

  reorderColumn(fromVisualPos: number, toVisualPos: number): void {
    const order = this.columnOrder ?? this.schema.map(c => c.index);
    const newOrder = [...order];
    const [moved] = newOrder.splice(fromVisualPos, 1);
    newOrder.splice(toVisualPos, 0, moved);
    this.columnOrder = newOrder;
  }


  getAllRowsInMemory(): CellValue[][] | null { return this.paged ? null : this.rows; }
  computeColumnStats(colIndex: number): ColumnReport | null {
    const rows = this.getAllRowsInMemory();
    if (!rows) return null;
    const col = this.schema[colIndex];
    if (!col) return null;

    const total = rows.length;
    let nulls = 0;
    const numeric: number[] = [];
    const valueCounts = new Map<string, number>();

    for (const row of rows) {
      const v = row[colIndex];
      if (v === null || v === undefined || v === '') {
        nulls++;
        continue;
      }
      const key = String(v);
      valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
      const n = typeof v === 'number' ? v : Number(v);
      if (!isNaN(n) && isFinite(n)) numeric.push(n);
    }

    const distinct = valueCounts.size;
    const top = [...valueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));

    let numericStats: ColumnReport['numeric'] = undefined;
    if (numeric.length > 0 && col.inferredType === 'number') {
      numeric.sort((a, b) => a - b);
      const sum = numeric.reduce((s, n) => s + n, 0);
      const mean = sum / numeric.length;
      const median = numeric.length % 2 === 0
        ? (numeric[numeric.length / 2 - 1] + numeric[numeric.length / 2]) / 2
        : numeric[Math.floor(numeric.length / 2)];
      const variance = numeric.reduce((s, n) => s + (n - mean) ** 2, 0) / numeric.length;
      const stddev = Math.sqrt(variance);
      const min = numeric[0];
      const max = numeric[numeric.length - 1];

      // Histogram: 10 bins between min and max.
      const BINS = 10;
      const range = max - min || 1;
      const binSize = range / BINS;
      const histogram: { from: number; to: number; count: number }[] = [];
      for (let i = 0; i < BINS; i++) {
        histogram.push({ from: min + i * binSize, to: min + (i + 1) * binSize, count: 0 });
      }
      for (const n of numeric) {
        let bin = Math.floor((n - min) / binSize);
        if (bin >= BINS) bin = BINS - 1;
        if (bin < 0) bin = 0;
        histogram[bin].count++;
      }

      numericStats = { min, max, mean, median, stddev, sum, histogram };
    }

    return {
      colIndex,
      name: col.name,
      type: col.inferredType,
      total,
      nulls,
      distinct,
      top,
      numeric: numericStats,
    };
  }

  computeDatasetStats(): DatasetReport | null {
    const rows = this.getAllRowsInMemory();
    if (!rows) return null;

    const total = rows.length;
    const cols = this.schema.length;
    const totalCells = total * cols;
    let nullCells = 0;

    const perColumn = this.schema.map(col => {
      let nulls = 0;
      const seen = new Set<string>();
      let numericCount = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const row of rows) {
        const v = row[col.index];
        if (v === null || v === undefined || v === '') {
          nulls++;
          continue;
        }
        seen.add(String(v));
        const n = typeof v === 'number' ? v : Number(v);
        if (!isNaN(n) && isFinite(n)) {
          numericCount++;
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
      nullCells += nulls;
      const isNumeric = col.inferredType === 'number' && numericCount > 0;
      return {
        index: col.index,
        name: col.name,
        type: col.inferredType,
        nulls,
        nullPct: total === 0 ? 0 : (nulls / total) * 100,
        distinct: seen.size,
        mean: isNumeric ? sum / numericCount : undefined,
        min: isNumeric ? min : undefined,
        max: isNumeric ? max : undefined,
      };
    });

    return {
      totalRows: total,
      totalCols: cols,
      totalCells,
      nullCells,
      nullPct: totalCells === 0 ? 0 : (nullCells / totalCells) * 100,
      typeCounts: this.schema.reduce((acc, c) => {
        acc[c.inferredType] = (acc[c.inferredType] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      columns: perColumn,
    };
  }

}
export const gridStore = new GridStore();
