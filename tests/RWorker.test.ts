import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { disposeRWorker, releaseR, runR } from '../src/extension/reader/RWorker.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const processes: ReturnType<typeof fakeProcess>[] = [];
function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: { resume: vi.fn() },
    kill: vi.fn(),
  });
}
const request = (line = 'read', signal?: AbortSignal) => runR('R', 'server.R', line, signal, 120_000);
const reply = () => processes.at(-1)!.stdout.emit('data', 'ok\n');
async function read() {
  const pending = request();
  await Promise.resolve();
  reply();
  await pending;
}
async function release() {
  const pending = releaseR('R', 'server.R', 'table-key', 120_000);
  await Promise.resolve();
  reply();
  await pending;
}
beforeEach(() => {
  vi.useFakeTimers();
  processes.length = 0;
  vi.mocked(spawn).mockImplementation(() => {
    const proc = fakeProcess();
    processes.push(proc);
    return proc as unknown as ChildProcessWithoutNullStreams;
  });
});
afterEach(() => { disposeRWorker(); vi.useRealTimers(); vi.clearAllMocks(); });

it('resets the idle timeout on every request, including long reads', async () => {
  await read();
  await vi.advanceTimersByTimeAsync(59_000);
  const pending = request();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(2000);
  expect(processes[0].kill).not.toHaveBeenCalled();
  reply();
  await pending;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(processes[0].kill).toHaveBeenCalledOnce();
});

it('releases before GC and postpones GC until R has been idle for a second', async () => {
  await read();
  await release();
  const stdin = processes[0].stdin;
  expect(stdin.write).toHaveBeenLastCalledWith(expect.stringContaining('\ttable-key\trelease\n'));
  await vi.advanceTimersByTimeAsync(999);
  const pending = request();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(2);
  expect(stdin.write).toHaveBeenLastCalledWith('read\n');
  reply();
  await pending;
  await vi.advanceTimersByTimeAsync(999);
  expect(stdin.write).toHaveBeenLastCalledWith('read\n');
  await vi.advanceTimersByTimeAsync(1);
  expect(stdin.write).toHaveBeenLastCalledWith('\t'.repeat(9) + 'gc\n');
  reply();
  await Promise.resolve();
});

it('does not restart an expired R process just to release a table', async () => {
  await read();
  await vi.advanceTimersByTimeAsync(60_000);
  await releaseR('R', 'server.R', 'table-key', 120_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(spawn).toHaveBeenCalledOnce();
});

it('rejects worker exits promptly and ignores stale events after restarting', async () => {
  const pending = request();
  await Promise.resolve();
  const first = processes[0];
  first.emit('exit', 1);
  await expect(pending).rejects.toThrow('R worker exited');
  const next = request();
  await Promise.resolve();
  first.stdout.emit('data', 'stale\n');
  first.emit('exit', 1);
  reply();
  await expect(next).resolves.toBe('ok');
  expect(processes[1].kill).not.toHaveBeenCalled();
});

it('cancels active reads and prevents disposed workers from restarting queued reads', async () => {
  const controller = new AbortController();
  const pending = request('read', controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  const next = request();
  disposeRWorker();
  await expect(next).rejects.toThrow('stopped');
  expect(spawn).toHaveBeenCalledOnce();
});
