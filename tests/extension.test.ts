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

function openSource() {
  activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as unknown as vscode.ExtensionContext);
  const provider = vi.mocked(editor.window.registerCustomEditorProvider).mock.calls[0][1] as vscode.CustomReadonlyEditorProvider;
  provider.resolveCustomEditor({ uri: { fsPath: '/source.arrow' }, dispose() {} } as vscode.CustomDocument,
    { onDidDispose: vi.fn() } as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  return vi.mocked(TableView).mock.calls[0][3]!;
}

it('reuses the smallest available query number without renumbering open tabs', () => {
  const panels: { onDidDispose: ReturnType<typeof vi.fn> }[] = [];
  vi.mocked(editor.window.createWebviewPanel).mockImplementation(() => {
    const panel = { onDidDispose: vi.fn() };
    panels.push(panel);
    return panel as unknown as vscode.WebviewPanel;
  });
  const options = openSource();
  const result = { path: '/query.arrow', dispose: vi.fn(async () => {}) };
  const query = () => options.openQuery!(result, 'Query', ['/source.arrow']);
  const close = (index: number) => panels[index].onDidDispose.mock.calls.forEach(([dispose]) => dispose());
  query(); query(); query();
  close(1);
  query(); // 1, 3 仍打开，复用 2。
  close(2); close(0);
  query(); query(); // 2 仍打开，依次复用 1、3。
  close(3); close(4); close(5);
  query(); // 全部关闭后重新使用 1。
  expect(vi.mocked(editor.window.createWebviewPanel).mock.calls.map(call => call[1]))
    .toEqual(['Query (1)', 'Query (2)', 'Query (3)', 'Query (2)', 'Query (1)', 'Query (3)', 'Query (1)']);
});

it('does not reserve a query number when opening its panel fails', () => {
  vi.mocked(editor.window.createWebviewPanel)
    .mockImplementationOnce(() => { throw new Error('Opening failed'); })
    .mockReturnValue({ onDidDispose: vi.fn() } as unknown as vscode.WebviewPanel);
  const options = openSource();
  const result = { path: '/query.arrow', dispose: vi.fn(async () => {}) };
  expect(() => options.openQuery!(result, 'Query', [])).toThrow('Opening failed');
  options.openQuery!(result, 'Query', []);
  expect(vi.mocked(editor.window.createWebviewPanel).mock.calls.map(call => call[1])).toEqual(['Query (1)', 'Query (1)']);
});

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
