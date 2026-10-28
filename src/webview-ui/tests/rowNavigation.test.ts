import { describe, expect, it } from 'vitest';
import { HEADER_HEIGHT, MAX_SCROLLABLE_HEIGHT, OVERSCAN, ROW_HEIGHT, rowScrollTop } from '../src/stores/rowNavigation.js';

describe('row scroll positioning', () => {
  it('centers ordinary rows and clamps to either end', () => {
    const height = 100 * ROW_HEIGHT + HEADER_HEIGHT;
    expect(rowScrollTop(0, 100, 600, height)).toBe(0);
    expect(rowScrollTop(50, 100, 600, height)).toBe(40 * ROW_HEIGHT);
    expect(rowScrollTop(99, 100, 600, height)).toBe(height - 600);
    expect(rowScrollTop(0, 1, 600, ROW_HEIGHT + HEADER_HEIGHT)).toBe(0);
  });

  it.each([0, ROW_HEIGHT])('reveals exact rows in compressed tables with a %s px frozen band', frozen => {
    const total = 5_000_000;
    const viewport = 600;
    const height = MAX_SCROLLABLE_HEIGHT + HEADER_HEIGHT + frozen;
    const maxScroll = height - viewport;
    const count = Math.ceil((viewport - HEADER_HEIGHT - frozen) / ROW_HEIGHT) + OVERSCAN * 2;
    const maxStart = total - count;
    const rows = [0, 1, 100, 2_500_000, ...Array.from({ length: 100 }, (_, i) => total - i - 1)];
    for (const row of rows) {
      const top = rowScrollTop(row, total, viewport, height, frozen);
      const atEnd = top >= maxScroll - 0.01;
      const start = atEnd ? maxStart : Math.max(0, Math.floor(top / maxScroll * maxStart) - OVERSCAN);
      const offset = atEnd ? MAX_SCROLLABLE_HEIGHT - count * ROW_HEIGHT : Math.max(0, top - OVERSCAN * ROW_HEIGHT);
      const y = HEADER_HEIGHT + frozen + offset + (row - start) * ROW_HEIGHT - top;
      expect(row, `row ${row} is rendered`).toBeGreaterThanOrEqual(start);
      expect(row, `row ${row} is rendered`).toBeLessThan(start + count);
      expect(y, `row ${row} clears sticky bands`).toBeGreaterThanOrEqual(HEADER_HEIGHT + frozen - 0.01);
      expect(y + ROW_HEIGHT, `row ${row} fits in viewport`).toBeLessThanOrEqual(viewport + 0.01);
    }
  });
});
