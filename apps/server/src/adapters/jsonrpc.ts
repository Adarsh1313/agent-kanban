import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Line-delimited JSON-RPC over a child process's stdio. Messages are sent without "jsonrpc"; both forms are accepted. */
export class JsonRpcProcess {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notificationFns: Array<(method: string, params: any) => void> = [];
  // The third argument is the JSON-RPC id of the incoming request.
  private requestFn: ((method: string, params: any, id: number | string) => Promise<unknown>) | null = null;
  private exitFns: Array<(code: number | null) => void> = [];
  private exited = false;
  private exitCode: number | null = null;

  constructor(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line));
    this.child.stdin!.on('error', () => {});
    this.child.on('error', () => this.handleExit(null));
    this.child.on('close', (code) => this.handleExit(code));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error('process exited'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.exited) this.write({ method, params });
  }

  onNotification(fn: (method: string, params: any) => void): void { this.notificationFns.push(fn); }
  onRequest(fn: (method: string, params: any, id: number | string) => Promise<unknown>): void { this.requestFn = fn; }
  onExit(fn: (code: number | null) => void): void {
    if (this.exited) fn(this.exitCode);
    else this.exitFns.push(fn);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((r) => this.exitFns.push(() => r()));
    this.child.kill();
    await done;
  }

  private write(msg: unknown): void {
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m === null || typeof m !== 'object') return;
    if (typeof m.method === 'string') {
      if (m.id !== undefined) void this.handleServerRequest(m.id, m.method, m.params);
      else for (const fn of this.notificationFns) fn(m.method, m.params);
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message ?? 'request failed'));
    else p.resolve(m.result);
  }

  private async handleServerRequest(id: number | string, method: string, params: any): Promise<void> {
    try {
      if (!this.requestFn) throw new Error('unsupported');
      const result = await this.requestFn(method, params, id);
      if (!this.exited) this.write({ id, result });
    } catch (e) {
      if (!this.exited) this.write({ id, error: { code: -32603, message: e instanceof Error ? e.message : 'failed' } });
    }
  }

  private handleExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    for (const p of this.pending.values()) p.reject(new Error('process exited'));
    this.pending.clear();
    for (const fn of this.exitFns.splice(0)) fn(code);
  }
}
