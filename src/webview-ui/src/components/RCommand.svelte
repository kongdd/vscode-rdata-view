<script module lang="ts">
  export function autosizeCommand(input: HTMLTextAreaElement) {
    const resize = () => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    };
    resize();
    input.addEventListener('input', resize);
    return { destroy: () => input.removeEventListener('input', resize) };
  }

  export function handleCommandKey(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
    if (event.isComposing) return;
    const execute = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    let text = '';
    if (event.key === 'Tab' && !(event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)) text = '  ';
    else if (event.key.toLowerCase() === 'm' && event.metaKey && event.shiftKey) text = '%>% ';
    if (!execute && !text) return;
    event.preventDefault();
    event.stopPropagation();
    if (execute) {
      event.currentTarget.form?.requestSubmit();
      return;
    }
    const input = event.currentTarget;
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
</script>

<script lang="ts">
  import { postMessage } from '../bridge/vscode.js';
  import { uiStore } from '../stores/ui.svelte.js';

  let code = $state('df %>% head(10)');
  let scrollTop = $state(0);
</script>

<form class="r-command" aria-busy={uiStore.queryRunning} onsubmit={(event) => {
  event.preventDefault();
  if (uiStore.loading || uiStore.queryRunning || !code.trim()) return;
  uiStore.error = null;
  uiStore.queryRunning = true;
  postMessage({ type: 'EXECUTE_R_QUERY', payload: { code } });
}}>
  <div class="command-editor">
    <!-- <span class="language" aria-hidden="true">R</span> -->
    <div class="line-numbers" aria-hidden="true">
      <div style:transform={`translateY(-${scrollTop}px)`}>
        {#each code.split('\n') as _, i}<div>{i + 1}</div>{/each}
      </div>
    </div>
    <textarea bind:value={code} use:autosizeCommand rows="1" wrap="off" aria-label="R command"
      onscroll={(event) => scrollTop = event.currentTarget.scrollTop}
      aria-keyshortcuts="Meta+Enter Control+Enter Meta+Shift+M Tab" onkeydown={handleCommandKey}
      onfocus={() => postMessage({ type: 'PREPARE_R' })} spellcheck="false"
      title="df is the current table (lazy for Arrow). data.table, magrittr, dplyr and lubridate are loaded before execution."
      disabled={uiStore.queryRunning}></textarea>
    <div class="command-actions">
      <span class="shortcut" aria-hidden="true">⌘ / Ctrl ↵</span>
      {#if uiStore.queryRunning}
        <button class="cancel" type="button" onclick={() => postMessage({ type: 'QUERY_CANCEL' })}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4z" /></svg>
          取消
        </button>
      {:else}
        <button type="submit" title="执行（Cmd+Enter / Ctrl+Enter）"
          disabled={uiStore.loading || !code.trim()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 8 5-8 5z" /></svg>
          执行 R
        </button>
      {/if}
    </div>
  </div>
</form>

<style>
  .r-command {
    padding: 5px 12px;
    border-bottom: 1px solid var(--gm-border);
    flex-shrink: 0;
    container-type: inline-size;
  }

  .command-editor {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 3px 6px;
    background: var(--gm-input-bg);
    border: 1px solid var(--gm-border);
    border-radius: 4px;
  }

  .command-editor:focus-within { border-color: var(--gm-accent); }
  /* .language { padding: 4px 2px; color: var(--gm-fg-muted); font: 600 11px/20px ui-monospace, monospace; } */

  .line-numbers {
    max-height: 160px;
    overflow: hidden;
    padding: 4px 6px;
    background: color-mix(in srgb, var(--gm-input-bg) 90%, var(--gm-fg) 10%);
    color: var(--vscode-editorLineNumber-foreground, var(--gm-fg-muted));
    text-align: right;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 20px;
    user-select: none;
  }

  textarea {
    flex: 1;
    min-width: 0;
    min-height: 28px;
    max-height: 160px;
    margin: 0;
    padding: 4px 0;
    resize: none;
    border: none;
    outline: none;
    background: transparent;
    color: var(--gm-fg);
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 20px;
    tab-size: 2;
  }

  .command-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .shortcut { color: var(--gm-fg-subtle); font-size: 10px; white-space: nowrap; }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 28px;
    padding: 3px 8px;
    border: none;
    border-radius: 3px;
    background: var(--gm-accent-light);
    color: var(--gm-accent);
    font: inherit;
    font-size: 11px;
    white-space: nowrap;
    cursor: pointer;
  }

  button:hover:not(:disabled) { background: color-mix(in srgb, var(--gm-accent) 25%, transparent); }
  button:disabled { opacity: .4; cursor: default; }
  button.cancel { background: var(--gm-hover-bg); color: var(--gm-fg); }
  svg { width: 12px; height: 12px; fill: currentColor; }

  @container (max-width: 420px) {
    .shortcut { display: none; }
  }
</style>
