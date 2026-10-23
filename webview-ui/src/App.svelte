<script lang="ts">
  import { onMount } from 'svelte';
  import { setupMessageHandler } from './bridge/messageHandler.js';
  import { postMessage } from './bridge/vscode.js';
  import { gridStore } from './stores/grid.svelte.js';
  import { uiStore } from './stores/ui.svelte.js';
  import Toolbar from './components/Toolbar.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import DataGrid from './components/DataGrid.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import LoadingOverlay from './components/LoadingOverlay.svelte';
  import ErrorBanner from './components/ErrorBanner.svelte';
  import NoticeBanner from './components/NoticeBanner.svelte';
  import SheetTabs from './components/SheetTabs.svelte';

  onMount(() => {
    const cleanup = setupMessageHandler();
    postMessage({ type: 'READY' });
    return cleanup;
  });
</script>

<div class="app-shell">
  {#if uiStore.error}<ErrorBanner message={uiStore.error} />{/if}
  {#if gridStore.notice}<NoticeBanner message={gridStore.notice} />{/if}
  <Toolbar />
  {#if gridStore.filters.length}<FilterBar />{/if}
  {#if gridStore.availableSheets.length > 1}<SheetTabs />{/if}
  <div class="grid-area">
    {#if gridStore.schema.length}
      {#key gridStore.selectedSheet}<DataGrid />{/key}
    {:else if !uiStore.loading}
      <div class="empty-state">Open an R, CSV, Excel or Arrow table.</div>
    {/if}
    {#if uiStore.loading}<LoadingOverlay message={uiStore.loadingMessage} />{/if}
  </div>
  <StatusBar />
</div>

<style>
  .app-shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--gm-bg); color: var(--gm-fg); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .grid-area { flex: 1; overflow: hidden; position: relative; }
  .empty-state { display: grid; place-items: center; height: 100%; color: var(--gm-fg-muted); }
</style>
