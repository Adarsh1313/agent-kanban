// ConnectService: installs, signs in, signs out and updates each provider from the app, using only the
// official tools (npm for Claude Code and Codex, Google's pinned release for Antigravity, each tool's own
// sign-in). It never reads, stores or forwards tokens: it starts the tool's sign-in and watches the tool's status.
import type { ConnectionHealth, ConnectOp, ConnectOutcome, ConnectPhase, ConnectState, ProviderId } from '@agent-kanban/shared';
import type { CommandRunner, RunningCommand } from './run.ts';
import type { InstallOptions, InstalledAntigravity } from './antigravity-install.ts';

export const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
export const APP: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const NPM_PACKAGE = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' } as const;

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const POLL_MS = 2_000;
const STATUS_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 60_000;
// Antigravity's agent takes ~40 s to start before it can sign out.
const ANTIGRAVITY_SIGN_OUT_TIMEOUT_MS = 3 * 60_000;
const KILL_WAIT_MS = 5_000;
// A global npm install that hasn't finished in 15 minutes is stuck (usually the network).
export const NPM_TIMEOUT_MS = 15 * 60_000;
// After an update, an adapter with a chat running on it is replaced once that chat is done.
export const RECYCLE_RETRY_MS = 30_000;
const MAX_OUTPUT = 256 * 1024;
const MAX_LINE = 64 * 1024;

export const SIGN_IN_DIDNT_FINISH = "Sign-in didn't finish. Try again, and keep the browser window open until it says you're done.";
export const NETWORK_FAILED = "Couldn't reach the download server. Check your connection and try again.";
export const ANTIGRAVITY_SIGN_OUT_IN_APP = 'Sign out of Antigravity in the Antigravity app.';
export const STEP_SIGN_IN = 'Finish signing in in your browser';
export const STEP_STARTING_ANTIGRAVITY = 'Starting Antigravity…';
export const ANTIGRAVITY_DIDNT_START = "Antigravity didn't start. Try again.";
// A cold Antigravity start was measured at up to 111 s before it answers; give it 180 s before giving up.
export const ANTIGRAVITY_START_TIMEOUT_MS = 180_000;
export const busyMessage = (id: ProviderId) => `${APP[id]} is busy. Wait for it to finish or cancel it.`;
export const npmMissing = (id: ProviderId) => `Agent Kanban needs npm to install ${APP[id]}. Install Node.js from nodejs.org, then try again.`;
export const notAllowed = (id: ProviderId) =>
  `Couldn't install ${APP[id]}: your computer didn't allow it. Try running Agent Kanban as an administrator, or install ${APP[id]} yourself.`;
export const installFailed = (id: ProviderId) => `Couldn't install ${APP[id]}. Try again, or install ${APP[id]} yourself.`;
export const notFoundAfterInstall = (id: ProviderId) => `${APP[id]} was installed, but Agent Kanban can't find it. Restart Agent Kanban and try again.`;
export const notInstalled = (id: ProviderId) => `${APP[id]} isn't installed.`;
export const signOutFailed = (id: ProviderId) => `Couldn't sign out of ${APP[id]}. Try again.`;
const NO_SIGN_IN_PAGE = "There's no sign-in page to open.";

/** A second operation for a provider that is already busy (the API answers 409). */
export class ConnectBusyError extends Error {}
/** A request that can't be done in the current state (the API answers 409). */
export class ConnectStateError extends Error {}

/** The parts of the Antigravity adapter ConnectService drives. */
export interface AntigravityAuth {
  /** `onStarted`: the agent is running (it can take minutes to start); the sign-in itself begins now. */
  signIn(onUrl: (url: string) => void, signal: AbortSignal, onStarted?: () => void): Promise<void>;
  /** false: the agent has no logout method. */
  signOut(signal: AbortSignal): Promise<boolean>;
  /** False while a chat, sign-in or anything else runs on the agent. */
  isIdle?(): boolean;
}

/** What ConnectService needs from an adapter after its provider was updated. */
export interface UpdatableAdapter {
  isIdle?(): boolean;
  /** Replace the helper process so the next chat runs the new version; false if something still runs on it. */
  restartIfIdle?(): Promise<boolean>;
}

export interface ConnectServiceOptions {
  run: CommandRunner;
  npmPath: () => Promise<string | null>;
  /** Where the claude / codex CLI is (PATH lookup in production). */
  findBinary: (id: 'claude' | 'codex') => Promise<string | null>;
  antigravity: {
    install: (opts: InstallOptions) => Promise<InstalledAntigravity>;
    adapter: () => Promise<AntigravityAuth | undefined>;
  };
  openBrowser: (url: string) => void;
  monitor: { check: (provider?: ProviderId) => Promise<ConnectionHealth[]> };
  registry: { ensure: (id: ProviderId, knownPath?: string) => Promise<UpdatableAdapter | undefined> };
  onUpdate: (s: ConnectState) => void;
  /**
   * Each health the check after an operation found, published even when only checkedAt changed (the monitor itself
   * announces changes only): the page waits for a check newer than the operation before it trusts health again.
   */
  onHealth?: (h: ConnectionHealth) => void;
  /** Agent Kanban's home (AGENT_KANBAN_HOME): the Antigravity install goes under <home>/.agent-kanban. */
  home: string;
  now?: () => Date;
}

type Cli = 'claude' | 'codex';
const isCli = (id: ProviderId): id is Cli => id === 'claude' || id === 'codex';

/** Why an operation was aborted. */
class Cancelled extends Error {}
class TimedOut extends Error {}
class StartTimedOut extends Error {}

/** The only hosts a provider's sign-in page may be on (exact hostnames). Any other link is never stored. */
export const SIGN_IN_HOSTS: Record<ProviderId, readonly string[]> = {
  claude: ['claude.ai', 'claude.com', 'console.anthropic.com'],
  codex: ['auth.openai.com'],
  antigravity: ['accounts.google.com'],
};

/**
 * The first https link in a line of a tool's output whose hostname is exactly one of `hosts`, normalised,
 * or null. ANSI colour and OSC sequences are removed first; trailing punctuation is not part of the link.
 * Links with a user name or password, or that aren't printable ASCII, are skipped.
 */
export function findHttpsUrl(line: string, hosts: readonly string[]): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  for (const m of plain.matchAll(/https:\/\/[!-~]+/g)) {
    const raw = m[0].replace(/["'<>`]+.*$/, '').replace(/[)\].,;:!?]+$/, '');
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) continue;
    if (!hosts.includes(u.hostname)) continue;
    if (!/^[!-~]+$/.test(u.href)) continue;
    return u.href;
  }
  return null;
}

function errCodes(err: unknown): string[] {
  const out: string[] = [];
  let e: any = err;
  for (let i = 0; e && i < 6; i++) {
    if (typeof e.code === 'string') out.push(e.code);
    e = e.cause;
  }
  return out;
}

const PERMISSION_RE = /\b(EACCES|EPERM)\b/;
const NETWORK_RE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT)\b|network request|socket hang up/i;
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

const NPM_NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'ERR_SOCKET_TIMEOUT', 'EPROTO', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
]);

/**
 * Plain copy for a failed `npm install -g`. npm's own "npm error code X" (or "npm ERR! code X") line decides
 * when there is one; stray words elsewhere in the log (e.g. an EPERM cleanup warning) don't.
 */
export function npmFailureMessage(id: ProviderId, output: string, errorCode?: string): string {
  if (errorCode === 'ENOENT') return npmMissing(id);
  if (errorCode && PERMISSION_RE.test(errorCode)) return notAllowed(id);
  const code = /npm (?:ERR!|error) code (\w+)/.exec(output)?.[1];
  if (code) {
    if (code === 'EACCES' || code === 'EPERM') return notAllowed(id);
    if (NPM_NETWORK_CODES.has(code)) return NETWORK_FAILED;
    return installFailed(id);
  }
  if (PERMISSION_RE.test(output)) return notAllowed(id);
  if (NETWORK_RE.test(output)) return NETWORK_FAILED;
  return installFailed(id);
}

interface Op { ac: AbortController; kind: ConnectOp; done?: Promise<void> }

const OP_OF: Partial<Record<ConnectPhase, ConnectOp>> = { installing: 'install', updating: 'update', signing_in: 'signin', signing_out: 'signout' };
type Finish = { phase: 'idle' | 'error'; message?: string | null; outcome?: ConnectOutcome };

export class ConnectService {
  private opts: ConnectServiceOptions;
  private now: () => Date;
  private state = new Map<ProviderId, ConnectState>();
  private ops = new Map<ProviderId, Op>();
  /** Providers updated while a chat ran on them: their adapter is replaced once idle. */
  private recycleTimers = new Map<ProviderId, NodeJS.Timeout>();
  private disposed = false;

  constructor(opts: ConnectServiceOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    for (const id of PROVIDERS) {
      this.state.set(id, { provider: id, phase: 'idle', step: null, progress: null, signInUrl: null, message: null, lastOp: null, outcome: null, updatedAt: this.now().toISOString() });
    }
  }

  states(): ConnectState[] { return PROVIDERS.map((id) => this.state.get(id)!); }
  get(id: ProviderId): ConnectState { return this.state.get(id)!; }
  busy(id: ProviderId): boolean { return this.ops.has(id); }

  install(id: ProviderId): ConnectState { return this.start(id, 'installing', (op) => this.doInstall(id, op, 'installing')); }
  update(id: ProviderId): ConnectState { return this.start(id, 'updating', (op) => this.doInstall(id, op, 'updating')); }
  signIn(id: ProviderId): ConnectState { return this.start(id, 'signing_in', (op) => (isCli(id) ? this.doCliSignIn(id, op) : this.doAntigravitySignIn(op))); }
  /**
   * Antigravity signs out through its agent, which drops every session: refused (busy) while a chat or
   * anything else runs on it, rather than cutting that off.
   */
  async signOut(id: ProviderId): Promise<ConnectState> {
    if (id === 'antigravity' && !this.ops.has(id)) {
      const a = await this.opts.antigravity.adapter().catch(() => undefined);
      if (a?.isIdle && !a.isIdle()) throw new ConnectBusyError(busyMessage(id));
    }
    return this.start(id, 'signing_out', (op) => this.doSignOut(id, op));
  }

  /** Stops the running operation (its processes are killed); nothing running is fine. */
  cancel(id: ProviderId): ConnectState {
    const op = this.ops.get(id);
    if (op && !op.ac.signal.aborted) op.ac.abort(new Cancelled('Cancelled.'));
    return this.get(id);
  }

  /** "Open the browser again": reopens the sign-in page the tool printed. */
  openSignInPage(id: ProviderId): ConnectState {
    const s = this.get(id);
    if (s.phase !== 'signing_in' || !s.signInUrl) throw new ConnectStateError(NO_SIGN_IN_PAGE);
    this.opts.openBrowser(s.signInUrl);
    return s;
  }

  /** Cancels everything (server shutdown) and waits, bounded, until their processes are gone. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const t of this.recycleTimers.values()) clearTimeout(t);
    this.recycleTimers.clear();
    const running = [...this.ops.values()].map((op) => op.done ?? Promise.resolve());
    for (const id of PROVIDERS) this.cancel(id);
    let t: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(running), new Promise<void>((r) => { t = setTimeout(r, KILL_WAIT_MS * 2); })]);
    clearTimeout(t);
  }

  // ---- plumbing ----

  private set(id: ProviderId, patch: Partial<Omit<ConnectState, 'provider' | 'updatedAt'>>): void {
    const next: ConnectState = { ...this.state.get(id)!, ...patch, provider: id, updatedAt: this.now().toISOString() };
    this.state.set(id, next);
    try { this.opts.onUpdate(next); } catch (e) { console.error('[agent-kanban] connect listener failed', e); }
  }

  private start(id: ProviderId, phase: ConnectPhase, job: (op: Op) => Promise<void>): ConnectState {
    if (this.ops.has(id)) throw new ConnectBusyError(busyMessage(id));
    const op: Op = { ac: new AbortController(), kind: OP_OF[phase]! };
    this.ops.set(id, op);
    this.set(id, { phase, step: null, progress: null, signInUrl: null, message: null, lastOp: null, outcome: null });
    op.done = job(op).catch((e) => {
      console.error(`[agent-kanban] ${APP[id]} ${phase} failed`, e);
      if (this.ops.get(id) === op) this.finish(id, op, { phase: 'error', message: phase === 'signing_in' ? SIGN_IN_DIDNT_FINISH : 'Something went wrong. Try again.' });
    });
    return this.get(id);
  }

  /** Ends the operation (a new one may start right away) and publishes its final state, then re-checks health. */
  private finish(id: ProviderId, op: Op, s: Finish): void {
    if (this.ops.get(id) !== op) return;
    this.ops.delete(id);
    const outcome = s.outcome ?? (s.phase === 'error' ? 'failed' : 'done');
    this.set(id, { phase: s.phase, step: null, progress: null, signInUrl: null, message: s.message ?? null, lastOp: op.kind, outcome });
    // Health is re-read at once; a result that contradicts this outcome (or an older failure) clears it, even when
    // the check finds nothing changed (so the monitor itself doesn't announce it).
    void this.opts.monitor.check(id).then((hs) => {
      for (const h of hs ?? []) {
        try { this.opts.onHealth?.(h); } catch (e) { console.error('[agent-kanban] health listener failed', e); }
        this.noteHealth(h);
      }
    }).catch(() => {});
  }

  /** The outcome of an aborted operation: Cancel → back where it was; the 5-minute limit → the message. */
  private finishAborted(id: ProviderId, op: Op): void {
    const timedOut = op.ac.signal.reason instanceof TimedOut;
    this.finish(id, op, { phase: 'idle', message: timedOut ? SIGN_IN_DIDNT_FINISH : null, outcome: timedOut ? 'failed' : 'cancelled' });
  }

  /**
   * A health check that contradicts the last operation's failure (signed in after a failed or timed-out
   * sign-in, installed after a failed install, …) clears its message and outcome, so the card stops showing it.
   */
  noteHealth(h: ConnectionHealth): void {
    const id = h.provider;
    const s = this.state.get(id);
    if (!s || this.ops.has(id) || !s.lastOp || s.outcome === 'done' || (s.message === null && s.outcome === null)) return;
    const connected = h.status === 'connected' || h.status === 'update_available';
    const moot =
      s.lastOp === 'install' ? h.installed
        : s.lastOp === 'update' ? h.installed && !h.updateAvailable
          : s.lastOp === 'signin' ? connected || h.signedIn === true
            : h.installed && h.signedIn === false;
    if (s.outcome === 'cancelled' && s.message === null) return;
    if (moot) this.set(id, { phase: 'idle', message: null, outcome: null });
  }

  /** Runs a command to the end, killed on abort (or after `timeoutMs`). */
  private async exec(
    cmd: string, args: string[], signal: AbortSignal,
    o: { timeoutMs?: number; onOutput?: (t: string) => void } = {},
  ): Promise<{ code: number | null; errorCode?: string; output: string; timedOut: boolean }> {
    signal.throwIfAborted();
    const child = this.opts.run(cmd, args);
    let output = '';
    child.onOutput((t) => {
      if (output.length < MAX_OUTPUT) output += t.slice(0, MAX_OUTPUT - output.length);
      o.onOutput?.(t);
    });
    let timedOut = false;
    const kill = () => child.kill();
    signal.addEventListener('abort', kill, { once: true });
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs) : null;
    try {
      const r = await child.exited;
      return { ...r, output, timedOut };
    } finally {
      signal.removeEventListener('abort', kill);
      if (timer) clearTimeout(timer);
    }
  }

  private async cliSignedIn(id: Cli, bin: string, signal: AbortSignal): Promise<boolean> {
    if (id === 'claude') {
      const r = await this.exec(bin, ['auth', 'status', '--json'], signal, { timeoutMs: STATUS_TIMEOUT_MS });
      const start = r.output.indexOf('{');
      const end = r.output.lastIndexOf('}');
      if (start < 0 || end <= start) return false;
      try { return (JSON.parse(r.output.slice(start, end + 1)) as { loggedIn?: unknown }).loggedIn === true; } catch { return false; }
    }
    const r = await this.exec(bin, ['login', 'status'], signal, { timeoutMs: STATUS_TIMEOUT_MS });
    return r.code === 0 && /\bLogged in\b/.test(r.output) && !/not logged in/i.test(r.output);
  }

  // ---- install / update ----

  private async doInstall(id: ProviderId, op: Op, phase: 'installing' | 'updating'): Promise<void> {
    if (id === 'antigravity') return this.doAntigravityInstall(op);
    const { signal } = op.ac;
    if (phase === 'installing') {
      // Installed outside the app meanwhile: pick it up, don't reinstall (Review Focus 5). Update always runs npm.
      const existing = await this.opts.findBinary(id).catch(() => null);
      if (signal.aborted) return this.finishAborted(id, op);
      if (existing) {
        await this.opts.registry.ensure(id, existing).catch(() => {});
        return this.finish(id, op, { phase: 'idle' });
      }
    }
    const npm = await this.opts.npmPath().catch(() => null);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!npm) return this.finish(id, op, { phase: 'error', message: npmMissing(id) });

    this.set(id, { phase, step: `Downloading ${APP[id]}…`, progress: 0.1 });
    let fetches = 0;
    let r;
    try {
      r = await this.exec(npm, ['install', '-g', `${NPM_PACKAGE[id]}@latest`, '--loglevel', 'http', '--no-fund', '--no-audit'], signal, {
        timeoutMs: NPM_TIMEOUT_MS,
        onOutput: (t) => {
          const n = (t.match(/\bhttp fetch\b/g) ?? []).length;
          if (n === 0) return;
          fetches += n;
          this.set(id, { progress: Math.round((0.1 + 0.6 * (1 - 1 / (1 + fetches / 4))) * 100) / 100 });
        },
      });
    } catch {
      return this.finishAborted(id, op);
    }
    if (signal.aborted) return this.finishAborted(id, op);
    if (r.timedOut) return this.finish(id, op, { phase: 'error', message: NETWORK_FAILED });
    if (r.code !== 0) return this.finish(id, op, { phase: 'error', message: npmFailureMessage(id, r.output, r.errorCode) });

    this.set(id, { step: 'Installing', progress: 0.9 });
    const bin = await this.opts.findBinary(id).catch(() => null);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!bin) return this.finish(id, op, { phase: 'error', message: notFoundAfterInstall(id) });
    const adapter = await this.opts.registry.ensure(id, bin).catch(() => undefined);
    // The path is usually unchanged, so the registry keeps the same adapter: replace its helper process.
    if (phase === 'updating' && adapter) await this.recycleWhenIdle(id, adapter);
    this.finish(id, op, { phase: 'idle' });
  }

  private async doAntigravityInstall(op: Op): Promise<void> {
    const id = 'antigravity';
    const { signal } = op.ac;
    const STEPS = {
      download: { step: 'Downloading Antigravity…', from: 0, span: 0.7 },
      verify: { step: 'Checking the download', from: 0.7, span: 0.1 },
      extract: { step: 'Installing', from: 0.8, span: 0.2 },
    } as const;
    this.set(id, { step: STEPS.download.step, progress: 0 });
    let installed: InstalledAntigravity;
    try {
      installed = await this.opts.antigravity.install({
        home: this.opts.home,
        signal,
        onProgress: (p) => {
          const s = STEPS[p.phase];
          if (!s || signal.aborted) return;
          const f = Math.max(0, Math.min(1, p.fraction));
          this.set(id, { step: s.step, progress: Math.round((s.from + s.span * f) * 100) / 100 });
        },
      });
    } catch (e) {
      if (signal.aborted) return this.finishAborted(id, op);
      const codes = errCodes(e);
      const message = codes.some((c) => NETWORK_CODES.has(c)) ? NETWORK_FAILED
        : codes.some((c) => c === 'EACCES' || c === 'EPERM') ? notAllowed(id)
          : e instanceof Error && e.message ? e.message : installFailed(id);
      return this.finish(id, op, { phase: 'error', message });
    }
    await this.opts.registry.ensure(id, installed.path).catch(() => {});
    this.finish(id, op, { phase: 'idle' });
  }

  // ---- sign in ----

  private async doCliSignIn(id: Cli, op: Op): Promise<void> {
    const { signal } = op.ac;
    const bin = await this.opts.findBinary(id).catch(() => null);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!bin) return this.finish(id, op, { phase: 'error', message: notInstalled(id) });

    // The 5-minute limit covers the whole sign-in, status checks included.
    const deadline = setTimeout(() => op.ac.abort(new TimedOut('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
    let login: RunningCommand | null = null;
    const killLogin = () => login?.kill();
    signal.addEventListener('abort', killLogin, { once: true });
    try {
      // Signed in already (e.g. in a terminal): done, no login process.
      if (await this.cliSignedIn(id, bin, signal)) return this.finish(id, op, { phase: 'idle' });
      if (signal.aborted) return this.finishAborted(id, op);

      this.set(id, { step: STEP_SIGN_IN });
      const proc = this.opts.run(bin, id === 'claude' ? ['auth', 'login', '--claudeai'] : ['login']);
      login = proc;
      let exited = false;
      void proc.exited.then(() => { exited = true; });
      let pending = '';
      let found = false;
      proc.onOutput((t) => {
        if (found) return;
        pending = (pending + t).slice(-MAX_LINE);
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const url = findHttpsUrl(line, SIGN_IN_HOSTS[id]); // other links (e.g. release notes) are skipped
          if (url) { found = true; if (!signal.aborted) this.set(id, { signInUrl: url }); return; }
        }
      });

      for (;;) {
        await this.wait(POLL_MS, signal, proc.exited);
        if (signal.aborted) break;
        const wasExited = exited;
        if (await this.cliSignedIn(id, bin, signal)) {
          proc.kill(); // the tool may still be waiting on its local callback page
          await this.settle(proc);
          return this.finish(id, op, { phase: 'idle' });
        }
        if (wasExited) return this.finish(id, op, { phase: 'error', message: SIGN_IN_DIDNT_FINISH });
      }
    } catch (e) {
      if (!signal.aborted) throw e;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', killLogin);
      // However this ends (done, cancelled, out of time, or an unexpected error), no login process is left.
      const proc = login as RunningCommand | null;
      if (proc) { proc.kill(); await this.settle(proc); }
    }
    // Cancelled or out of time: the card goes back to Signed out.
    this.finishAborted(id, op);
  }

  private async doAntigravitySignIn(op: Op): Promise<void> {
    const id = 'antigravity';
    const { signal } = op.ac;
    const adapter = await this.opts.antigravity.adapter().catch(() => undefined);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!adapter) return this.finish(id, op, { phase: 'error', message: notInstalled(id) });
    // A cold agent takes minutes to start: say so until it runs (or prints its link), bounded at 180 s.
    this.set(id, { step: STEP_STARTING_ANTIGRAVITY });
    const startLimit = setTimeout(() => op.ac.abort(new StartTimedOut('Antigravity did not start.')), ANTIGRAVITY_START_TIMEOUT_MS);
    let deadline: NodeJS.Timeout | undefined;
    const signingIn = () => {
      if (deadline || signal.aborted || this.ops.get(id) !== op) return;
      clearTimeout(startLimit);
      this.set(id, { step: STEP_SIGN_IN });
      // The agent's own authenticate waits up to a day; Agent Kanban gives up 5 minutes after the sign-in began (abort stops the agent).
      deadline = setTimeout(() => op.ac.abort(new TimedOut('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
    };
    const aborted = () => {
      if (signal.reason instanceof StartTimedOut) return this.finish(id, op, { phase: 'error', message: ANTIGRAVITY_DIDNT_START });
      this.finishAborted(id, op);
    };
    try {
      // The agent opens the browser itself; the link is kept only for "Open the browser again".
      await adapter.signIn((url) => {
        signingIn();
        const href = findHttpsUrl(url, SIGN_IN_HOSTS.antigravity);
        if (href && !signal.aborted && this.ops.get(id) === op) this.set(id, { signInUrl: href });
      }, signal, signingIn);
      if (signal.aborted) return aborted();
      this.finish(id, op, { phase: 'idle' });
    } catch (e) {
      if (signal.aborted) return aborted();
      console.error('[agent-kanban] Antigravity sign-in failed', e);
      this.finish(id, op, { phase: 'error', message: SIGN_IN_DIDNT_FINISH });
    } finally {
      clearTimeout(startLimit);
      clearTimeout(deadline);
    }
  }

  // ---- sign out ----

  private async doSignOut(id: ProviderId, op: Op): Promise<void> {
    const { signal } = op.ac;
    this.set(id, { step: 'Signing out…' });
    if (id === 'antigravity') {
      const adapter = await this.opts.antigravity.adapter().catch(() => undefined);
      if (signal.aborted) return this.finishAborted(id, op);
      if (!adapter) return this.finish(id, op, { phase: 'error', message: notInstalled(id) });
      const limit = setTimeout(() => op.ac.abort(new Error('Sign-out timed out.')), ANTIGRAVITY_SIGN_OUT_TIMEOUT_MS);
      try {
        const done = await adapter.signOut(signal);
        this.finish(id, op, done ? { phase: 'idle' } : { phase: 'idle', message: ANTIGRAVITY_SIGN_OUT_IN_APP, outcome: 'failed' });
      } catch (e) {
        if (signal.reason instanceof Cancelled) return this.finishAborted(id, op);
        console.error('[agent-kanban] Antigravity sign-out failed', e);
        this.finish(id, op, { phase: 'error', message: signOutFailed(id) });
      } finally {
        clearTimeout(limit);
      }
      return;
    }
    const bin = await this.opts.findBinary(id).catch(() => null);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!bin) return this.finish(id, op, { phase: 'error', message: notInstalled(id) });
    let r;
    try {
      r = await this.exec(bin, id === 'claude' ? ['auth', 'logout'] : ['logout'], signal, { timeoutMs: LOGOUT_TIMEOUT_MS });
    } catch {
      return this.finishAborted(id, op);
    }
    if (signal.aborted) return this.finishAborted(id, op);
    this.finish(id, op, r.code === 0 ? { phase: 'idle' } : { phase: 'error', message: signOutFailed(id) });
  }

  /**
   * After an update: replace the adapter's long-lived process now if nothing runs on it, otherwise keep
   * trying every 30 s until it is idle, so the next chat runs the new version.
   */
  private async recycleWhenIdle(id: ProviderId, adapter: UpdatableAdapter): Promise<void> {
    const pending = this.recycleTimers.get(id);
    if (pending) { clearTimeout(pending); this.recycleTimers.delete(id); }
    if (!adapter.restartIfIdle || this.disposed) return;
    let done = false;
    if (!adapter.isIdle || adapter.isIdle()) done = await adapter.restartIfIdle().catch(() => false);
    if (done || (adapter.isIdle && adapter.isIdle())) return; // idle: nothing old left to replace
    const t = setTimeout(() => { this.recycleTimers.delete(id); void this.recycleWhenIdle(id, adapter); }, RECYCLE_RETRY_MS);
    t.unref?.();
    this.recycleTimers.set(id, t);
  }

  // ---- timing helpers ----

  /** Resolves after `ms`, or as soon as `early` settles; rejects on abort. */
  private wait(ms: number, signal: AbortSignal, early?: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const done = () => { clearTimeout(t); signal.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { clearTimeout(t); reject(signal.reason); };
      const t = setTimeout(done, ms);
      signal.addEventListener('abort', onAbort, { once: true });
      early?.then(done, done);
    });
  }

  /** Waits (bounded) for a killed process to be gone. */
  private async settle(proc: RunningCommand): Promise<void> {
    let t: NodeJS.Timeout | undefined;
    await Promise.race([proc.exited, new Promise<void>((r) => { t = setTimeout(r, KILL_WAIT_MS); })]);
    clearTimeout(t);
  }
}
