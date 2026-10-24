<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';

  interface Props {
    colIndex: number;
    anchor: { x: number; y: number };
    onClose(): void;
    onShowStats: (col: number) => void;
  }

  let { colIndex, anchor, onClose, onShowStats }: Props = $props();
  let width = $state(0);
  let height = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  const col = $derived(gridStore.schema[colIndex]);
  const isSorted = $derived(gridStore.sort?.colIndex === colIndex);
  const isFrozen = $derived(gridStore.frozenCols.has(colIndex));
  const copyLimited = $derived(gridStore.filteredRows > 10_000);
  const pagingReason = 'Unavailable in on-demand mode: requires the whole table in memory.';
  const copyReason = 'Copy is limited to 10,000 rows. Use CSV export for the whole table.';
  const left = $derived(Math.max(8, Math.min(anchor.x, viewportWidth - width - 8)));
  const top = $derived(Math.max(8, Math.min(anchor.y, viewportHeight - height - 8)));

  function act(fn: () => unknown): void {
    fn();
    onClose();
  }
</script>

<svelte:window
  bind:innerWidth={viewportWidth}
  bind:innerHeight={viewportHeight}
  onclick={(event) => { if (!(event.target as Element).closest('.column-menu')) onClose(); }}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }}
/>
<div class="column-menu" style="left: {left}px; top: {top}px;"
  bind:clientWidth={width} bind:clientHeight={height} role="menu" tabindex="-1">
  <div class="menu-header">{col?.name}</div>
  {#if gridStore.paged}<p class="menu-note">Sort, filter and statistics unavailable in on-demand mode.</p>{/if}
  <div class="menu-section" title={gridStore.paged ? pagingReason : undefined}>
    <button role="menuitem" class="menu-item" disabled={gridStore.paged}
      class:active={isSorted && gridStore.sort?.direction === 'asc'}
      onclick={() => act(() => gridStore.setSort({ colIndex, direction: 'asc' }))}>↑ Sort ascending</button>
    <button role="menuitem" class="menu-item" disabled={gridStore.paged}
      class:active={isSorted && gridStore.sort?.direction === 'desc'}
      onclick={() => act(() => gridStore.setSort({ colIndex, direction: 'desc' }))}>↓ Sort descending</button>
    <button role="menuitem" class="menu-item" disabled={gridStore.paged || !isSorted}
      onclick={() => act(() => gridStore.setSort(null))}>× Clear sort</button>
    <button role="menuitem" class="menu-item" disabled={gridStore.paged}
      onclick={() => act(() => gridStore.setFilter({ colIndex, op: 'is_not_null', value: '' }))}>⊟ Filter column</button>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-section">
    <div title={copyLimited ? copyReason : 'Copy this column in current filter/sort order'}>
      <button role="menuitem" class="menu-item" disabled={copyLimited}
        onclick={() => act(() => gridStore.copyColumnToClipboard(colIndex))}>⎘ Copy column</button>
    </div>
    {#if copyLimited}<p class="menu-note">Copy: up to 10,000 rows; use Export CSV.</p>{/if}
    <div title={gridStore.paged ? pagingReason : 'Statistics for the full, unfiltered column'}>
      <button role="menuitem" class="menu-item" disabled={gridStore.paged}
        onclick={() => act(() => onShowStats(colIndex))}>∑ Column statistics</button>
    </div>
    <button role="menuitem" class="menu-item" class:active={isFrozen}
      title="Keep this column visible while scrolling horizontally"
      onclick={() => act(() => gridStore.toggleFreezeCol(colIndex))}>{isFrozen ? 'Unfreeze' : 'Freeze'} column</button>
    {#if gridStore.frozenCols.size}
      <button role="menuitem" class="menu-item"
        onclick={() => act(() => gridStore.unfreezeAllCols())}>Unfreeze all columns</button>
    {/if}
    <button role="menuitem" class="menu-item" title="Restore hidden columns from the toolbar's Columns menu"
      onclick={() => act(() => gridStore.toggleColumnVisibility(colIndex))}>○ Hide column</button>
  </div>
</div>

<style>
  .column-menu {
    position: fixed;
    z-index: 1000;
    background: var(--gm-menu-bg);
    border: 1px solid var(--gm-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    min-width: 190px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: auto;
    font-size: 12px;
  }

  .menu-header {
    padding: 8px 12px 6px;
    font-weight: 600;
    color: var(--gm-fg-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--gm-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-note {
    max-width: 220px;
    margin: 6px 12px;
    color: var(--gm-fg-muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .menu-section {
    padding: 4px 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 12px;
    background: none;
    border: none;
    color: var(--gm-fg);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .menu-item:hover:not(:disabled) { background: var(--gm-hover-bg); }
  .menu-item.active { color: var(--gm-accent); }
  .menu-item:disabled { opacity: .4; cursor: default; }

  .menu-divider {
    height: 1px;
    background: var(--gm-border);
    margin: 2px 0;
  }
</style>
