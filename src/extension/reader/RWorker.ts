import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const IDLE_MS = 60_000;

/**
 * 常驻 R 进程：串行复用同一个解释器，省去每次约 250ms 的启动与包加载。
 * 空闲超时或出错即退出，下次请求重新拉起；不缓存任何数据表，内存与一次性调用持平。
 */
class RWorker {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  private buffer = '';
  private idle: NodeJS.Timeout | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly executable: string, private readonly script: string) {}

  /** 请求一行并等待回复；调用方负责串行化，这里再加一层队列兜底。 */
  request(line: string, signal: AbortSignal | undefined, timeout: number): Promise<string> {
    const task = this.tail.then(() => this.send(line, signal, timeout));
    this.tail = task.catch(() => undefined);
    return task;
  }

  dispose(): void {
    this.stop();
  }

  private send(line: string, signal: AbortSignal | undefined, timeout: number): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('R loading cancelled'));
    const proc = this.start();
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.idle = setTimeout(() => this.stop(), IDLE_MS).unref();
      };
      const timer = setTimeout(() => {
        this.stop();
        reject(new Error('R timed out. Increase rdataView.r.timeoutSeconds.'));
      }, timeout);
      const onAbort = () => {
        this.stop();
        reject(new Error('R loading cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = {
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      };
      proc.stdin.write(line + '\n');
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn(this.executable, ['--vanilla', '--slave', '-f', this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (text: string) => this.consume(text));
    proc.stderr.resume();
    proc.stdin.on('error', () => undefined);
    proc.on('error', () => this.fail('R not found. Set rdataView.r.executable to R or arf.'));
    proc.on('exit', () => this.fail('R worker exited'));
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

  private fail(message: string): void {
    if (this.proc) this.stop();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(new Error(message));
  }

  private stop(): void {
    clearTimeout(this.idle);
    this.buffer = '';
    this.waiter = undefined;
    const proc = this.proc;
    this.proc = undefined;
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

export function disposeRWorker(): void {
  current?.worker.dispose();
  current = undefined;
}
