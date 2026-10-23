<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  interface Props { colIndex: number; anchor: { x: number; y: number }; onClose(): void; onShowStats?: (col: number) => void }
  let { colIndex, anchor, onClose, onShowStats }: Props = $props();
  const col = $derived(gridStore.schema[colIndex]);
  function act(fn: () => unknown): void { fn(); onClose(); }
</script>

<svelte:window onclick={(event) => { if (!(event.target as Element).closest('.column-menu')) onClose(); }} />
<div class="column-menu" style="left: {anchor.x}px; top: {anchor.y}px;" role="menu" tabindex="-1">
  <div class="menu-header">{col?.name}</div>
  <div class="menu-section">
    <button class="menu-item" disabled={gridStore.paged} onclick={() => act(() => gridStore.setSort({ colIndex, direction: 'asc' }))}>↑ Sort ascending</button>
    <button class="menu-item" disabled={gridStore.paged} onclick={() => act(() => gridStore.setSort({ colIndex, direction: 'desc' }))}>↓ Sort descending</button>
    <button class="menu-item" disabled={gridStore.paged} onclick={() => act(() => gridStore.setSort(null))}>× Clear sort</button>
    <button class="menu-item" disabled={gridStore.paged} onclick={() => act(() => gridStore.setFilter({ colIndex, op: 'is_not_null', value: '' }))}>⊟ Filter column</button>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-section">
    <button class="menu-item" onclick={() => act(() => gridStore.copyColumnToClipboard(colIndex))}>⎘ Copy column</button>
    <button class="menu-item" disabled={gridStore.paged} onclick={() => act(() => onShowStats?.(colIndex))}>∑ Column statistics</button>
    <button class="menu-item" onclick={() => act(() => gridStore.toggleFreezeCol(colIndex))}>{gridStore.frozenCols.has(colIndex) ? 'Unfreeze' : 'Freeze'} column</button>
    <button class="menu-item" onclick={() => act(() => gridStore.unfreezeAllCols())}>Unfreeze all columns</button>
    <button class="menu-item" onclick={() => act(() => gridStore.toggleColumnVisibility(colIndex))}>○ Hide column</button>
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
    overflow: hidden;
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

  .menu-item:hover { background: var(--gm-hover-bg); }


  .menu-divider {
    height: 1px;
    background: var(--gm-border);
    margin: 2px 0;
  }
</style>

