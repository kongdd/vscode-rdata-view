<script lang="ts">
  import { postMessage } from '../bridge/vscode.js';
  import { uiStore } from '../stores/ui.svelte.js';

  let code = $state('df |>\n  collect()');
</script>

<form class="r-command" onsubmit={(event) => {
  event.preventDefault();
  if (uiStore.loading || uiStore.queryRunning || !code.trim()) return;
  uiStore.error = null;
  uiStore.queryRunning = true;
  postMessage({ type: 'EXECUTE_R_QUERY', payload: { code } });
}}>
  <textarea bind:value={code} rows="3" aria-label="R command"
    onfocus={() => postMessage({ type: 'PREPARE_R' })} spellcheck="false"
    title="df is the current table (lazy for Arrow). data.table, magrittr, dplyr and lubridate are loaded before execution."
    disabled={uiStore.queryRunning}></textarea>
  <div class="command-actions">
    <button type="submit" disabled={uiStore.loading || uiStore.queryRunning || !code.trim()}>执行 R</button>
    {#if uiStore.queryRunning}
      <button type="button" onclick={() => postMessage({ type: 'QUERY_CANCEL' })}>取消</button>
    {/if}
  </div>
</form>

<style>
  .r-command { display: flex; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--gm-border); flex-shrink: 0; }
  textarea { flex: 1; min-width: 120px; min-height: 48px; resize: vertical; padding: 6px 8px; background: var(--gm-input-bg); color: var(--gm-fg); border: 1px solid var(--gm-border); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .command-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  button { padding: 4px 10px; background: var(--gm-toolbar-bg); color: var(--gm-fg); border: 1px solid var(--gm-border); border-radius: 4px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
</style>
