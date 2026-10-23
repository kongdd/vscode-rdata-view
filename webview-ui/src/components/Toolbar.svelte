<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { uiStore } from '../stores/ui.svelte.js';
  import DatasetStatsPanel from './DatasetStatsPanel.svelte';
  let columns = $state(false);
  let stats = $state(false);
</script>

<svelte:window onclick={(event) => { if (!(event.target as Element).closest('.col-panel-wrap')) columns = false; }} />
<div class="toolbar">
  <span class="file-name" title={gridStore.fileName}>{gridStore.fileName}</span>
  <input class="search-input" type="search" placeholder={gridStore.paged ? 'Search unavailable in on-demand mode' : 'Search…'}
    disabled={gridStore.paged} value={gridStore.globalSearch}
    oninput={(event) => gridStore.setGlobalSearch(event.currentTarget.value)} aria-label="Search table" />
  {#if gridStore.filters.length}<button onclick={() => gridStore.clearFilters()}>Clear filters</button>{/if}
  <button onclick={() => gridStore.toggleColColors()} title="Color columns">Colors</button>
  <button disabled={gridStore.paged} onclick={() => stats = !stats}>Statistics</button>
  <div class="col-panel-wrap">
    <button onclick={() => columns = !columns}>Columns</button>
    {#if columns}
      <div class="col-panel" role="dialog" aria-label="Visible columns">
        {#each gridStore.schema as col (col.index)}
          <label>
            <input type="checkbox" checked={!gridStore.hiddenCols.has(col.index)} onchange={() => gridStore.toggleColumnVisibility(col.index)} />
            {col.name}<small>{col.inferredType}</small>
          </label>
        {/each}
      </div>
    {/if}
  </div>
  <button disabled={uiStore.loading || uiStore.exportProgress !== null} onclick={() => gridStore.exportCsv()} title="Export table (current filter/sort in small-table mode)">Export CSV</button>
</div>
{#if stats}<DatasetStatsPanel onClose={() => stats = false} />{/if}

<style>
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--gm-toolbar-bg); border-bottom: 1px solid var(--gm-border); min-height: 38px; flex-shrink: 0; }
  .file-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--gm-fg-muted); }
  .search-input { flex: 1; min-width: 80px; max-width: 500px; margin: 0 auto; padding: 5px 8px; background: var(--gm-input-bg); color: var(--gm-fg); border: 1px solid var(--gm-border); border-radius: 4px; }
  button { padding: 4px 8px; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--gm-fg); cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
  button:hover { background: var(--gm-hover); }
  button:disabled { opacity: .4; cursor: default; }
  .col-panel-wrap { position: relative; }
  .col-panel { position: absolute; top: 100%; right: 0; z-index: 1000; min-width: 200px; max-height: 360px; overflow: auto; background: var(--gm-menu-bg); border: 1px solid var(--gm-border); border-radius: 5px; box-shadow: 0 4px 16px #0004; }
  label { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 12px; white-space: nowrap; }
  small { margin-left: auto; color: var(--gm-fg-muted); }
</style>
