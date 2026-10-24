// Antigravity adapter: drives Google's official agy_acp_server over ACP (JSON-RPC 2.0 on stdio).
//
// What the real agy_acp_server 1.3.0 does (checked on Windows, Task 3):
// - It is a PyInstaller one-file bundle: every launch unpacks ~200-330 MB into the temp folder and takes
//   ~40 s before it answers `initialize`; a force kill leaves that folder behind. So one long-lived process
//   is kept, pings never respawn a crash-looping one, and the temp folder is ours and swept (see spawnAntigravity).
// - stdout carries only JSON-RPC; its logs, and the sign-in link, go to stderr.
// - `initialize` sends no "authenticated" flag and always lists its auth methods ("oauth-personal" first).
//   Whether a sign-in method is selected is in <GEMINI_HOME>/antigravity-acp/settings.json `auth.type`
//   (the agent writes it after `authenticate`); without one, session/new fails -32000 "Authentication required".
//   If a method is selected but its login is gone, session/new starts the browser sign-in instead: the
//   adapter treats an unasked-for sign-in link as "signed out" and restarts the process to end that flow.
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterEvent, ModelOption, UsageReading } from '@agent-kanban/shared';
import type { PingResult, ProviderAdapter } from './adapter.ts';
import { JsonRpcProcess } from './jsonrpc.ts';
import { AcpClient, AUTH_REQUIRED_CODE } from './acp.ts';
import type { AcpInitializeResult, AcpPermissionDecision, AcpPermissionOption, AcpPermissionRequest, AcpStopReason } from './acp.ts';

type Listener = (e: AdapterEvent) => void;
type SpawnFn = (cmd: string, args: string[]) => JsonRpcProcess;

export const ANTIGRAVITY_CRASHED = 'Antigravity stopped unexpectedly.';
const RESTARTED = 'Antigravity stopped responding and was restarted. Resume to continue.';
const GAVE_UP = 'Antigravity keeps stopping. Use Check now to try again.';
export const ANTIGRAVITY_SIGNED_OUT = "Antigravity isn't signed in.";
const BUSY = 'Antigravity is still working on the last message. Wait for it to finish, or stop it first.';
const NO_LIMITS = "Antigravity doesn't report its limits.";
const QUIET_MS = 120_000;
// Startup is slow (see above): requests get a generous default; pings their own short timeout.
const REQUEST_TIMEOUT_MS = 180_000;

interface Live {
  proc: JsonRpcProcess;
  acp: AcpClient;
  init: AcpInitializeResult;
  /** Sessions this process knows (created or loaded on it). */
  sessions: Set<string>;
  /** Learned on this process: true after a sign-in, false after "Authentication required". */
  authed: boolean | null;
}

interface Turn { live: Live; messageId: string; text: string[]; started: boolean }
interface Perm { sessionId: string; options: AcpPermissionOption[]; resolve: (d: AcpPermissionDecision) => void }

export interface AntigravityAdapterOptions {
  exePath: string;
  /** Tests: start a fake agent instead. */
  spawn?: SpawnFn;
  pingTimeoutMs?: number;
  /** Where the agent keeps settings.json (default $GEMINI_HOME or ~/.gemini). */
  geminiHome?: string;
  /** The temp folder the agent unpacks into (default <install root>/tmp). */
  tempDir?: string;
}

export class AntigravityAdapter implements ProviderAdapter {
  id = 'antigravity' as const;
  private listeners = new Set<Listener>();
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  private startingProc: JsonRpcProcess | null = null;
  private makeProcess: () => JsonRpcProcess;
  private pingTimeoutMs: number;
  private geminiHome: string;
  private disposed = false;
  private turns = new Map<string, Turn>(); // sessionId -> running turn
  private turnCount = new Map<string, number>();
  private loading = new Set<string>(); // session/load in progress: its history replay is not a new turn
  private sessionCwd = new Map<string, string>();
  private perms = new Map<string, Perm>();
  private permCounter = 0;
  private toolInfo = new Map<string, { title: string; kind: string }>();
  private closingByUs = new WeakSet<JsonRpcProcess>();
  private recycleMarked = new WeakSet<JsonRpcProcess>();
  private authUrlFn: ((url: string) => void) | null = null;
  private signInLive: Live | null = null;
  private lastVersion: string | null = null;
  // Keep-alive state for automatic (ping-driven) respawns, as in the Codex adapter.
  private failures = 0;
  private retryAt = 0;
  private gaveUp = false;
  private crashed = false;

  constructor(opts: AntigravityAdapterOptions) {
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 15_000;
    this.geminiHome = opts.geminiHome ?? (process.env.GEMINI_HOME || join(homedir(), '.gemini'));
    const tempDir = opts.tempDir ?? join(dirname(dirname(opts.exePath)), 'tmp');
    this.makeProcess = opts.spawn ? () => opts.spawn!(opts.exePath, []) : () => spawnAntigravity(opts.exePath, tempDir);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(e: AdapterEvent): void {
    for (const l of [...this.listeners]) { try { l(e); } catch { /* a listener's bug must not break the adapter */ } }
  }

  // ---- process lifecycle ----

  private ensureProcess(): Promise<Live> {
    if (this.disposed) return Promise.reject(new Error('Antigravity adapter is shut down.'));
    if (this.live && !this.recycleMarked.has(this.live.proc)) return Promise.resolve(this.live);
    if (this.starting) return this.starting;
    const s: Promise<Live> = this.spawnProcess().finally(() => { if (this.starting === s) this.starting = null; });
    this.starting = s;
    return s;
  }

  private async recycle(live: Live): Promise<void> {
    this.closingByUs.add(live.proc);
    if (this.live === live) this.live = null;
    await live.proc.close();
  }

  private async spawnProcess(): Promise<Live> {
    const stale = this.live;
    if (stale) await this.recycle(stale);
    if (this.disposed) throw new Error('Antigravity adapter is shut down.');
    const proc = this.makeProcess();
    this.startingProc = proc;
    const acp = new AcpClient(proc);
    const live: Live = { proc, acp, init: { protocolVersion: 1, authMethods: [], authenticated: null }, sessions: new Set(), authed: null };
    acp.onUpdate((sid, u) => this.onUpdate(sid, u));
    acp.onPermission((sid, req) => this.onPermission(sid, req));
    acp.onAuthUrl((url) => {
      if (this.authUrlFn && this.signInLive === live) this.authUrlFn(url);
      else this.unaskedSignIn(live);
    });
    proc.onExit(() => this.onProcessExit(live));
    try {
      live.init = await acp.initialize();
      if (live.init.agentInfo?.version) this.lastVersion = live.init.agentInfo.version;
      if (this.disposed) throw new Error('Antigravity adapter is shut down.');
      this.live = live;
      return live;
    } catch (e) {
      this.closingByUs.add(proc);
      await proc.close();
      throw e;
    } finally {
      this.startingProc = null;
    }
  }

  /** A sign-in link nobody asked for: the selected login is gone and session/new started a browser sign-in. */
  private unaskedSignIn(live: Live): void {
    live.authed = false;
    void this.recycle(live).catch(() => {});
  }

  private onProcessExit(live: Live): void {
    if (this.live === live) this.live = null;
    if (this.disposed) return;
    const deliberate = this.closingByUs.has(live.proc);
    if (!deliberate) this.crashed = true;
    for (const [sid, turn] of [...this.turns]) {
      if (turn.live !== live) continue;
      this.turns.delete(sid);
      this.settlePerms(sid);
      // An unasked-for sign-in is reported by the call that triggered it, not as a crash.
      if (live.authed === false && deliberate) this.emit({ type: 'error', sessionRef: sid, message: ANTIGRAVITY_SIGNED_OUT });
      else this.emit({ type: 'error', sessionRef: sid, message: deliberate ? RESTARTED : ANTIGRAVITY_CRASHED });
    }
  }

  /** Signed in? The agent's flag if it gives one, what this process learned, else the selected sign-in method. */
  private signedInOf(live: Live): boolean | null {
    if (live.authed !== null) return live.authed;
    if (live.init.authenticated !== null) return live.init.authenticated;
    return this.authTypeSelected();
  }

  /** Reads only `auth.type` from the agent's settings.json (never its credential store). */
  private authTypeSelected(): boolean {
    try {
      const s = JSON.parse(readFileSync(join(this.geminiHome, 'antigravity-acp', 'settings.json'), 'utf8'));
      return typeof s?.auth?.type === 'string' && s.auth.type.trim() !== '';
    } catch { return false; }
  }

  // ---- ACP events ----

  private onUpdate(sessionId: string, u: any): void {
    if (this.loading.has(sessionId)) return;
    const turn = this.turns.get(sessionId);
    if (!turn || !u || typeof u !== 'object') return;
    if (!turn.started) {
      turn.started = true;
      this.emit({ type: 'turn.started', sessionRef: sessionId });
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.type === 'text' ? u.content.text : undefined;
        if (typeof text !== 'string' || text === '') return;
        turn.text.push(text);
        this.emit({ type: 'message.delta', sessionRef: sessionId, messageId: turn.messageId, text });
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (typeof u.toolCallId !== 'string') return;
        const known = this.toolInfo.get(u.toolCallId);
        const title = typeof u.title === 'string' && u.title ? u.title : known?.title ?? 'Using a tool';
        const kind = typeof u.kind === 'string' && u.kind ? u.kind : known?.kind ?? 'tool';
        this.toolInfo.set(u.toolCallId, { title, kind });
        this.emit({ type: 'tool.call', sessionRef: sessionId, toolCallId: u.toolCallId, name: kind, summary: title, status: toolStatus(u.status) });
        return;
      }
    }
  }

  private onPermission(sessionId: string, req: AcpPermissionRequest): Promise<AcpPermissionDecision> {
    const requestId = `perm_${++this.permCounter}`;
    const tc = req.toolCall;
    const known = typeof tc?.toolCallId === 'string' ? this.toolInfo.get(tc.toolCallId) : undefined;
    const summary = typeof tc?.title === 'string' && tc.title ? tc.title : known?.title ?? 'Use a tool';
    return new Promise((resolve) => {
      this.perms.set(requestId, { sessionId, options: req.options, resolve });
      this.emit({ type: 'request.opened', sessionRef: sessionId, requestId, kind: 'permission', summary });
    });
  }

  private settlePerms(sessionId: string): void {
    for (const [id, p] of [...this.perms]) {
      if (p.sessionId !== sessionId) continue;
      this.perms.delete(id);
      p.resolve('cancelled');
    }
  }

  // ---- turns ----

  private runTurn(live: Live, sessionId: string, text: string): void {
    const n = (this.turnCount.get(sessionId) ?? 0) + 1;
    this.turnCount.set(sessionId, n);
    const turn: Turn = { live, messageId: `${sessionId}:${n}`, text: [], started: false };
    this.turns.set(sessionId, turn);
    live.acp.prompt(sessionId, text).then(
      ({ stopReason }) => this.finishTurn(sessionId, turn, stopReason),
      (err) => this.failTurn(sessionId, turn, err),
    );
  }

  private finishTurn(sessionId: string, turn: Turn, stopReason: AcpStopReason): void {
    if (this.turns.get(sessionId) !== turn) return;
    this.turns.delete(sessionId);
    this.settlePerms(sessionId);
    if (turn.text.length > 0) {
      this.emit({ type: 'message.completed', sessionRef: sessionId, messageId: turn.messageId, role: 'assistant', text: turn.text.join('') });
    }
    if (stopReason === 'cancelled') this.emit({ type: 'stopped', sessionRef: sessionId });
    else this.emit({ type: 'turn.completed', sessionRef: sessionId });
  }

  private failTurn(sessionId: string, turn: Turn, err: unknown): void {
    if (this.turns.get(sessionId) !== turn) return; // a process exit already reported it
    this.turns.delete(sessionId);
    this.settlePerms(sessionId);
    if (isAuthRequired(err)) turn.live.authed = false;
    const message = isAuthRequired(err) ? ANTIGRAVITY_SIGNED_OUT : err instanceof Error ? err.message : String(err);
    this.emit({ type: 'error', sessionRef: sessionId, message });
  }

  /** A call failed: say "isn't signed in" when that is why, so the chat points at Connections. */
  private rethrow(live: Live, err: unknown): never {
    if (isAuthRequired(err)) { live.authed = false; throw new Error(ANTIGRAVITY_SIGNED_OUT); }
    if (live.authed === false) throw new Error(ANTIGRAVITY_SIGNED_OUT);
    throw err;
  }

  async startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }> {
    const live = await this.ensureProcess();
    let sessionId: string;
    try { sessionId = await live.acp.newSession(input.cwd); } catch (e) { this.rethrow(live, e); }
    live.sessions.add(sessionId);
    this.sessionCwd.set(sessionId, input.cwd);
    this.emit({ type: 'session.started', sessionRef: sessionId });
    this.runTurn(live, sessionId, input.prompt);
    return { sessionRef: sessionId };
  }

  async sendMessage(sessionRef: string, text: string): Promise<void> {
    if (this.turns.has(sessionRef)) throw new Error(BUSY);
    const live = await this.ensureProcess();
    if (!live.sessions.has(sessionRef)) {
      const cwd = this.sessionCwd.get(sessionRef);
      if (!cwd) throw new Error("Antigravity doesn't know this chat's folder. Resume it first.");
      await this.load(live, sessionRef, cwd);
    }
    if (this.turns.has(sessionRef)) throw new Error(BUSY);
    this.runTurn(live, sessionRef, text);
  }

  /** Attach an existing Antigravity conversation (session/load); its replayed history is not shown as new messages. */
  async resume(sessionRef: string, cwd: string): Promise<void> {
    this.sessionCwd.set(sessionRef, cwd);
    const live = await this.ensureProcess();
    if (live.sessions.has(sessionRef)) return;
    await this.load(live, sessionRef, cwd);
  }

  private async load(live: Live, sessionId: string, cwd: string): Promise<void> {
    this.loading.add(sessionId);
    try { await live.acp.loadSession(sessionId, cwd); } catch (e) { this.rethrow(live, e); } finally { this.loading.delete(sessionId); }
    live.sessions.add(sessionId);
  }

  async respondToRequest(_sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void> {
    const p = this.perms.get(requestId);
    if (!p) return;
    this.perms.delete(requestId);
    // ACP permissions have no reply text: { reply } is a plain "reject once".
    const option = decision === 'allow' ? pickOption(p.options, 'allow') : pickOption(p.options, 'reject');
    p.resolve(option ? { optionId: option.optionId } : 'cancelled');
  }

  async stop(sessionRef: string): Promise<void> {
    const turn = this.turns.get(sessionRef);
    if (!turn) return;
    this.settlePerms(sessionRef);
    turn.live.acp.cancel(sessionRef); // the prompt then ends 'cancelled' -> stopped
  }

  async listModels(): Promise<ModelOption[]> { return []; } // Antigravity picks its model

  async readUsage(): Promise<UsageReading> {
    // usage_update in session/update is the chat's context-window size, not an account limit: not shown.
    return { provider: 'antigravity', status: 'unavailable', windows: [], readAt: new Date().toISOString(), message: NO_LIMITS };
  }

  /** What the running agent answered to `initialize` (null before it has started). */
  get initializeResult(): AcpInitializeResult | null { return this.live?.init ?? null; }

  /** The running agent's version (ACP agentInfo.version). Starts it unless it is crash-looping. */
  async agentVersion(): Promise<string | null> {
    if (this.inBackoff()) return this.lastVersion;
    try {
      const live = await this.ensureProcess();
      return live.init.agentInfo?.version || this.lastVersion;
    } catch { return this.lastVersion; }
  }

  /**
   * Runs the agent's own sign-in with its first auth method ("Log in with Google"). `onUrl` gets each sign-in
   * link it prints (the agent also tries to open the browser itself). Resolves once the agent reports the
   * sign-in finished; aborting stops the agent process, which ends its sign-in listener.
   */
  async signIn(onUrl: (url: string) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.authUrlFn) throw new Error('Antigravity sign-in is already running.');
    const live = await abortable(this.ensureProcess(), signal);
    if (this.signedInOf(live) === true) return;
    const method = live.init.authMethods[0]?.id;
    if (!method) throw new Error("Antigravity didn't offer a way to sign in.");
    const seen = new Set<string>();
    this.authUrlFn = (url) => {
      if (seen.has(url)) return;
      seen.add(url);
      try { onUrl(url); } catch { /* the caller's problem */ }
    };
    this.signInLive = live;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(abortReason(signal));
          void this.recycle(live).catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        live.acp.authenticate(method).then(
          () => { signal.removeEventListener('abort', onAbort); resolve(); },
          (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
      });
      live.authed = true;
    } finally {
      this.authUrlFn = null;
      this.signInLive = null;
    }
  }

  // ---- health ----

  private inBackoff(): boolean {
    return !this.live && !this.starting && (this.gaveUp || Date.now() < this.retryAt);
  }

  private noteFailure(): void {
    this.failures++;
    if (this.failures > 3) this.gaveUp = true;
    this.retryAt = Date.now() + Math.min(1000 * 2 ** (this.failures - 1), 60_000);
  }

  isIdle(): boolean { return this.turns.size === 0 && !this.authUrlFn; }

  /** Replace the agent process at the next ping or action (e.g. its binary changed). */
  markForRecycle(): void { if (this.live) this.recycleMarked.add(this.live.proc); }

  async restartIfIdle(): Promise<boolean> {
    const live = this.live;
    if (!live || this.starting) return true;
    if (!this.isIdle()) return false;
    await this.recycle(live);
    return true;
  }

  /**
   * Alive and signed in? Asks the running agent a method it doesn't have and takes any JSON-RPC answer as
   * a sign of life. Automatic pings respawn a dead agent with backoff and give up after a few failures;
   * a manual ping always tries once.
   */
  async ping(opts: { manual?: boolean } = {}): Promise<PingResult> {
    const manual = opts.manual === true;
    const fail = (message?: string): PingResult => ({ ok: false, signedIn: null, ...(message ? { message } : {}) });
    if (this.disposed) return fail('Antigravity adapter is shut down.');
    if (manual) { this.failures = 0; this.retryAt = 0; this.gaveUp = false; this.crashed = false; }
    const marked = this.live;
    if (marked && this.recycleMarked.has(marked.proc) && this.isIdle()) await this.recycle(marked);
    if (this.crashed) {
      this.crashed = false;
      const down = !this.live && !this.starting;
      if (down) this.noteFailure();
      return fail(down ? ANTIGRAVITY_CRASHED : 'Antigravity stopped unexpectedly and was restarted.');
    }
    if (!this.live && !this.starting) {
      if (this.gaveUp) return { ...fail(GAVE_UP), gaveUp: true };
      if (Date.now() < this.retryAt) return fail('Antigravity is restarting.');
    }
    let live: Live | null = null;
    let wasSuspect = false;
    let probeAt = 0;
    try {
      live = await this.ensureProcess();
      wasSuspect = live.proc.suspect;
      probeAt = Date.now();
      await live.proc.request('$/agent_kanban_ping', {}, this.pingTimeoutMs).catch((e: any) => {
        if (typeof e?.code !== 'number') throw e; // an error answer is still an answer
      });
      live.proc.clearSuspect();
      this.failures = 0; this.retryAt = 0; this.gaveUp = false;
      return { ok: true, signedIn: this.signedInOf(live) };
    } catch (e) {
      this.crashed = false;
      if (live && /timed out/.test(e instanceof Error ? e.message : '')) {
        const heard = live.proc.lastNotificationAt > probeAt;
        if (heard || (this.turns.size > 0 && Date.now() - live.proc.lastNotificationAt < QUIET_MS)) {
          return { ok: true, signedIn: this.signedInOf(live) };
        }
        if (wasSuspect && this.isIdle()) await this.recycle(live);
      }
      this.noteFailure();
      return fail();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    for (const p of this.perms.values()) p.resolve('cancelled');
    this.perms.clear();
    this.turns.clear();
    const starting = this.starting;
    const proc = this.live?.proc ?? this.startingProc;
    this.live = null;
    if (proc) this.closingByUs.add(proc);
    await proc?.close();
    await starting?.catch(() => {});
  }
}

function isAuthRequired(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === AUTH_REQUIRED_CODE;
}

function toolStatus(status: unknown): 'running' | 'done' | 'failed' {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'running';
}

/** "allow" -> the allow-once option (else any allow); "reject" -> reject-once (else any reject). */
function pickOption(options: AcpPermissionOption[], want: 'allow' | 'reject'): AcpPermissionOption | undefined {
  return options.find((o) => o.kind === `${want}_once`)
    ?? options.find((o) => o.optionId === `${want}_once`)
    ?? options.find((o) => typeof o.kind === 'string' && o.kind.startsWith(want));
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error('Sign-in was cancelled.');
  e.name = 'AbortError';
  return e;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Starts the real agent with its own temp folder: each launch unpacks a few hundred MB there and a
 * force kill (how processes are stopped on Windows) leaves it behind. Every launch gets
 * <tempDir>/ak-<server pid>-<n>, deleted when the agent exits; before a launch, folders left by server
 * processes that are gone (or by this one, not in use) are deleted too.
 */
const activeTemp = new Set<string>();
let tempCounter = 0;

export function spawnAntigravity(exePath: string, tempDir: string): JsonRpcProcess {
  const name = `ak-${process.pid}-${++tempCounter}`;
  const mine = join(tempDir, name);
  try {
    mkdirSync(mine, { recursive: true });
    for (const n of readdirSync(tempDir)) {
      const m = /^ak-(\d+)-\d+$/.exec(n);
      if (!m || n === name || activeTemp.has(n)) continue;
      const pid = Number(m[1]);
      if (pid !== process.pid && pidAlive(pid)) continue;
      try { rmSync(join(tempDir, n), { recursive: true, force: true }); } catch { /* still in use */ }
    }
  } catch { /* the agent still starts; it just uses this folder as is */ }
  activeTemp.add(name);
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
  if (process.platform === 'win32') { env.TEMP = mine; env.TMP = mine; } else env.TMPDIR = mine;
  const proc = new JsonRpcProcess(exePath, [], { jsonrpc: '2.0', env, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  proc.onExit(() => {
    // Windows releases the unpacked files a moment after the exit.
    void rm(mine, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}).finally(() => activeTemp.delete(name));
  });
  return proc;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
