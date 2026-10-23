import { afterEach, describe, expect, it, vi } from 'vitest';
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./vscode.js', () => ({ postMessage: post }));
import { readHostRows, receivePage, cancelPages } from './readHostRows.js';

afterEach(() => { cancelPages(); vi.useRealTimers(); post.mockClear(); });
describe('correlated page requests', () => {
  it('ignores unrelated chunks and resolves the requested page', async () => {
    const promise = readHostRows(500, 502);
    const id = post.mock.calls[0][0].payload.requestId;
    receivePage({ type: 'CHUNK', payload: { requestId: 'other', rows: [[999]] } });
    receivePage({ type: 'CHUNK', payload: { requestId: id, rows: [[500], [501]] } });
    expect(await promise).toEqual([[500], [501]]);
  });

  it('rejects host errors, hidden tables and timeouts', async () => {
    const error = readHostRows(0, 1);
    const id = post.mock.calls.at(-1)![0].payload.requestId;
    receivePage({ type: 'ERROR', payload: { requestId: id, message: 'changed' } });
    await expect(error).rejects.toThrow('changed');
    const hidden = readHostRows(0, 1);
    cancelPages();
    await expect(hidden).rejects.toThrow('hidden');
    vi.useFakeTimers();
    const timeout = readHostRows(0, 1);
    const rejected = expect(timeout).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
  });
});
