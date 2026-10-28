import type { CellValue, FilterSpec, SortSpec } from '@shared/schema.js';
import { applyFilter, compareValues } from '@shared/filterUtils.js';

export function hasViewTransform(filters: FilterSpec[], sort: SortSpec | null, search: string): boolean {
  return filters.length > 0 || !!sort || search.trim().length > 0;
}

export function buildViewIndex(
  rows: CellValue[][],
  filters: FilterSpec[],
  sort: SortSpec | null,
  search: string,
): number[] {
  const q = search.trim().toLowerCase();
  const hasSearch = q.length > 0;
  const hasFilter = filters.length > 0;

  let indices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (hasFilter && !filters.every(f => applyFilter(row, f))) continue;
    if (hasSearch && !row.some(cell => String(cell ?? '').toLowerCase().includes(q))) continue;
    indices.push(i);
  }

  if (sort) {
    const { colIndex, direction } = sort;
    indices.sort((a, b) => compareValues(rows[a][colIndex], rows[b][colIndex], direction));
  }

  return indices;
}

