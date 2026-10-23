import type { WebviewMessage } from '@shared/messages.js';

interface Api {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare const acquireVsCodeApi: () => Api;
export const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : {
  postMessage: (message: WebviewMessage) => console.log(message),
  getState: () => undefined,
  setState: (_state: unknown) => {},
};
export const postMessage = (message: WebviewMessage): void => vscode.postMessage(message);
