import type { HostMessage } from '@shared/messages.js';
import { gridStore } from '../stores/grid.svelte.js';
import { uiStore } from '../stores/ui.svelte.js';
import { receivePage } from './readHostRows.js';
import { postMessage } from './vscode.js';

export function setupMessageHandler(): () => void {
  const receive = (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    receivePage(message);
    switch (message.type) {
      case 'INIT': gridStore.init(message.payload); break;
      case 'DATA_VISIBILITY': gridStore.setDataVisible(message.payload.visible); break;
      case 'LOADING': uiStore.setLoading(message.payload.active, message.payload.message); break;
      case 'ERROR':
        if (!message.payload.requestId) {
          uiStore.setError(message.payload.message);
          gridStore.setDataVisible(true);
        }
        break;
      case 'QUERY_DONE':
        uiStore.queryRunning = false;
        if (message.payload.error) uiStore.setError(message.payload.error);
        break;
      case 'EXPORT_PROGRESS': uiStore.exportProgress = message.payload.pct; break;
      case 'EXPORT_DONE':
        uiStore.setExportDone(message.payload.path);
        if (message.payload.error) uiStore.setError(message.payload.error);
        break;
    }
  };
  window.addEventListener('message', receive);
  return () => { window.removeEventListener('message', receive); gridStore.setDataVisible(false); };
}

export function cancelExport(): void { postMessage({ type: 'EXPORT_CANCEL' }); }
