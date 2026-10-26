import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, ModelOption, UsageReading } from '@agent-kanban/shared';
import type { PingResult, ProviderAdapter } from './adapter.ts';
import { JsonRpcProcess } from './jsonrpc.ts';
import { codexLimitsToReading } from '../usage/parse.ts';

type Listener = (e: AdapterEvent) => void;
const QUIET_MS = 120_000;
/** Codex's "Auto" mode: edits inside the chat's folder, asks before anything outside it. Never danger-full-access. */
const AUTO_MODE = { sandbox: 'workspace-write', approvalPolicy: 'on-request' } as const;
const GAVE_UP = 'Codex keeps stopping. Use Check now to try again.';
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
  private codexHome: string;
  private fallbackModel = new WeakMap<JsonRpcProcess, string | null>();
  private _modelNote: string | null = null;
  // Keep-alive state for automatic (ping-driven) respawns; user actions bypass it.
  private pingTimeoutMs: number;
  private failures = 0; // consecutive failed pings
  private retryAt = 0; // earliest time an automatic ping may respawn
  private gaveUp = false; // too many failures in a row: wait for a manual check
  private crashed = false; // a process died on its own since the last ping noticed
  private closingByUs = new WeakSet<JsonRpcProcess>(); // deliberate recycles: not crashes
  private recycleMarked = new WeakSet<JsonRpcProcess>(); // to be replaced by the next ping or action
  private lastSignedIn: boolean | null = null;
  private claims = new Set<string>(); // threads a startChat/sendMessage is still setting up: they survive a deliberate recycle

  constructor(opts: { codexPath: string; spawn?: (cmd: string, args: string[]) => JsonRpcProcess; initializeTimeoutMs?: number; pingTimeoutMs?: number; codexHome?: string }) {
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 15_000;
    const args = ['app-server'];
    this.codexHome = opts.codexHome ?? join(homedir(), '.codex');
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? 15_000;
    this.makeProcess = () => (opts.spawn ? opts.spawn(opts.codexPath, args) : new JsonRpcProcess(opts.codexPath, args));
  }

  /** Set when the configured Codex model isn't usable with this account and new chats use the default instead. */
  get modelNote(): string | null { return this._modelNote; }

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
    if (this.proc && !this.recycleMarked.has(this.proc)) return Promise.resolve(this.proc);
    if (this.starting) return this.starting;
    const s: Promise<JsonRpcProcess> = this.spawnProcess().finally(() => { if (this.starting === s) this.starting = null; });
    this.starting = s;
    return s;
  }

  /** Replace the app-server at the next ping or action (used when it is stale and nothing is running on it). */
  markForRecycle(): void { if (this.proc) this.recycleMarked.add(this.proc); }

  /** Kill a process we decided to replace; its exit is not a crash. */
  private async recycle(p: JsonRpcProcess): Promise<void> {
    this.closingByUs.add(p);
    if (this.proc === p) this.proc = null;
    await p.close();
  }

  private async spawnProcess(): Promise<JsonRpcProcess> {
    const stale = this.proc;
    if (stale) await this.recycle(stale); // it timed out earlier: alive but stuck
    if (this.disposed) throw new Error('Codex adapter is shut down.');
    const p = this.makeProcess();
    this.loaded.set(p, new Set());
    this.startingProc = p;
    p.onNotification((method, params) => this.onNotification(method, params));
    p.onRequest((method, params, id) => this.onServerRequest(method, params, id));
    p.onExit(() => this.onProcessExit(p));
    try {
      await p.request('initialize', { clientInfo: { name: 'agent-kanban', title: 'Agent Kanban', version: '0.0.0' } }, this.initializeTimeoutMs);
      p.notify('initialized');
      await this.pickModel(p);
      if (this.disposed) throw new Error('Codex adapter is shut down.');
      this.proc = p;
      return p;
    } catch (e) {
      this.closingByUs.add(p);
      await p.close();
      throw e;
    } finally {
      this.startingProc = null;
    }
  }

  /** Read-only: compare ~/.codex/config.toml's model with what the account can use. Any failure keeps Codex's own default. */
  private async pickModel(p: JsonRpcProcess): Promise<void> {
    this.fallbackModel.set(p, null);
    this._modelNote = null;
    try {
      let configured: string | null = null;
      try {
        // Only the top-level keys, i.e. the text before the first [table] header.
        const text = readFileSync(join(this.codexHome, 'config.toml'), 'utf8');
        const top = text.split(/^\s*\[/m)[0] ?? '';
        configured = /^model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
      } catch { /* no config file */ }
      if (!configured) return;
      type Model = { id: string; model: string; isDefault: boolean };
      const list: Model[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const r: { data: Model[]; nextCursor?: string | null } = await p.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }, this.initializeTimeoutMs);
        list.push(...r.data);
        if (list.some((m) => m.id === configured || m.model === configured)) return;
        cursor = r.nextCursor ?? null;
        if (!cursor) break;
      }
      if (list.some((m) => m.id === configured || m.model === configured)) { this._modelNote = null; return; }
      const def = list.find((m) => m.isDefault);
      if (!def) return;
      this.fallbackModel.set(p, def.model);
      this._modelNote = `Your Codex settings use ${configured}, which your account can't use, so new chats use ${def.model}.`;
    } catch { /* keep current behavior */ }
  }

  /** The fallback model for threads started or resumed without an explicit one. */
  private modelParam(p: JsonRpcProcess): { model?: string } {
    const m = this.fallbackModel.get(p);
    return m ? { model: m } : {};
  }

  private onProcessExit(p: JsonRpcProcess): void {
    if (this.proc === p) this.proc = null;
    if (this.disposed) return;
    if (!this.closingByUs.has(p)) this.crashed = true;
    const deliberate = this.closingByUs.has(p);
    // On a deliberate recycle, a thread whose turn is still being set up by the caller keeps its claim and queued stop.
    const threads = [...this.activeTurns.keys()].filter((t) => !(deliberate && this.claims.has(t)));
    for (const t of threads) { this.activeTurns.delete(t); this.pendingStops.delete(t); }
    for (const [id, a] of this.approvals) {
      if (threads.includes(a.threadId)) { a.resolve('decline'); this.approvals.delete(id); }
    }
    const last = p.stderrTail[p.stderrTail.length - 1];
    const message = deliberate
      ? 'Codex stopped responding and was restarted. Resume to continue.'
      : last ? `Codex stopped unexpectedly. (${last})` : 'Codex stopped unexpectedly.';
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
      this.emit({ type: 'request.opened', sessionRef: params.threadId, requestId, kind: 'permission', summary, action: isCommand ? 'command' : 'edit' });
    });
  }

  async startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }> {
    const p = await this.ensureProcess();
    const r = await p.request<{ thread: { id: string } }>('thread/start', { cwd: input.cwd, model: input.model ?? this.fallbackModel.get(p) ?? null, ...AUTO_MODE });
    const sessionRef = r.thread.id;
    this.threadCwd.set(sessionRef, input.cwd);
    this.loaded.get(p)?.add(sessionRef);
    this.emit({ type: 'session.started', sessionRef });
    this.claims.add(sessionRef);
    try { await this.startTurn(p, sessionRef, input.prompt); } finally { this.claims.delete(sessionRef); }
    return { sessionRef };
  }

  async sendMessage(sessionRef: string, text: string): Promise<void> {
    // Claim the turn before respawning/re-attaching, so a stop() that arrives meanwhile is queued, not dropped.
    const owned = !this.activeTurns.has(sessionRef);
    if (owned) this.activeTurns.set(sessionRef, null);
    this.claims.add(sessionRef);
    try {
      const p = await this.ensureProcess();
      await this.attach(p, sessionRef);
      await this.startTurn(p, sessionRef, text, owned);
    } catch (e) {
      if (owned) { this.activeTurns.delete(sessionRef); this.pendingStops.delete(sessionRef); }
      throw e;
    } finally {
      this.claims.delete(sessionRef);
    }
  }

  /** A fresh process (after a crash) doesn't know our threads yet: resume before using one. */
  private async attach(p: JsonRpcProcess, sessionRef: string): Promise<void> {
    const known = this.loaded.get(p);
    if (known?.has(sessionRef)) return;
    const cwd = this.threadCwd.get(sessionRef);
    await p.request('thread/resume', { threadId: sessionRef, ...(cwd ? { cwd } : {}), ...this.modelParam(p), ...AUTO_MODE });
    known?.add(sessionRef);
  }

  private async startTurn(p: JsonRpcProcess, sessionRef: string, text: string, owned = !this.activeTurns.has(sessionRef)): Promise<void> {
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
    await p.request('thread/resume', { threadId: sessionRef, cwd, ...this.modelParam(p), ...AUTO_MODE });
    this.loaded.get(p)?.add(sessionRef);
  }

  async listModels(): Promise<ModelOption[]> {
    // Like the usage poll, the model list does not respawn a crash-looping app-server.
    if (this.inBackoff()) return [];
    const p = await this.ensureProcess();
    type Model = { id: string; model?: string; displayName?: string; isDefault?: boolean; hidden?: boolean };
    const out: ModelOption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: { data: Model[]; nextCursor?: string | null } = await p.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }, this.initializeTimeoutMs);
      for (const m of r.data) if (!m.hidden) out.push({ id: m.model || m.id, label: m.displayName || m.model || m.id, isDefault: m.isDefault === true });
      cursor = r.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async readUsage(): Promise<UsageReading> {
    const failed: UsageReading = { provider: 'codex', status: 'error', windows: [], readAt: new Date().toISOString(), message: "Couldn't read Codex usage." };
    // A crash-looping app-server is not respawned by the usage poll: it waits for the ping backoff (or a manual check).
    if (this.inBackoff()) return failed;
    try {
      const p = await this.ensureProcess();
      const r = await p.request<{ rateLimits: any; rateLimitsByLimitId?: any }>('account/rateLimits/read', undefined);
      return codexLimitsToReading(r, new Date());
    } catch {
      return failed;
    }
  }

  /** No app-server is running or starting, and the ping backoff (or giving up) says not to spawn one for background reads. */
  private inBackoff(): boolean {
    return !this.proc && !this.starting && (this.gaveUp || Date.now() < this.retryAt);
  }

  private noteFailure(): void {
    this.failures++;
    if (this.failures > 3) this.gaveUp = true;
    this.retryAt = Date.now() + Math.min(1000 * 2 ** (this.failures - 1), 60_000);
  }

  /** True when no turn is running on the app-server. */
  isIdle(): boolean { return this.activeTurns.size === 0; }

  /** Recycle the app-server when nothing is running on it (e.g. after Codex was updated). Returns whether it did. */
  async restartIfIdle(): Promise<boolean> {
    const p = this.proc;
    if (!p || this.starting) return true; // nothing old to replace
    if (this.activeTurns.size > 0) return false;
    await this.recycle(p);
    return true;
  }

  /**
   * Health check: `account/read` on the running app-server. Automatic pings that find it dead respawn it
   * with a 1 s, 2 s, 4 s ... (max 60 s) backoff and stop trying after a few failures in a row; a manual
   * ping always tries once (and asks Codex to refresh its sign-in). User actions (startChat etc.) never
   * wait for the backoff.
   *
   * A request that times out only makes the process suspect. It is replaced when the next probe also
   * times out and either nothing is running on it or it has been silent for 2 minutes.
   */
  async ping(opts: { manual?: boolean } = {}): Promise<PingResult> {
    const manual = opts.manual === true;
    const fail = (message?: string): PingResult => ({ ok: false, signedIn: null, ...(message ? { message } : {}) });
    if (this.disposed) return fail('Codex adapter is shut down.');
    if (manual) { this.failures = 0; this.retryAt = 0; this.gaveUp = false; this.crashed = false; }
    const marked = this.proc;
    if (marked && this.recycleMarked.has(marked)) await this.recycle(marked);
    if (this.crashed) {
      // Report a crash once, even if a user action or usage read already restarted it, so the status shows it.
      this.crashed = false;
      const down = !this.proc && !this.starting;
      if (down) this.noteFailure();
      return fail(down ? 'Codex stopped unexpectedly.' : 'Codex stopped unexpectedly and was restarted.');
    }
    if (!this.proc && !this.starting) {
      if (this.gaveUp) return { ...fail(GAVE_UP), gaveUp: true };
      if (Date.now() < this.retryAt) return fail('Codex is restarting.');
    }
    let p: JsonRpcProcess | null = null;
    let wasSuspect = false;
    let probeAt = 0;
    try {
      p = await this.ensureProcess();
      wasSuspect = p.suspect;
      probeAt = Date.now();
      const r = await p.request<{ account: unknown | null }>('account/read', { refreshToken: manual }, this.pingTimeoutMs);
      p.clearSuspect();
      this.failures = 0; this.retryAt = 0; this.gaveUp = false;
      this.lastSignedIn = r?.account != null;
      return { ok: true, signedIn: this.lastSignedIn, ...(this._modelNote ? { message: this._modelNote } : {}) };
    } catch (e) {
      this.crashed = false; // this failure is counted here, not again by the next ping
      if (p && /timed out/.test(e instanceof Error ? e.message : '')) {
        // Busy on a running turn and still sending notifications: it is alive, just not answering this probe.
        // Heard from it during the probe, or busy on a running turn: alive, just not answering this probe.
        const heardDuringProbe = p.lastNotificationAt > probeAt;
        if (heardDuringProbe || (this.activeTurns.size > 0 && Date.now() - p.lastNotificationAt < QUIET_MS)) {
          return { ok: true, signedIn: this.lastSignedIn };
        }
        if (wasSuspect) await this.recycle(p);
      }
      this.noteFailure();
      return fail();
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
