import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ColumnMenu from '../src/components/ColumnMenu.svelte';
import ColumnStatsPanel from '../src/components/ColumnStatsPanel.svelte';
import { gridStore } from '../src/stores/grid.svelte.js';

function menu(): string {
  return render(ColumnMenu, {
    props: { colIndex: 0, anchor: { x: 100, y: 100 }, onClose() {}, onShowStats() {} },
  }).body;
}

function button(html: string, label: string): string {
  const markup = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .find(([value]) => value.includes(label))?.[0];
  expect(markup, label).toBeDefined();
  return markup!;
}

beforeEach(() => {
  gridStore.init({
    fileType: 'rds', fileName: crypto.randomUUID(), totalRows: 3, totalBytes: 100,
    schema: [{ name: 'value', index: 0, inferredType: 'number', nullable: true }],
    rows: [[3], [null], [1]], paged: false, choices: [], selected: '',
  });
});

describe('column menu', () => {
  it('enables small-table operations and reflects sort/freeze state', () => {
    let html = menu();
    for (const label of ['Sort ascending', 'Sort descending', 'Filter column', 'Copy column', 'Column statistics', 'Freeze column', 'Hide column']) {
      expect(button(html, label)).not.toContain('disabled');
    }
    expect(button(html, 'Clear sort')).toContain('disabled');
    expect(html).not.toContain('Unfreeze all columns');
    gridStore.setSort({ colIndex: 0, direction: 'asc' });
    gridStore.toggleFreezeCol(0);
    html = menu();
    expect(button(html, 'Sort ascending')).toMatch(/class="[^"]*active/);
    expect(button(html, 'Clear sort')).not.toContain('disabled');
    expect(button(html, 'Unfreeze column')).toMatch(/class="[^"]*active/);
    expect(button(html, 'Unfreeze all columns')).not.toContain('disabled');
  });

  it('explains disabled whole-table operations without disabling layout actions', () => {
    gridStore.paged = true;
    const html = menu();
    expect(html).toContain('unavailable in on-demand mode');
    for (const label of ['Sort ascending', 'Sort descending', 'Clear sort', 'Filter column', 'Column statistics']) {
      expect(button(html, label)).toContain('disabled');
    }
    for (const label of ['Copy column', 'Freeze column', 'Hide column']) {
      expect(button(html, label)).not.toContain('disabled');
    }
  });

  it('explains the copy limit before users attempt to copy a large column', () => {
    gridStore.filteredRows = 10_000;
    expect(button(menu(), 'Copy column')).not.toContain('disabled');
    gridStore.filteredRows++;
    const html = menu();
    expect(button(html, 'Copy column')).toContain('disabled');
    expect(html).toContain('10,000 rows; use Export CSV');
  });

  it('renders full-column statistics and the unavailable state', () => {
    const panel = () => render(ColumnStatsPanel, { props: { colIndex: 0, onClose() {} } }).body;
    expect(panel()).toContain('Numeric summary');
    gridStore.paged = true;
    expect(panel()).toContain('Statistics not available');
  });
});
