// ConnectService: installs, signs in, signs out and updates each provider from the app, using only the
// official tools (npm for Claude Code and Codex, Google's pinned release for Antigravity, each tool's own
// sign-in). It never reads, stores or forwards tokens: it starts the tool's sign-in and watches the tool's status.
import type { ConnectPhase, ConnectState, ProviderId } from '@agent-kanban/shared';
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
const MAX_OUTPUT = 256 * 1024;
const MAX_LINE = 64 * 1024;

export const SIGN_IN_DIDNT_FINISH = "Sign-in didn't finish. Try again, and keep the browser window open until it says you're done.";
export const NETWORK_FAILED = "Couldn't reach the download server. Check your connection and try again.";
export const ANTIGRAVITY_SIGN_OUT_IN_APP = 'Sign out of Antigravity in the Antigravity app.';
export const STEP_SIGN_IN = 'Finish signing in in your browser';
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
  signIn(onUrl: (url: string) => void, signal: AbortSignal): Promise<void>;
  /** false: the agent has no logout method. */
  signOut(signal: AbortSignal): Promise<boolean>;
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
  monitor: { check: (provider?: ProviderId) => Promise<unknown> };
  registry: { ensure: (id: ProviderId, knownPath?: string) => Promise<unknown> };
  onUpdate: (s: ConnectState) => void;
  /** Agent Kanban's home (AGENT_KANBAN_HOME): the Antigravity install goes under <home>/.agent-kanban. */
  home: string;
  now?: () => Date;
}

type Cli = 'claude' | 'codex';
const isCli = (id: ProviderId): id is Cli => id === 'claude' || id === 'codex';

/** Why an operation was aborted. */
class Cancelled extends Error {}
class TimedOut extends Error {}

/**
 * The first https link in a line of a tool's output, normalised, or null. ANSI colour and OSC sequences are
 * removed first; trailing punctuation is not part of the link.
 */
export function findHttpsUrl(line: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const m = /https:\/\/[!-~]+/.exec(plain);
  if (!m) return null;
  const raw = m[0].replace(/["'<>`]+.*$/, '').replace(/[)\].,;:!?]+$/, '');
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  return u.href;
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

/** Plain copy for a failed `npm install -g`. */
export function npmFailureMessage(id: ProviderId, output: string, errorCode?: string): string {
  if (errorCode === 'ENOENT') return npmMissing(id);
  if ((errorCode && PERMISSION_RE.test(errorCode)) || PERMISSION_RE.test(output)) return notAllowed(id);
  if (NETWORK_RE.test(output)) return NETWORK_FAILED;
  return installFailed(id);
}

interface Op { ac: AbortController }

export class ConnectService {
  private opts: ConnectServiceOptions;
  private now: () => Date;
  private state = new Map<ProviderId, ConnectState>();
  private ops = new Map<ProviderId, Op>();

  constructor(opts: ConnectServiceOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    for (const id of PROVIDERS) {
      this.state.set(id, { provider: id, phase: 'idle', step: null, progress: null, signInUrl: null, message: null, updatedAt: this.now().toISOString() });
    }
  }

  states(): ConnectState[] { return PROVIDERS.map((id) => this.state.get(id)!); }
  get(id: ProviderId): ConnectState { return this.state.get(id)!; }
  busy(id: ProviderId): boolean { return this.ops.has(id); }

  install(id: ProviderId): ConnectState { return this.start(id, 'installing', (op) => this.doInstall(id, op, 'installing')); }
  update(id: ProviderId): ConnectState { return this.start(id, 'updating', (op) => this.doInstall(id, op, 'updating')); }
  signIn(id: ProviderId): ConnectState { return this.start(id, 'signing_in', (op) => (isCli(id) ? this.doCliSignIn(id, op) : this.doAntigravitySignIn(op))); }
  signOut(id: ProviderId): ConnectState { return this.start(id, 'signing_out', (op) => this.doSignOut(id, op)); }

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

  /** Cancels everything (server shutdown). */
  dispose(): void { for (const id of PROVIDERS) this.cancel(id); }

  // ---- plumbing ----

  private set(id: ProviderId, patch: Partial<Omit<ConnectState, 'provider' | 'updatedAt'>>): void {
    const next: ConnectState = { ...this.state.get(id)!, ...patch, provider: id, updatedAt: this.now().toISOString() };
    this.state.set(id, next);
    try { this.opts.onUpdate(next); } catch (e) { console.error('[agent-kanban] connect listener failed', e); }
  }

  private start(id: ProviderId, phase: ConnectPhase, job: (op: Op) => Promise<void>): ConnectState {
    if (this.ops.has(id)) throw new ConnectBusyError(busyMessage(id));
    const op: Op = { ac: new AbortController() };
    this.ops.set(id, op);
    this.set(id, { phase, step: null, progress: null, signInUrl: null, message: null });
    void job(op).catch((e) => {
      console.error(`[agent-kanban] ${APP[id]} ${phase} failed`, e);
      if (this.ops.get(id) === op) this.finish(id, op, { phase: 'error', message: phase === 'signing_in' ? SIGN_IN_DIDNT_FINISH : 'Something went wrong. Try again.' });
    });
    return this.get(id);
  }

  /** Ends the operation (a new one may start right away) and publishes its final state, then re-checks health. */
  private finish(id: ProviderId, op: Op, s: { phase: 'idle' | 'error'; message?: string | null }): void {
    if (this.ops.get(id) !== op) return;
    this.ops.delete(id);
    this.set(id, { phase: s.phase, step: null, progress: null, signInUrl: null, message: s.message ?? null });
    void this.opts.monitor.check(id).catch(() => {});
  }

  /** The outcome of an aborted operation: Cancel → back where it was; the 5-minute limit → the message. */
  private finishAborted(id: ProviderId, op: Op): void {
    const r = op.ac.signal.reason;
    this.finish(id, op, { phase: 'idle', message: r instanceof TimedOut ? SIGN_IN_DIDNT_FINISH : null });
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
    if (r.code !== 0) return this.finish(id, op, { phase: 'error', message: npmFailureMessage(id, r.output, r.errorCode) });

    this.set(id, { step: 'Installing', progress: 0.9 });
    const bin = await this.opts.findBinary(id).catch(() => null);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!bin) return this.finish(id, op, { phase: 'error', message: notFoundAfterInstall(id) });
    await this.opts.registry.ensure(id, bin).catch(() => {});
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
          const url = findHttpsUrl(line);
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
    }
    // Cancelled or out of time: the login process is gone before the card goes back to Signed out.
    if (login) { (login as RunningCommand).kill(); await this.settle(login); }
    this.finishAborted(id, op);
  }

  private async doAntigravitySignIn(op: Op): Promise<void> {
    const id = 'antigravity';
    const { signal } = op.ac;
    const adapter = await this.opts.antigravity.adapter().catch(() => undefined);
    if (signal.aborted) return this.finishAborted(id, op);
    if (!adapter) return this.finish(id, op, { phase: 'error', message: notInstalled(id) });
    this.set(id, { step: STEP_SIGN_IN });
    // The agent's own authenticate waits up to a day; Agent Kanban gives up after 5 minutes (abort stops the agent).
    const deadline = setTimeout(() => op.ac.abort(new TimedOut('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
    try {
      // The agent opens the browser itself; the link is kept only for "Open the browser again".
      await adapter.signIn((url) => {
        const href = findHttpsUrl(url);
        if (href && !signal.aborted && this.ops.get(id) === op) this.set(id, { signInUrl: href });
      }, signal);
      if (signal.aborted) return this.finishAborted(id, op);
      this.finish(id, op, { phase: 'idle' });
    } catch (e) {
      if (signal.aborted) return this.finishAborted(id, op);
      console.error('[agent-kanban] Antigravity sign-in failed', e);
      this.finish(id, op, { phase: 'error', message: SIGN_IN_DIDNT_FINISH });
    } finally {
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
        this.finish(id, op, { phase: 'idle', message: done ? null : ANTIGRAVITY_SIGN_OUT_IN_APP });
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
