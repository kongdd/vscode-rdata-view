<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';

  interface Props {
    row: number;
    anchor: { x: number; y: number };
    onClose: () => void;
  }

  let { row, anchor, onClose }: Props = $props();


  function act(fn: () => void) { fn(); onClose(); }

  function handleClickOutside(e: MouseEvent) {
    if (!(e.target as Element).closest('.row-context-menu')) onClose();
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div
  class="row-context-menu"
  style="left: {anchor.x}px; top: {anchor.y}px;"
  role="menu"
  tabindex="-1"
>
  <div class="menu-header">Row {row + 1}</div>

  <div class="menu-section">
    <button class="menu-item" onclick={() => act(() => gridStore.copyRowToClipboard(row))}>
      <span class="menu-icon">⎘</span> Copy row
    </button>
    <button class="menu-item" onclick={() => act(() => gridStore.toggleFreezeRow(row))}>
      <span class="menu-icon">📌</span> {gridStore.frozenRow === row ? 'Unfreeze row' : 'Freeze row'}
    </button>
  </div>

</div>

<style>
  .row-context-menu {
    position: fixed;
    z-index: 1000;
    background: var(--gm-menu-bg);
    border: 1px solid var(--gm-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    min-width: 180px;
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
  }

  .menu-section { padding: 4px 0; }

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
  }

  .menu-item:hover { background: var(--gm-hover-bg); }

  .menu-icon {
    width: 14px;
    text-align: center;
    color: var(--gm-fg-muted);
    font-size: 11px;
  }

</style>
