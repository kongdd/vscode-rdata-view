import * as vscode from 'vscode';
import { TableView } from './TableView.js';

const VIEW = 'rdataView.table';

export function activate(context: vscode.ExtensionContext): void {
  const views = new Set<TableView>();
  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument(uri) {
      if (uri.scheme !== 'file') throw new Error('R Data View requires a local file');
      return { uri, dispose() {} };
    },
    resolveCustomEditor(document, panel) {
      const view = new TableView(document.uri, panel, context.extensionUri);
      views.add(view);
      panel.onDidDispose(() => { view.dispose(); views.delete(view); });
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
    { dispose() { for (const view of views) view.dispose(); views.clear(); } },
  );
}
