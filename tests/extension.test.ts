import { beforeEach, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  ViewColumn: { Active: -1 },
  window: { registerCustomEditorProvider: vi.fn(), createWebviewPanel: vi.fn() },
  commands: { registerCommand: vi.fn() },
}));
vi.mock('../src/extension/TableView.js', () => ({
  TableView: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
}));
import * as editor from 'vscode';
import { TableView } from '../src/extension/TableView.js';
import { activate } from '../src/extension/extension.js';

beforeEach(() => { vi.clearAllMocks(); });

it.each([2, undefined])('opens query results as switchable tabs in the source editor group (%s)', viewColumn => {
  const resultPanel = { onDidDispose: vi.fn() };
  vi.mocked(editor.window.createWebviewPanel).mockReturnValue(resultPanel as unknown as vscode.WebviewPanel);
  activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as unknown as vscode.ExtensionContext);
  const provider = vi.mocked(editor.window.registerCustomEditorProvider).mock.calls[0][1] as vscode.CustomReadonlyEditorProvider;
  const panel = { viewColumn, onDidDispose: vi.fn() } as unknown as vscode.WebviewPanel;
  provider.resolveCustomEditor({ uri: { fsPath: '/source.arrow' }, dispose() {} } as vscode.CustomDocument,
    panel, {} as vscode.CancellationToken);
  const options = vi.mocked(TableView).mock.calls[0][3]!;
  const result = { path: '/query.arrow', dispose: vi.fn(async () => {}) };
  options.openQuery!(result, 'Query', ['/source.arrow']);
  expect(editor.window.createWebviewPanel).toHaveBeenCalledWith('rdataView.query', 'Query (1)',
    viewColumn ?? editor.ViewColumn.Active, { retainContextWhenHidden: true });
  expect(TableView).toHaveBeenCalledTimes(2);
  expect(vi.mocked(TableView).mock.calls[1][1]).toBe(resultPanel);
  expect(vi.mocked(TableView).mock.calls[1][3]).toMatchObject({ cleanup: result.dispose, protectedPaths: ['/source.arrow'] });
});
