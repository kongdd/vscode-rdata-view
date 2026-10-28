import type { HostMessage } from '@shared/messages.js';
import type { CellValue } from '@shared/schema.js';
import { postMessage } from './vscode.js';

const pending = new Map<string, { finish(error?: Error, rows?: CellValue[][]): void }>();

/** Shared by viewport loads and copying: every page is correlated and time-limited. */
export function readHostRows(startRow: number, endRow: number): Promise<CellValue[][]> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => finish(new Error('Page read timed out. Reopen the editor.')), 120_000);
    const finish = (error?: Error, rows: CellValue[][] = []) => {
      clearTimeout(timer);
      pending.delete(requestId);
      if (error) reject(error); else resolve(rows);
    };
    pending.set(requestId, { finish });
    try { postMessage({ type: 'REQUEST_CHUNK', payload: { requestId, startRow, endRow } }); }
    catch (error) { finish(error as Error); }
  });
}

export function receivePage(message: HostMessage): void {
  if (message.type === 'CHUNK') pending.get(message.payload.requestId)?.finish(undefined, message.payload.rows);
  if (message.type === 'ERROR' && message.payload.requestId) pending.get(message.payload.requestId)?.finish(new Error(message.payload.message));
}

export function cancelPages(): void {
  for (const request of pending.values()) request.finish(new Error('Table hidden or changed'));
}
