<script lang="ts">
  import { gridStore } from '../stores/grid.svelte.js';
  import { uiStore } from '../stores/ui.svelte.js';
  import DatasetStatsPanel from './DatasetStatsPanel.svelte';
  let columns = $state(false);
  let stats = $state(false);
  let objectsOpen = $state(false);
  let rowNumber = $state<number | undefined>();
  let expression = $state('');
  $effect(() => { expression = gridStore.dplyrFilter; });
  const jumpDisabled = $derived(uiStore.loading || gridStore.filteredRows === 0);
  // 有具名对象（rda、qs 多对象、xlsx 工作表）时显示对象名；多个才可点击切换。路径已由面包屑给出。
  const objects = $derived(gridStore.selectedSheet ? gridStore.availableSheets : []);
  const objectsLabel = $derived(gridStore.fileType === 'excel' ? 'Sheets' : gridStore.fileType === 'gpkg' || gridStore.fileType === 'shp' ? 'Layers' : 'Tables');
</script>

<svelte:window onclick={(event) => {
  if (!(event.target as Element).closest('.col-panel-wrap')) columns = false;
  if (!(event.target as Element).closest('.objects-wrap')) objectsOpen = false;
}} />
<div class="toolbar">
  {#if objects.length}
    <div class="objects-wrap">
      <button class="object-name" title={`Switch ${objectsLabel.toLowerCase()}`} onclick={() => objectsOpen = !objectsOpen}>{gridStore.selectedSheet}</button>
      {#if objectsOpen}
        <div class="object-panel" role="menu" aria-label={objectsLabel}>
          {#each objects as name (name)}
            <button role="menuitem" class:active={name === gridStore.selectedSheet}
              onclick={() => { objectsOpen = false; gridStore.selectSheet(name); }}>{name}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  {#if gridStore.spatial}
    <small class="spatial-info" title={`${gridStore.spatial.crs} · ${gridStore.spatial.types || 'Empty geometry'}; geometry coordinates are not shown or exported; the layer is read into R memory`}>
      {gridStore.spatial.crs} · {gridStore.spatial.types || 'Empty geometry'}
    </small>
  {/if}
  <input class="search-input" type="search" placeholder={gridStore.paged ? 'Search unavailable in on-demand mode' : 'Search…'}
    disabled={gridStore.paged} value={gridStore.globalSearch}
    oninput={(event) => gridStore.setGlobalSearch(event.currentTarget.value)} aria-label="Search table" />
  {#if gridStore.fileType === 'arrow'}
    <form class="dplyr-filter" onsubmit={(event) => {
      event.preventDefault();
      gridStore.applyDplyrFilter(expression);
    }}>
      <input class="search-input" bind:value={expression} aria-label="dplyr filter"
        placeholder="filter: value > 0, !is.na(site)"
        title="dplyr::filter() conditions; Enter to apply. Executes local R code in a trusted workspace."
        disabled={uiStore.loading} />
      <button type="submit" disabled={uiStore.loading}>Apply</button>
      {#if expression || gridStore.dplyrFilter}
        <button type="button" onclick={() => {
          expression = ''; gridStore.applyDplyrFilter('');
        }}>Clear</button>
      {/if}
      <small title={gridStore.dplyrFilter ? 'R / dplyr backend; filters the whole file' : 'TypeScript Arrow backend'}>
        {gridStore.dplyrFilter ? 'R / dplyr' : 'TS'}
      </small>
    </form>
  {/if}
  <form class="row-jump" onsubmit={(event) => {
    event.preventDefault();
    if (!jumpDisabled && rowNumber !== undefined) gridStore.goToRow(rowNumber);
  }}>
    <input class="row-input" type="number" min="1" max={gridStore.filteredRows} step="1" required
      bind:value={rowNumber} disabled={jumpDisabled} placeholder="Row…" aria-label="Go to row"
      title={`Row in current view (1–${gridStore.filteredRows.toLocaleString()}); Enter to jump`} />
    <button type="submit" disabled={jumpDisabled || rowNumber === undefined}>Go</button>
  </form>
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
  <button disabled={uiStore.loading || uiStore.exportProgress !== null} onclick={() => gridStore.exportCsv()} title={gridStore.spatial ? 'Export attributes only; geometry is excluded' : gridStore.dplyrFilter ? 'Export all dplyr-filtered rows' : 'Export table (current filter/sort in small-table mode)'}>Export CSV</button>
</div>
{#if stats}<DatasetStatsPanel onClose={() => stats = false} />{/if}

<style>
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--gm-toolbar-bg); border-bottom: 1px solid var(--gm-border); min-height: 38px; flex-shrink: 0; }
  .spatial-info { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .objects-wrap { position: relative; flex-shrink: 0; }
  .object-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .object-panel { position: absolute; top: 100%; left: 0; z-index: 1000; min-width: 160px; max-height: 360px; overflow: auto; background: var(--gm-menu-bg); border: 1px solid var(--gm-border); border-radius: 5px; box-shadow: 0 4px 16px #0004; }
  .object-panel button { display: block; width: 100%; text-align: left; border-radius: 0; padding: 6px 10px; font-size: 12px; }
  .object-panel button.active { background: var(--gm-hover); font-weight: 600; }
  .search-input { flex: 1; min-width: 80px; max-width: 500px; margin: 0 auto; padding: 5px 8px; background: var(--gm-input-bg); color: var(--gm-fg); border: 1px solid var(--gm-border); border-radius: 4px; }
  .dplyr-filter { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 180px; }
  .dplyr-filter .search-input { width: 100%; margin: 0; }
  .row-jump { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .row-input { width: 90px; padding: 5px 8px; background: var(--gm-input-bg); color: var(--gm-fg); border: 1px solid var(--gm-border); border-radius: 4px; font: inherit; font-size: 12px; }
  button { padding: 4px 8px; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--gm-fg); cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
  button:hover { background: var(--gm-hover); }
  button:disabled { opacity: .4; cursor: default; }
  .col-panel-wrap { position: relative; }
  .col-panel { position: absolute; top: 100%; right: 0; z-index: 1000; min-width: 200px; max-height: 360px; overflow: auto; background: var(--gm-menu-bg); border: 1px solid var(--gm-border); border-radius: 5px; box-shadow: 0 4px 16px #0004; }
  label { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 12px; white-space: nowrap; }
  small { margin-left: auto; color: var(--gm-fg-muted); }
</style>
