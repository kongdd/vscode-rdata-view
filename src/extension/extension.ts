import * as vscode from 'vscode';
import { TableView } from './TableView.js';
import { disposeRWorker } from './reader/RWorker.js';

const VIEW = 'rdataView.table';

export function deactivate(): void {
  disposeRWorker();
}

export function activate(context: vscode.ExtensionContext): void {
  const views = new Set<TableView>();
  const queryNumbers = new Set<number>();
  const attach = (uri: vscode.Uri, panel: vscode.WebviewPanel, cleanup?: () => Promise<void>,
    title?: string, protectedPaths?: string[]) => {
    const view = new TableView(uri, panel, context.extensionUri, {
      cleanup, title, protectedPaths,
      openQuery(result, name, sources) {
        let number = 1;
        while (queryNumbers.has(number)) number++;
        const title = `${name} (${number})`;
        const resultPanel = vscode.window.createWebviewPanel('rdataView.query', title,
          panel.viewColumn ?? vscode.ViewColumn.Active, { retainContextWhenHidden: true });
        queryNumbers.add(number);
        resultPanel.onDidDispose(() => queryNumbers.delete(number));
        attach(vscode.Uri.file(result.path), resultPanel, result.dispose, title, sources);
      },
    });
    views.add(view);
    panel.onDidDispose(() => { view.dispose(); views.delete(view); });
  };
  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument(uri) {
      if (uri.scheme !== 'file') throw new Error('R Data View requires a local file');
      return { uri, dispose() {} };
    },
    resolveCustomEditor(document, panel) {
      attach(document.uri, panel);
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW, provider, {
      webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('rdataView.open', async (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri;
      if (!uri) [uri] = await vscode.window.showOpenDialog({ canSelectMany: false }) ?? [];
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW);
    }),
    { dispose() { for (const view of views) view.dispose(); views.clear(); disposeRWorker(); } },
  );
}
