// Antigravity adapter: drives Google's official agy_acp_server over ACP (JSON-RPC 2.0 on stdio).
//
// What the real agy_acp_server 1.3.0 does (checked on Windows, Task 3):
// - It is a PyInstaller one-file bundle: every launch unpacks ~200-330 MB into the temp folder and takes
//   ~40 s before it answers `initialize`; a force kill leaves that folder behind. So the agent is started
//   only by a user action (chat, resume, sign-in), never by a health check, and is stopped again after
//   10 idle minutes; its temp folder is ours and swept (see spawnAntigravity).
// - stdout carries only JSON-RPC; its logs, and the sign-in link, go to stderr.
// - `initialize` sends no "authenticated" flag and always lists its auth methods ("oauth-personal" first).
//   Whether a sign-in method is selected is in <GEMINI_HOME>/antigravity-acp/settings.json `auth.type`
//   (the agent writes it after `authenticate`); without one, session/new fails -32000 "Authentication required".
//   If a method is selected but its login is gone, session/new starts the browser sign-in instead: the
//   adapter treats an unasked-for sign-in link as "signed out" and restarts the process to end that flow.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterEvent, ModelOption, RequestAction, UsageReading } from '@agent-kanban/shared';
import type { PingResult, ProviderAdapter } from './adapter.ts';
import { JsonRpcProcess } from './jsonrpc.ts';
import { AcpClient, AUTH_REQUIRED_CODE } from './acp.ts';
import type { AcpInitializeResult, AcpPermissionDecision, AcpPermissionOption, AcpPermissionRequest, AcpStopReason } from './acp.ts';

type Listener = (e: AdapterEvent) => void;
type SpawnFn = (cmd: string, args: string[]) => JsonRpcProcess;

export const ANTIGRAVITY_CRASHED = 'Antigravity stopped unexpectedly.';
const RESTARTED = 'Antigravity stopped responding and was restarted. Resume to continue.';
export const ANTIGRAVITY_SIGNED_OUT = "Antigravity isn't signed in.";
const BUSY = 'Antigravity is still working on the last message. Wait for it to finish, or stop it first.';
const NO_LIMITS = "Antigravity doesn't report its limits.";
const QUIET_MS = 120_000;
/** stop() waits at most this long for the cancelled turn to end. */
const STOP_WAIT_MS = 10_000;
const IDLE_MS = 10 * 60_000;
const SETTINGS_MAX_BYTES = 64 * 1024;
// Startup is slow (see above): requests get a generous default; pings their own short timeout.
const REQUEST_TIMEOUT_MS = 180_000;

interface Live {
  proc: JsonRpcProcess;
  acp: AcpClient;
  init: AcpInitializeResult;
  /** Sessions this process knows (created or loaded on it). */
  sessions: Set<string>;
  /** session/load calls in flight on this process, so concurrent sends load once. */
  loads: Map<string, Promise<void>>;
}

interface Turn {
  live: Live; messageId: string; text: string[]; started: boolean;
  /** New tool calls seen so far this turn: each call's `start` is its place in that order. */
  seq: number;
  /** This turn's tool calls: when each started, its kind and whether it ended done. */
  calls: Map<string, { start: number; kind: string; done: boolean }>;
  /** Calls the user allowed in this turn, with the `seq` at the moment of the answer. */
  approvedAt: Map<string, number>;
  /** Calls that ended "approved but never executed": decided when the turn ends (see flushHeld). */
  held: Set<string>;
  /** Resolves once the turn has ended (finished, failed or its process exited). */
  done: Promise<void>;
  end: () => void;
}
interface Perm { sessionId: string; toolCallId: string | null; options: AcpPermissionOption[]; resolve: (d: AcpPermissionDecision) => void }

export interface AntigravityAdapterOptions {
  exePath: string;
  /** Tests: start a fake agent instead. */
  spawn?: SpawnFn;
  pingTimeoutMs?: number;
  /** Stop the agent this long after the last turn, permission answer, load or sign-in ends (default 10 minutes). */
  idleMs?: number;
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
  private idleMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
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
  private version: string | null = null;
  /** The agent's own `authenticated` flag from the last initialize (null: it sends none, like the real one). */
  private agentFlag: boolean | null = null;
  /**
   * Learned from the agent itself: false after "Authentication required" or an unasked-for sign-in link,
   * true after `authenticate` succeeded. It overrides the settings.json inference.
   */
  private learned: boolean | null = null;
  /** A crash cut off a running turn since the last ping: the next ping reports it once. */
  private crashedTurn = false;
  /** Calls in progress (startChat, sendMessage, resume): the agent isn't idle while one runs. */
  private busy = 0;

  constructor(opts: AntigravityAdapterOptions) {
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 15_000;
    this.idleMs = opts.idleMs ?? IDLE_MS;
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

  /** The version the running agent reported (ACP agentInfo.version); null when it isn't running. */
  get lastVersion(): string | null { return this.live ? this.version : null; }

  /** True while an agent process is running or starting. */
  get running(): boolean { return !!this.live || !!this.starting; }

  // ---- process lifecycle ----

  private ensureProcess(): Promise<Live> {
    if (this.disposed) return Promise.reject(new Error('Antigravity adapter is shut down.'));
    if (this.live && !this.recycleMarked.has(this.live.proc)) { this.touchIdle(); return Promise.resolve(this.live); }
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
    const live: Live = { proc, acp, init: { protocolVersion: 1, authMethods: [], authenticated: null, canLogout: false }, sessions: new Set(), loads: new Map() };
    acp.onUpdate((sid, u) => this.onUpdate(sid, u));
    acp.onPermission((sid, req) => this.onPermission(sid, req));
    acp.onAuthUrl((url) => {
      if (this.authUrlFn && this.signInLive === live) this.authUrlFn(url);
      else this.unaskedSignIn(live);
    });
    proc.onExit(() => this.onProcessExit(live));
    try {
      live.init = await acp.initialize();
      if (live.init.agentInfo?.version) this.version = live.init.agentInfo.version;
      console.log(`[antigravity] agent started (agentInfo ${live.init.agentInfo?.name ?? '?'} ${live.init.agentInfo?.version ?? '?'})`);
      this.agentFlag = live.init.authenticated;
      if (this.disposed) throw new Error('Antigravity adapter is shut down.');
      this.live = live;
      this.touchIdle();
      return live;
    } catch (e) {
      this.closingByUs.add(proc);
      await proc.close();
      throw e;
    } finally {
      this.startingProc = null;
    }
  }

  /** (Re)starts the idle countdown: the agent is stopped once nothing has used it for `idleMs`. */
  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.disposed || !this.live) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const live = this.live;
      if (!live || this.starting) return;
      if (!this.isIdle() || this.perms.size > 0 || live.loads.size > 0) { this.touchIdle(); return; }
      void this.recycle(live).catch(() => {}); // chats re-attach with session/load on their next message
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** A sign-in link nobody asked for: the selected login is gone and session/new started a browser sign-in. */
  private unaskedSignIn(live: Live): void {
    this.learned = false;
    void this.recycle(live).catch(() => {});
  }

  private onProcessExit(live: Live): void {
    if (this.live === live) this.live = null;
    if (this.disposed) return;
    const deliberate = this.closingByUs.has(live.proc);
    for (const [sid, turn] of [...this.turns]) {
      if (turn.live !== live) continue;
      this.turns.delete(sid);
      turn.end();
      this.settlePerms(sid);
      this.flushHeld(sid, turn);
      if (!deliberate) this.crashedTurn = true; // an exit with nothing running is just "not running"
      // An unasked-for sign-in is reported as signed out, not as a crash.
      if (this.learned === false && deliberate) this.emit({ type: 'error', sessionRef: sid, message: ANTIGRAVITY_SIGNED_OUT });
      else this.emit({ type: 'error', sessionRef: sid, message: deliberate ? RESTARTED : ANTIGRAVITY_CRASHED });
    }
  }

  /**
   * Signed in? What the agent itself told us wins (signed out after "Authentication required" or an
   * unasked-for sign-in, its own flag, signed in after a sign-in); otherwise whether settings.json selects
   * a sign-in method.
   */
  private signedInOf(): boolean {
    if (this.learned === false) return false;
    if (this.learned === true) return true;
    if (this.agentFlag !== null) return this.agentFlag;
    return this.authTypeSelected();
  }

  /** Reads only `auth.type` from the agent's settings.json (never its credential store). */
  private authTypeSelected(): boolean {
    try {
      const file = join(this.geminiHome, 'antigravity-acp', 'settings.json');
      if (statSync(file).size > SETTINGS_MAX_BYTES) return false;
      const s = JSON.parse(readFileSync(file, 'utf8'));
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
        const title = typeof u.title === 'string' && u.title ? friendlyTitle(u.title, u) : known?.title ?? 'Using a tool';
        const kind = typeof u.kind === 'string' && u.kind ? u.kind : known?.kind ?? 'tool';
        this.toolInfo.set(u.toolCallId, { title, kind });
        const status = toolStatus(u.status);
        let call = turn.calls.get(u.toolCallId);
        if (!call) { call = { start: ++turn.seq, kind, done: false }; turn.calls.set(u.toolCallId, call); }
        call.kind = kind;
        call.done = status === 'done';
        if (status === 'failed' && neverExecuted(u)) { turn.held.add(u.toolCallId); return; }
        turn.held.delete(u.toolCallId);
        this.emit({ type: 'tool.call', sessionRef: sessionId, toolCallId: u.toolCallId, name: kind, summary: title, status });
        return;
      }
    }
  }

  /**
   * After the user allows a call, Antigravity 1.3.0 does the work in a separate call (an `edit_file` call of kind
   * edit for an allowed "Run create_file?") and ends the allowed one failed, "Tool call was approved but never
   * executed" (seen in the Task 7 end-to-end run), so one edit showed as a failed step plus a done one. Such a
   * failure is held until the turn ends: it shows as done (superseded) when a call that started after the approval
   * ended done with kind edit, delete or move; otherwise as failed. Nothing is left running.
   */
  private flushHeld(sessionId: string, turn: Turn): void {
    for (const id of turn.held) {
      const approvedAt = turn.approvedAt.get(id);
      const redone = approvedAt !== undefined && [...turn.calls].some(([other, c]) =>
        other !== id && c.start > approvedAt && c.done && FILE_KINDS.has(c.kind));
      const info = this.toolInfo.get(id);
      this.emit({ type: 'tool.call', sessionRef: sessionId, toolCallId: id, name: info?.kind ?? 'tool', summary: info?.title ?? 'Using a tool', status: redone ? 'done' : 'failed' });
    }
    turn.held.clear();
  }

  private onPermission(sessionId: string, req: AcpPermissionRequest): Promise<AcpPermissionDecision> {
    const requestId = `perm_${++this.permCounter}`;
    const tc = req.toolCall;
    const known = typeof tc?.toolCallId === 'string' ? this.toolInfo.get(tc.toolCallId) : undefined;
    const rawTitle = typeof tc?.title === 'string' && tc.title ? tc.title : null;
    const summary = rawTitle ? friendlyTitle(rawTitle, tc) : known?.title ?? 'Use a tool';
    const action = acpAction(typeof tc?.kind === 'string' && tc.kind ? tc.kind : known?.kind, rawTitle ?? '');
    return new Promise((resolve) => {
      this.perms.set(requestId, { sessionId, toolCallId: typeof tc?.toolCallId === 'string' ? tc.toolCallId : null, options: req.options, resolve });
      this.emit({ type: 'request.opened', sessionRef: sessionId, requestId, kind: 'permission', summary, action });
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
    let end!: () => void;
    const done = new Promise<void>((r) => { end = r; });
    const turn: Turn = {
      live, messageId: `${sessionId}:${n}`, text: [], started: false,
      seq: 0, calls: new Map(), approvedAt: new Map(), held: new Set(), done, end,
    };
    this.turns.set(sessionId, turn);
    live.acp.prompt(sessionId, text).then(
      ({ stopReason }) => this.finishTurn(sessionId, turn, stopReason),
      (err) => this.failTurn(sessionId, turn, err),
    );
  }

  private finishTurn(sessionId: string, turn: Turn, stopReason: AcpStopReason): void {
    if (this.turns.get(sessionId) !== turn) return;
    this.turns.delete(sessionId);
    turn.end();
    this.settlePerms(sessionId);
    this.flushHeld(sessionId, turn);
    if (turn.text.length > 0) {
      this.emit({ type: 'message.completed', sessionRef: sessionId, messageId: turn.messageId, role: 'assistant', text: turn.text.join('') });
    }
    if (stopReason === 'cancelled') this.emit({ type: 'stopped', sessionRef: sessionId });
    else this.emit({ type: 'turn.completed', sessionRef: sessionId });
    this.touchIdle();
  }

  private failTurn(sessionId: string, turn: Turn, err: unknown): void {
    if (this.turns.get(sessionId) !== turn) return; // a process exit already reported it
    this.turns.delete(sessionId);
    turn.end();
    this.settlePerms(sessionId);
    this.flushHeld(sessionId, turn);
    if (isAuthRequired(err)) this.learned = false;
    const message = isAuthRequired(err) ? ANTIGRAVITY_SIGNED_OUT : err instanceof Error ? err.message : String(err);
    this.emit({ type: 'error', sessionRef: sessionId, message });
    this.touchIdle();
  }

  /** A call failed: say "isn't signed in" when that is why, so the chat points at Connections. */
  private rethrow(err: unknown): never {
    if (isAuthRequired(err)) { this.learned = false; throw new Error(ANTIGRAVITY_SIGNED_OUT); }
    if (this.learned === false) throw new Error(ANTIGRAVITY_SIGNED_OUT);
    throw err;
  }

  /** Runs a call that uses the agent: it counts as busy throughout, so the idle stop can't cut it off. */
  private async held<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    this.touchIdle();
    try { return await fn(); } finally { this.busy--; this.touchIdle(); }
  }

  startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }> {
    return this.held(async () => {
      const live = await this.ensureProcess();
      let sessionId: string;
      try { sessionId = await live.acp.newSession(input.cwd); } catch (e) { this.rethrow(e); }
      this.learned = true; // the agent accepted a session: signed in (also after signing in elsewhere)
      live.sessions.add(sessionId);
      this.sessionCwd.set(sessionId, input.cwd);
      this.emit({ type: 'session.started', sessionRef: sessionId });
      this.runTurn(live, sessionId, withFolder(input.cwd, input.prompt));
      return { sessionRef: sessionId };
    });
  }

  sendMessage(sessionRef: string, text: string): Promise<void> {
    if (this.turns.has(sessionRef)) return Promise.reject(new Error(BUSY));
    return this.held(async () => {
      const live = await this.ensureProcess();
      if (!live.sessions.has(sessionRef)) {
        const cwd = this.sessionCwd.get(sessionRef);
        if (!cwd) throw new Error("Antigravity doesn't know this chat's folder. Resume it first.");
        await this.load(live, sessionRef, cwd);
      }
      if (this.turns.has(sessionRef)) throw new Error(BUSY);
      this.runTurn(live, sessionRef, text);
    });
  }

  /** Attach an existing Antigravity conversation (session/load); its replayed history is not shown as new messages. */
  resume(sessionRef: string, cwd: string): Promise<void> {
    this.sessionCwd.set(sessionRef, cwd);
    return this.held(async () => {
      const live = await this.ensureProcess();
      if (live.sessions.has(sessionRef)) return;
      await this.load(live, sessionRef, cwd);
    });
  }

  /** session/load once per session and process, however many callers wait for it. */
  private load(live: Live, sessionId: string, cwd: string): Promise<void> {
    const running = live.loads.get(sessionId);
    if (running) return running;
    const p = (async () => {
      this.loading.add(sessionId);
      try { await live.acp.loadSession(sessionId, cwd); } catch (e) { this.rethrow(e); } finally { this.loading.delete(sessionId); }
      this.learned = true; // the agent accepted the session: signed in
      live.sessions.add(sessionId);
    })().finally(() => { live.loads.delete(sessionId); this.touchIdle(); });
    live.loads.set(sessionId, p);
    return p;
  }

  async respondToRequest(_sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void> {
    const p = this.perms.get(requestId);
    if (!p) return;
    this.perms.delete(requestId);
    // ACP permissions have no reply text: { reply } is a plain "reject once".
    const want = decision === 'allow' ? 'allow' : 'reject';
    const option = pickOption(p.options, want);
    if (!option) {
      console.warn(`[antigravity] no ${want === 'allow' ? 'allow-once' : 'reject'} option was offered (${p.options.map((o) => o.kind).join(', ')}); answered cancelled.`);
    }
    const turn = this.turns.get(p.sessionId);
    if (option && want === 'allow' && p.toolCallId && turn) turn.approvedAt.set(p.toolCallId, turn.seq);
    p.resolve(option ? { optionId: option.optionId } : 'cancelled');
    this.touchIdle();
  }

  async stop(sessionRef: string): Promise<void> {
    const turn = this.turns.get(sessionRef);
    if (!turn) return;
    this.settlePerms(sessionRef);
    turn.live.acp.cancel(sessionRef); // the prompt then ends 'cancelled' -> stopped
    // Wait for that, so a Send right after Stop isn't refused as busy (bounded: a stuck agent can't hold Stop).
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<void>((r) => { timer = setTimeout(r, STOP_WAIT_MS); timer.unref?.(); });
    try { await Promise.race([turn.done, wait]); } finally { clearTimeout(timer); }
  }

  async listModels(): Promise<ModelOption[]> { return []; } // Antigravity picks its model

  async readUsage(): Promise<UsageReading> {
    // usage_update in session/update is the chat's context-window size, not an account limit: not shown.
    return { provider: 'antigravity', status: 'unavailable', windows: [], readAt: new Date().toISOString(), message: NO_LIMITS };
  }

  /** Starts the agent if it isn't running (a user action, e.g. opening its sign-in); resolves with its `initialize` answer. */
  async start(): Promise<AcpInitializeResult> { return (await this.ensureProcess()).init; }

  /** What the running agent answered to `initialize` (null when it isn't running). */
  get initializeResult(): AcpInitializeResult | null { return this.live?.init ?? null; }

  /** The running agent's ACP agentInfo.version, or null when it isn't running. Never starts it. */
  async agentVersion(): Promise<string | null> { return this.lastVersion; }

  /**
   * Runs the agent's own sign-in with its first auth method ("Log in with Google"). `onUrl` gets each sign-in
   * link it prints (the agent also tries to open the browser itself). Resolves once the agent reports the
   * sign-in finished; aborting stops the agent process, which ends its sign-in listener. The caller bounds
   * how long it waits, through `signal`.
   */
  async signIn(onUrl: (url: string) => void, signal: AbortSignal, onStarted?: () => void): Promise<void> {
    signal.throwIfAborted();
    if (this.authUrlFn) throw new Error('Antigravity sign-in is already running.');
    const startedHere = !this.live && !this.starting;
    const starting = this.ensureProcess();
    let live: Live;
    try {
      live = await abortable(starting, signal);
    } catch (e) {
      // Cancelled while the agent was still starting for this sign-in: don't leave it running.
      if (signal.aborted && startedHere) starting.then((l) => this.recycle(l)).catch(() => {});
      throw e;
    }
    try { onStarted?.(); } catch { /* the caller's problem */ }
    // Skip only when the agent itself says signed in, never on the settings.json guess.
    if (this.learned === true || (this.learned === null && this.agentFlag === true)) return;
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
      this.learned = true;
    } finally {
      this.authUrlFn = null;
      this.signInLive = null;
      this.touchIdle();
    }
  }

  /**
   * Signs out through the agent's own ACP `logout` (agy_acp_server 1.3.0 advertises it: it clears its stored
   * Google credentials and settings.json `auth.type`). Agent Kanban never touches those files itself.
   * Resolves false when the agent doesn't offer logout. Starts the agent if needed; `signal` bounds the wait.
   */
  async signOut(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.authUrlFn) throw new Error('Antigravity sign-in is still running.');
    this.busy++;
    try {
      const live = await abortable(this.ensureProcess(), signal);
      if (!live.init.canLogout) return false;
      await abortable(live.acp.logout(), signal);
      this.learned = false;
      live.sessions.clear(); // the agent tears its sessions down with the credentials
      return true;
    } finally {
      this.busy--;
      this.touchIdle();
    }
  }

  // ---- health ----

  isIdle(): boolean { return this.turns.size === 0 && !this.authUrlFn && this.busy === 0; }

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
   * Health check. Never starts the agent (manual checks included): not running is fine, and signed-in then
   * comes from what was learned or settings.json. Only a crash that cut off a turn is reported, once. While it
   * runs, a call to a method it doesn't have checks that it answers (any JSON-RPC answer is a sign of life).
   */
  async ping(_opts: { manual?: boolean } = {}): Promise<PingResult> {
    const fail = (message?: string): PingResult => ({ ok: false, signedIn: null, ...(message ? { message } : {}) });
    if (this.disposed) return fail('Antigravity adapter is shut down.');
    const marked = this.live;
    if (marked && this.recycleMarked.has(marked.proc) && this.isIdle()) await this.recycle(marked);
    if (this.crashedTurn) {
      this.crashedTurn = false;
      if (!this.live && !this.starting) return fail(ANTIGRAVITY_CRASHED);
    }
    const live = this.live;
    if (!live) return { ok: true, signedIn: this.signedInOf() };
    const wasSuspect = live.proc.suspect;
    const probeAt = Date.now();
    try {
      await live.proc.request('$/agent_kanban_ping', {}, this.pingTimeoutMs).catch((e: any) => {
        if (typeof e?.code !== 'number') throw e; // an error answer is still an answer
      });
      live.proc.clearSuspect();
      return { ok: true, signedIn: this.signedInOf() };
    } catch (e) {
      if (/timed out/.test(e instanceof Error ? e.message : '')) {
        const heard = live.proc.lastNotificationAt > probeAt;
        if (heard || (this.turns.size > 0 && Date.now() - live.proc.lastNotificationAt < QUIET_MS)) {
          return { ok: true, signedIn: this.signedInOf() };
        }
        if (wasSuspect && this.isIdle()) await this.recycle(live);
      }
      if (!this.live && this.isIdle()) return { ok: true, signedIn: this.signedInOf() }; // not running now
      return fail();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.listeners.clear();
    for (const p of this.perms.values()) p.resolve('cancelled');
    this.perms.clear();
    for (const t of this.turns.values()) t.end();
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

/** What an ACP tool call's permission is for, from its `kind` (edit / delete / move change files; execute runs a command). */
const FILE_KINDS = new Set(['edit', 'delete', 'move']);

export function acpAction(kind: string | undefined, title = ''): RequestAction {
  if (kind !== undefined && FILE_KINDS.has(kind)) return 'edit';
  if (kind === 'execute') return 'command';
  // 1.3.0 asks for its file tools with no file kind ("Run create_file?", kind other): name them by the tool.
  // The whole title must be the tool ("Run create_file?"), so a command that merely mentions edit_file is not an edit.
  if (/^(?:Run\s+)?(?:create|edit|write|delete|move|replace)_file\??$/i.test(title.trim())) return 'edit';
  return 'tool';
}

const TOOL_VERBS: Record<string, string> = {
  create_file: 'Creating', write_file: 'Writing', write_to_file: 'Writing', edit_file: 'Editing', replace_file: 'Editing',
  replace_file_content: 'Editing', delete_file: 'Deleting', move_file: 'Moving', read_file: 'Reading', view_file: 'Reading',
  list_dir: 'Listing', list_directory: 'Listing',
};

/**
 * Antigravity 1.3.0 titles its tool calls with the raw tool name ("Run create_file?", "Running edit_file"). Those become
 * "Creating agy.txt" / "Editing app.ts", naming the file when the call carries a path (ACP `locations`, or a path-like
 * field in `rawInput`); an unknown tool reads "Using <tool name>". Any other title is kept as it is (#7).
 */
export function friendlyTitle(title: string, call: any): string {
  const m = /^(?:Run(?:ning)?\s+)?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\??$/i.exec(title.trim());
  if (!m) return title;
  const tool = m[1]!.toLowerCase();
  const path = toolPath(call);
  const file = path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  const verb = TOOL_VERBS[tool];
  if (verb) return file ? `${verb} ${file}` : `${verb} a ${tool.includes('dir') ? 'folder' : 'file'}`;
  return `Using ${tool.replace(/_/g, ' ')}`;
}

function toolPath(call: any): string | null {
  const loc = Array.isArray(call?.locations) ? call.locations.find((l: any) => typeof l?.path === 'string' && l.path) : null;
  if (loc) return loc.path;
  const input = call?.rawInput;
  if (input && typeof input === 'object') {
    for (const key of ['path', 'file_path', 'filePath', 'TargetFile', 'targetFile', 'AbsolutePath', 'absolutePath', 'file']) {
      if (typeof input[key] === 'string' && input[key]) return input[key];
    }
  }
  return null;
}

/** Antigravity's "Tool call was approved but never executed" (in rawOutput or the call's content). */
function neverExecuted(u: any): boolean {
  let text = '';
  try { text = JSON.stringify([u.rawOutput ?? null, u.content ?? null]); } catch { return false; }
  return /approved but never executed/i.test(text);
}

function toolStatus(status: unknown): 'running' | 'done' | 'failed' {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'running';
}

/** "allow" -> only the allow-once option (never widened to allow-always); "reject" -> reject-once, else any reject. */
export function pickOption(options: AcpPermissionOption[], want: 'allow' | 'reject'): AcpPermissionOption | undefined {
  const once = options.find((o) => o.kind === `${want}_once`) ?? options.find((o) => o.optionId === `${want}_once`);
  if (once || want === 'allow') return once;
  return options.find((o) => typeof o.kind === 'string' && o.kind.startsWith('reject'));
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

/**
 * agy-acp-server 1.3.0 hands its harness the workspaces [cwd, ~/.gemini/config/skills, ~/.gemini/antigravity-cli/skills, ...]
 * and the model takes the first one in sorted order as its working folder, which is almost never the chat's folder
 * (".gemini" sorts before most names), so it created files in ~/.gemini/antigravity-cli/skills (seen in the Task 7
 * end-to-end run). Naming the folder in a new chat's first prompt makes it read, write and run commands there.
 */
export function withFolder(cwd: string, prompt: string): string {
  // JSON quoting escapes control characters, so a folder name can't add lines of its own to the prompt.
  return `The working folder for this chat is ${JSON.stringify(cwd)}. Unless asked otherwise, read and write files there and run commands there.\n\n${prompt}`;
}

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
  // Its own process group on Linux/macOS: the PyInstaller bootloader starts the real agent as a child, which a
  // plain SIGTERM to the bootloader would leave running.
  const proc = new JsonRpcProcess(exePath, [], { jsonrpc: '2.0', env, requestTimeoutMs: REQUEST_TIMEOUT_MS, group: true });
  proc.onExit(() => {
    // Windows releases the unpacked files a moment after the exit.
    void rm(mine, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}).finally(() => activeTemp.delete(name));
  });
  return proc;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
