import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';

const IDLE_MS = 60_000;
const GC_IDLE_MS = 1000;

/** 按需启动、串行复用 R；表由 reader 释放，GC 延后到空闲时运行。 */
class RWorker {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  private buffer = '';
  private idle: NodeJS.Timeout | undefined;
  private gc: NodeJS.Timeout | undefined;
  private needsGC = false;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly executable: string, private readonly script: string) {}

  request(line: string, signal: AbortSignal | undefined, timeout: number, start = true): Promise<string> {
    const task = this.tail.then(() => {
      if (this.disposed) throw new Error('R worker stopped');
      return !start && !this.proc ? 'ok' : this.send(line, signal, timeout);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  collect(timeout: number): void {
    this.needsGC = true;
    this.scheduleGC(timeout);
  }

  dispose(): void { this.disposed = true; this.stop(); }

  private send(line: string, signal: AbortSignal | undefined, timeout: number): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('R loading cancelled'));
    clearTimeout(this.idle);
    clearTimeout(this.gc);
    const proc = this.start();
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.proc !== proc) return;
        this.idle = setTimeout(() => this.stop(), IDLE_MS).unref();
        this.scheduleGC(timeout);
      };
      const timer = setTimeout(() => this.stop(new Error('R timed out. Increase rdataView.r.timeoutSeconds.')), timeout);
      const onAbort = () => this.stop(new Error('R loading cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = {
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      };
      proc.stdin.write(line + '\n');
    });
  }

  private scheduleGC(timeout: number): void {
    clearTimeout(this.gc);
    if (!this.needsGC || this.waiter || !this.proc) return;
    this.gc = setTimeout(() => {
      this.needsGC = false;
      // 后台维护请求：不启动已退出的 R；新请求会取消尚未执行的 GC。
      void this.request('\t'.repeat(9) + 'gc', undefined, timeout, false).catch(() => undefined);
    }, GC_IDLE_MS).unref();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn(this.executable, ['--vanilla', '--slave', '-f', this.script], {
      env: { ...process.env, RDATA_LIB: dirname(this.script) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (text: string) => { if (this.proc === proc) this.consume(text); });
    proc.stderr.resume();
    proc.stdin.on('error', () => undefined);
    proc.on('error', () => {
      if (this.proc === proc) this.stop(new Error('R not found. Set rdataView.r.executable to R or arf.'));
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.stop(new Error('R worker exited'));
    });
    this.proc = proc;
    return proc;
  }

  private consume(text: string): void {
    this.buffer += text;
    for (let index; (index = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter?.resolve(line);
    }
  }

  private stop(error = new Error('R worker stopped')): void {
    clearTimeout(this.idle);
    clearTimeout(this.gc);
    this.needsGC = false;
    this.buffer = '';
    const waiter = this.waiter;
    this.waiter = undefined;
    const proc = this.proc;
    this.proc = undefined;
    waiter?.reject(error);
    if (proc) {
      proc.stdin.end();
      proc.kill();
    }
  }
}

let current: { key: string; worker: RWorker } | undefined;

/** 按可执行文件+脚本复用同一个 R 进程。 */
export function runR(
  executable: string, script: string, request: string, signal: AbortSignal | undefined, timeout: number,
): Promise<string> {
  const key = `${executable}\0${script}`;
  if (current?.key !== key) {
    current?.worker.dispose();
    current = { key, worker: new RWorker(executable, script) };
  }
  return current.worker.request(request, signal, timeout);
}

/** 只释放现有进程中的表；回复后再安排空闲 GC，不阻塞文件切换。 */
export async function releaseR(executable: string, script: string, key: string, timeout: number): Promise<void> {
  if (current?.key !== `${executable}\0${script}`) return;
  const worker = current.worker;
  const reply = await worker.request(['', '', '', 0, 0, 0, 0, '', key, 'release'].join('\t'), undefined, timeout, false);
  if (reply !== 'ok') throw new Error(reply.replace(/^error\t/, ''));
  worker.collect(timeout);
}

export function disposeRWorker(): void {
  current?.worker.dispose();
  current = undefined;
}
