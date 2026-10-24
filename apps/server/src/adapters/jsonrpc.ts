import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveSpawnTarget } from './spawn-target.ts';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_CAP_MS = 5_000;
const KILL_ESCALATE_MS = 3_000;
const EXIT_GRACE_MS = 100;
const STDERR_LINES = 20;

/**
 * Line-delimited JSON-RPC over a child process's stdio. By default messages are sent without "jsonrpc" (Codex);
 * `{ jsonrpc: '2.0' }` adds the field to every outgoing message (ACP). Both forms are accepted on input.
 * Stdout lines that are not JSON objects go to `onTextLine` listeners and never break framing.
 */
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
  private stderrRing: string[] = [];
  private defaultTimeoutMs: number;
  private timedOut = false;
  private lastNoteAt = Date.now();
  private taskkill: ((pid: number) => ChildProcess) | undefined;
  private jsonrpc: '2.0' | undefined;
  private textLineFns: Array<(line: string) => void> = [];

  constructor(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number; taskkill?: (pid: number) => ChildProcess; jsonrpc?: '2.0' } = {}) {
    this.taskkill = opts.taskkill;
    this.jsonrpc = opts.jsonrpc;
    this.defaultTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const target = resolveSpawnTarget(command);
    this.child = spawn(target.command, [...target.args, ...args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr! }).on('line', (line) => {
      if (!line.trim()) return;
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_LINES) this.stderrRing.shift();
    });
    this.child.stdin!.on('error', () => {});
    this.child.on('error', () => this.handleExit(null));
    // 'exit' can fire before the last stdout lines are read; give 'close' a moment to arrive first.
    // (If a grandchild keeps the pipes open, 'close' never comes and this timer finishes the job.)
    this.child.on('exit', (code) => setTimeout(() => this.handleExit(code), EXIT_GRACE_MS));
    this.child.on('close', (code) => this.handleExit(code));
  }

  /** The last lines the process wrote to stderr (at most 20). */
  get stderrTail(): string[] { return [...this.stderrRing]; }

  /** True after a request timed out and nothing has been heard since: alive but possibly stuck. Any notification clears it. */
  get suspect(): boolean { return this.timedOut; }
  clearSuspect(): void { this.timedOut = false; }
  /** When the process last sent a notification (or when it was started). */
  get lastNotificationAt(): number { return this.lastNoteAt; }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.exited) return Promise.reject(new Error('process exited'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timedOut = true;
        reject(new Error(`${method} timed out`));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.exited) this.write({ method, params });
  }

  onNotification(fn: (method: string, params: any) => void): void { this.notificationFns.push(fn); }
  onRequest(fn: (method: string, params: any, id: number | string) => Promise<unknown>): void { this.requestFn = fn; }
  /** Called with each non-empty stdout line that is not a JSON object (e.g. a sign-in link printed as plain text). */
  onTextLine(fn: (line: string) => void): void { this.textLineFns.push(fn); }
  onExit(fn: (code: number | null) => void): void {
    if (this.exited) fn(this.exitCode);
    else this.exitFns.push(fn);
  }

  /** Kills the process tree and resolves once it has exited, or after a 5 s cap. Never rejects. */
  async close(): Promise<void> {
    if (this.exited) return;
    let cap: NodeJS.Timeout | undefined;
    let escalate: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve) => {
      this.exitFns.push(() => resolve());
      cap = setTimeout(resolve, CLOSE_CAP_MS);
    });
    this.killTree();
    if (process.platform !== 'win32') {
      escalate = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_ESCALATE_MS);
    }
    await done;
    clearTimeout(cap);
    clearTimeout(escalate);
  }

  private killTree(): void {
    const pid = this.child.pid;
    if ((process.platform === 'win32' || this.taskkill) && pid !== undefined) {
      try {
        const k = this.taskkill ? this.taskkill(pid) : spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        const fallback = () => { try { this.child.kill(); } catch { /* already gone */ } };
        k.on('error', fallback);
        k.on('exit', (code) => { if (code !== 0) fallback(); });
        return;
      } catch { /* fall through */ }
    }
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private write(msg: object): void {
    const framed = this.jsonrpc ? { jsonrpc: this.jsonrpc, ...msg } : msg;
    this.child.stdin!.write(JSON.stringify(framed) + '\n');
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let m: any;
    try { m = JSON.parse(line); } catch { m = undefined; }
    if (m === null || typeof m !== 'object') { this.emitText(line); return; }
    if (typeof m.method === 'string') {
      if (m.id !== undefined) void this.handleServerRequest(m.id, m.method, m.params);
      else { this.lastNoteAt = Date.now(); this.timedOut = false; for (const fn of this.notificationFns) fn(m.method, m.params); }
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(m.error.message ?? 'request failed'), { code: m.error.code }));
    else p.resolve(m.result);
  }

  private emitText(line: string): void {
    for (const fn of this.textLineFns) { try { fn(line); } catch { /* a listener's bug must not break framing */ } }
  }

  private async handleServerRequest(id: number | string, method: string, params: any): Promise<void> {
    this.lastNoteAt = Date.now(); this.timedOut = false; // a request from the server is a sign of life too
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
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('process exited')); }
    this.pending.clear();
    for (const fn of this.exitFns.splice(0)) fn(code);
  }
}
