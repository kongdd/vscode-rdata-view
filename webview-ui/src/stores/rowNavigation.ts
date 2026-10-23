export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 32;
export const OVERSCAN = 8;
export const MAX_SCROLLABLE_HEIGHT = 33_000_000;

// Row indices refer to the current sorted/filtered view, not source-file rows.
export function rowScrollTop(
  row: number,
  totalRows: number,
  viewportHeight: number,
  scrollHeight: number,
  frozenHeight = 0,
): number {
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);
  const pageRows = Math.max(1, Math.floor((viewportHeight - HEADER_HEIGHT - frozenHeight) / ROW_HEIGHT));
  const halfPage = Math.floor(pageRows / 2);
  if (totalRows * ROW_HEIGHT <= MAX_SCROLLABLE_HEIGHT) {
    return Math.min(maxScroll, Math.max(0, (row - halfPage) * ROW_HEIGHT));
  }
  if (row <= halfPage) return 0;
  if (row >= totalRows - pageRows) return maxScroll;
  const visibleCount = Math.max(1, Math.ceil((viewportHeight - HEADER_HEIGHT - frozenHeight) / ROW_HEIGHT)) + OVERSCAN * 2;
  const maxStart = Math.max(1, totalRows - visibleCount);
  // Invert the compressed scroll ratio; half a row avoids floating-point floor drift.
  const start = Math.min(maxStart - 1, Math.max(0, row - halfPage));
  return (start + 0.5) / maxStart * maxScroll;
}
