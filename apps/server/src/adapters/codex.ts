import type { AdapterEvent, UsageReading } from '@agent-kanban/shared';
import type { ProviderAdapter } from './adapter.ts';
import { JsonRpcProcess } from './jsonrpc.ts';
import { codexLimitsToReading } from '../usage/parse.ts';

type Listener = (e: AdapterEvent) => void;
type Approval = { threadId: string; resolve: (decision: 'accept' | 'decline') => void };

/**
 * Signals Task 8 can rely on when the app-server dies:
 * - A chat that has a turn in progress gets an `error` event ("Codex stopped unexpectedly.").
 * - A call that is itself in flight when the crash happens (e.g. startChat's thread/start or turn/start)
 *   REJECTS; no error event is emitted for it because the chat has no running turn registered yet
 *   (or, if turn/start was already sent, both the rejection and the error event may occur).
 *   Task 8 should treat a startChat/sendMessage rejection as the failure signal for that call.
 */
export class CodexAdapter implements ProviderAdapter {
  id = 'codex' as const;
  private listeners = new Set<Listener>();
  private proc: JsonRpcProcess | null = null;
  private starting: Promise<JsonRpcProcess> | null = null;
  private startingProc: JsonRpcProcess | null = null;
  private activeTurns = new Map<string, string | null>(); // threadId -> turnId (null until known)
  private pendingStops = new Set<string>();
  private approvals = new Map<string, Approval>();
  private threadCwd = new Map<string, string>();
  private loaded = new WeakMap<JsonRpcProcess, Set<string>>(); // threads known to each process
  private disposed = false;
  private makeProcess: () => JsonRpcProcess;
  private initializeTimeoutMs: number;

  constructor(opts: { codexPath: string; spawn?: (cmd: string, args: string[]) => JsonRpcProcess; initializeTimeoutMs?: number }) {
    const args = ['app-server'];
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? 15_000;
    this.makeProcess = () => (opts.spawn ? opts.spawn(opts.codexPath, args) : new JsonRpcProcess(opts.codexPath, args));
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(e: AdapterEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  /** Returns the live app-server, spawning (and initializing) one if none is running. Task 10's ping() can reuse this. */
  private ensureProcess(): Promise<JsonRpcProcess> {
    if (this.disposed) return Promise.reject(new Error('Codex adapter is shut down.'));
    if (this.proc) return Promise.resolve(this.proc);
    if (this.starting) return this.starting;
    const p = this.makeProcess();
    this.loaded.set(p, new Set());
    this.startingProc = p;
    p.onNotification((method, params) => this.onNotification(method, params));
    p.onRequest((method, params, id) => this.onServerRequest(method, params, id));
    p.onExit(() => this.onProcessExit(p));
    this.starting = (async () => {
      try {
        await p.request('initialize', { clientInfo: { name: 'agent-kanban', title: 'Agent Kanban', version: '0.0.0' } }, this.initializeTimeoutMs);
        p.notify('initialized');
        if (this.disposed) throw new Error('Codex adapter is shut down.');
        this.proc = p;
        return p;
      } catch (e) {
        await p.close();
        throw e;
      } finally {
        this.starting = null;
        this.startingProc = null;
      }
    })();
    return this.starting;
  }

  private onProcessExit(p: JsonRpcProcess): void {
    if (this.proc === p) this.proc = null;
    if (this.disposed) return;
    const threads = [...this.activeTurns.keys()];
    this.activeTurns.clear();
    this.pendingStops.clear();
    for (const a of this.approvals.values()) a.resolve('decline');
    this.approvals.clear();
    const last = p.stderrTail[p.stderrTail.length - 1];
    const message = last ? `Codex stopped unexpectedly. (${last})` : 'Codex stopped unexpectedly.';
    for (const sessionRef of threads) this.emit({ type: 'error', sessionRef, message });
  }

  private endTurn(threadId: string): void {
    this.activeTurns.delete(threadId);
    this.pendingStops.delete(threadId);
    for (const [id, a] of this.approvals) {
      if (a.threadId === threadId) { a.resolve('decline'); this.approvals.delete(id); }
    }
  }

  private setTurnId(p: JsonRpcProcess, threadId: string, turnId: string): void {
    if (!this.activeTurns.has(threadId)) return;
    this.activeTurns.set(threadId, turnId);
    if (this.pendingStops.delete(threadId)) {
      p.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    }
  }

  private onNotification(method: string, params: any): void {
    const sessionRef: string | undefined = params?.threadId;
    switch (method) {
      case 'turn/started':
        if (!sessionRef) return;
        if (!this.activeTurns.has(sessionRef)) this.activeTurns.set(sessionRef, null);
        if (this.proc && params.turn?.id) this.setTurnId(this.proc, sessionRef, params.turn.id);
        this.emit({ type: 'turn.started', sessionRef });
        return;
      case 'item/agentMessage/delta':
        if (!sessionRef) return;
        this.emit({ type: 'message.delta', sessionRef, messageId: params.itemId, text: params.delta });
        return;
      case 'item/started':
      case 'item/completed': {
        if (!sessionRef) return;
        const item = params.item;
        const done = method === 'item/completed';
        if (item?.type === 'agentMessage' && done) {
          this.emit({ type: 'message.completed', sessionRef, messageId: item.id, role: 'assistant', text: item.text });
        } else if (item?.type === 'commandExecution') {
          this.emit({ type: 'tool.call', sessionRef, toolCallId: item.id, name: 'command', summary: `Running ${item.command}`, status: toolStatus(done, item.status) });
        } else if (item?.type === 'fileChange') {
          this.emit({ type: 'tool.call', sessionRef, toolCallId: item.id, name: 'edit', summary: `Editing ${item.changes?.[0]?.path ?? 'files'}`, status: toolStatus(done, item.status) });
        }
        return;
      }
      case 'turn/completed': {
        if (!sessionRef) return;
        this.endTurn(sessionRef);
        const status = params.turn?.status;
        if (status === 'completed') this.emit({ type: 'turn.completed', sessionRef });
        else if (status === 'interrupted') this.emit({ type: 'stopped', sessionRef });
        else if (status === 'failed') this.emit({ type: 'error', sessionRef, message: params.turn?.error?.message ?? 'Codex ran into a problem.' });
        return;
      }
      case 'account/rateLimits/updated': {
        const snap = params?.rateLimits;
        if (!snap?.rateLimitReachedType) return;
        const reset = snap.primary?.resetsAt ?? snap.secondary?.resetsAt;
        const resetsAt = typeof reset === 'number' ? new Date(reset * 1000).toISOString() : undefined;
        for (const ref of this.activeTurns.keys()) {
          this.emit(resetsAt ? { type: 'limit.reached', sessionRef: ref, resetsAt } : { type: 'limit.reached', sessionRef: ref });
        }
        return;
      }
    }
  }

  private onServerRequest(method: string, params: any, id: number | string): Promise<unknown> {
    const isCommand = method === 'item/commandExecution/requestApproval';
    if (!isCommand && method !== 'item/fileChange/requestApproval') return Promise.reject(new Error('unsupported request'));
    const requestId = String(id);
    const summary: string = isCommand ? (params.command ?? params.reason ?? 'Run a command') : (params.reason ?? 'Edit files');
    return new Promise((resolve) => {
      this.approvals.set(requestId, { threadId: params.threadId, resolve: (decision) => resolve({ decision }) });
      this.emit({ type: 'request.opened', sessionRef: params.threadId, requestId, kind: 'permission', summary });
    });
  }

  async startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }> {
    const p = await this.ensureProcess();
    const r = await p.request<{ thread: { id: string } }>('thread/start', { cwd: input.cwd, model: input.model ?? null, approvalPolicy: 'on-request' });
    const sessionRef = r.thread.id;
    this.threadCwd.set(sessionRef, input.cwd);
    this.loaded.get(p)?.add(sessionRef);
    this.emit({ type: 'session.started', sessionRef });
    await this.startTurn(p, sessionRef, input.prompt);
    return { sessionRef };
  }

  async sendMessage(sessionRef: string, text: string): Promise<void> {
    const p = await this.ensureProcess();
    await this.attach(p, sessionRef);
    await this.startTurn(p, sessionRef, text);
  }

  /** A fresh process (after a crash) doesn't know our threads yet: resume before using one. */
  private async attach(p: JsonRpcProcess, sessionRef: string): Promise<void> {
    const known = this.loaded.get(p);
    if (known?.has(sessionRef)) return;
    const cwd = this.threadCwd.get(sessionRef);
    await p.request('thread/resume', cwd ? { threadId: sessionRef, cwd } : { threadId: sessionRef });
    known?.add(sessionRef);
  }

  private async startTurn(p: JsonRpcProcess, sessionRef: string, text: string): Promise<void> {
    const owned = !this.activeTurns.has(sessionRef);
    if (owned) this.activeTurns.set(sessionRef, null);
    try {
      const r = await p.request<{ turn: { id: string } }>('turn/start', { threadId: sessionRef, input: [{ type: 'text', text }] });
      this.setTurnId(p, sessionRef, r.turn.id);
    } catch (e) {
      if (owned) { this.activeTurns.delete(sessionRef); this.pendingStops.delete(sessionRef); }
      throw e;
    }
  }

  /**
   * Codex approvals have no reply text, so { reply } is treated as a plain deny.
   */
  async respondToRequest(_sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void> {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    a.resolve(decision === 'allow' ? 'accept' : 'decline');
  }

  async stop(sessionRef: string): Promise<void> {
    if (!this.activeTurns.has(sessionRef)) return;
    const turnId = this.activeTurns.get(sessionRef);
    if (!turnId) {
      // The turn id isn't known yet; interrupt as soon as it arrives.
      this.pendingStops.add(sessionRef);
      return;
    }
    const p = await this.ensureProcess();
    await p.request('turn/interrupt', { threadId: sessionRef, turnId });
  }

  async resume(sessionRef: string, cwd: string): Promise<void> {
    const p = await this.ensureProcess();
    this.threadCwd.set(sessionRef, cwd);
    await p.request('thread/resume', { threadId: sessionRef, cwd });
    this.loaded.get(p)?.add(sessionRef);
  }

  async readUsage(): Promise<UsageReading> {
    try {
      const p = await this.ensureProcess();
      const r = await p.request<{ rateLimits: any; rateLimitsByLimitId?: any }>('account/rateLimits/read', undefined);
      return codexLimitsToReading(r, new Date());
    } catch {
      return { provider: 'codex', status: 'error', windows: [], readAt: new Date().toISOString(), message: "Couldn't read Codex usage." };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    this.approvals.clear();
    this.activeTurns.clear();
    this.pendingStops.clear();
    const starting = this.starting;
    const p = this.proc ?? this.startingProc;
    this.proc = null;
    await p?.close();
    await starting?.catch(() => {});
  }
}

function toolStatus(done: boolean, status: unknown): 'running' | 'done' | 'failed' {
  if (!done) return 'running';
  return status === 'failed' || status === 'declined' ? 'failed' : 'done';
}
