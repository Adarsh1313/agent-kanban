import { execFile } from 'node:child_process';
import type { ConnectionHealth, ProviderId } from '@agent-kanban/shared';
import type { AdapterSource } from './adapters/registry.ts';
import type { PingResult } from './adapters/adapter.ts';
import { resolveSpawnTarget } from './adapters/spawn-target.ts';
import { ANTIGRAVITY_RELEASE_VERSION } from './connect/antigravity-release.ts';

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const NPM_PACKAGE: Partial<Record<ProviderId, string>> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const VERSION_TIMEOUT_MS = 10_000;
const REGISTRY_TIMEOUT_MS = 10_000;

/** The first x.y.z in a `--version` line: `2.1.308 (Claude Code)` and `codex-cli 0.163.0` both work. */
export function parseVersion(output: string): string | null {
  return /\d+\.\d+\.\d+/.exec(output)?.[0] ?? null;
}

/** Runs `<path> --version`. Never spawns a .cmd shim directly; any failure gives null. */
export function getVersion(_provider: ProviderId, path: string): Promise<string | null> {
  const target = resolveSpawnTarget(path);
  return new Promise((resolve) => {
    execFile(target.command, [...target.args, '--version'], { windowsHide: true, timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : parseVersion(String(stdout)));
    });
  });
}

/**
 * Reads the installed version without starting anything. Antigravity has no --version: it is the installed,
 * hash-pinned version folder (the running agent's agentInfo.version is only logged), so it can't flip while
 * the agent starts and stops. The others run `<path> --version`.
 */
export function makeGetVersion(installedAntigravity: () => string | null): (id: ProviderId, path: string) => Promise<string | null> {
  return async (id, path) => (id === 'antigravity' ? installedAntigravity() : getVersion(id, path));
}

/**
 * The version to compare against: Antigravity's is the release Agent Kanban pins (installed from Google);
 * the others are the newest published on npm. Offline, slow or odd responses give null, never an error.
 */
export async function getLatest(provider: ProviderId): Promise<string | null> {
  if (provider === 'antigravity') return ANTIGRAVITY_RELEASE_VERSION;
  const pkg = NPM_PACKAGE[provider];
  if (!pkg) return null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? parseVersion(body.version) : null;
  } catch {
    return null;
  }
}

function newer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export class ConnectionMonitor {
  private opts: ConnectionMonitorOptions;
  private healthMs: number;
  private versionMs: number;
  private retryMs: number;
  private retryMaxMs: number;
  private retryAttempt = 0; // consecutive degraded retries: 5 s, 10 s, 20 s, 40 s, then every 60 s
  private gaveUp = new Set<ProviderId>(); // the adapter stopped restarting itself: wait for a manual check
  private current = new Map<ProviderId, ConnectionHealth>();
  private inFlight = new Map<ProviderId, { promise: Promise<ConnectionHealth>; manual: boolean }>();
  private versions = new Map<ProviderId, string | null>();
  private latestVersions = new Map<ProviderId, string | null>();
  private pendingRestart = new Set<ProviderId>(); // binary changed; the helper process still has to be replaced
  private versionsDue = new Set<ProviderId>(); // providers whose installed/latest version must be re-read on the next check
  private timers: NodeJS.Timeout[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: ConnectionMonitorOptions) {
    this.opts = opts;
    this.healthMs = opts.healthMs ?? 60_000;
    this.versionMs = opts.versionMs ?? 6 * 3_600_000;
    this.retryMs = opts.retryMs ?? 5_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
    for (const id of opts.providers) this.versionsDue.add(id);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const periodic = () => { this.runChecks(this.opts.providers, false).catch(logFailure); };
    periodic();
    const health = setInterval(periodic, this.healthMs);
    const versions = setInterval(() => {
      for (const id of this.opts.providers) this.versionsDue.add(id);
      periodic();
    }, this.versionMs);
    health.unref(); versions.unref();
    this.timers.push(health, versions);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.splice(0)) clearInterval(t);
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  /** The most recent health of each provider that has been checked, in provider order. */
  latest(): ConnectionHealth[] {
    return this.opts.providers.flatMap((id) => { const h = this.current.get(id); return h ? [h] : []; });
  }

  /** A user-requested check: re-reads versions and tries to restart anything that is down. */
  async check(provider?: ProviderId): Promise<ConnectionHealth[]> {
    const ids = provider ? this.opts.providers.filter((id) => id === provider) : this.opts.providers;
    for (const id of ids) this.versionsDue.add(id);
    this.retryAttempt = 0;
    return this.runChecks(ids, true);
  }

  private runChecks(ids: ProviderId[], manual: boolean, light = false): Promise<ConnectionHealth[]> {
    return Promise.all(ids.map((id) => this.checkOne(id, manual, light))).then((hs) => { this.scheduleRetry(); return hs; });
  }

  /** Degraded providers the monitor keeps retrying on its own (not ones whose adapter gave up). */
  private retryable(): ProviderId[] {
    return this.opts.providers.filter((id) => this.current.get(id)?.status === 'degraded' && !this.gaveUp.has(id));
  }

  /**
   * A provider that is down gets pinged again soon, so the status flips back quickly after a restart.
   * Retries back off 5 s, 10 s, 20 s, 40 s, then every 60 s, and only ping (the binary and version are cached).
   */
  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    if (this.retryable().length === 0) { this.retryAttempt = 0; return; }
    const delay = Math.min(this.retryMs * 2 ** this.retryAttempt, this.retryMaxMs);
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.runChecks(this.retryable(), false, true).catch(logFailure);
    }, delay);
    this.retryTimer.unref();
  }

  private checkOne(id: ProviderId, manual: boolean, light = false): Promise<ConnectionHealth> {
    const running = this.inFlight.get(id);
    if (running && (running.manual || !manual)) return running.promise;
    // A manual check waits for the periodic one in flight, then runs its own (it may restart things).
    const after = running ? running.promise.catch(() => undefined) : Promise.resolve();
    const entry = { promise: after.then(() => this.doCheck(id, manual, light && !manual)), manual };
    const clear = () => { if (this.inFlight.get(id) === entry) this.inFlight.delete(id); };
    entry.promise.then(clear, clear);
    this.inFlight.set(id, entry);
    return entry.promise;
  }

  /** `light`: a degraded retry, which reuses the binary path and version found by the last full check and only pings. */
  private async doCheck(id: ProviderId, manual: boolean, light = false): Promise<ConnectionHealth> {
    const name = NAMES[id];
    const base = { provider: id, installed: false, path: null, version: null, latestVersion: null, updateAvailable: false, signedIn: null, processOk: false } as const;
    const cachedPath = light ? this.current.get(id)?.path ?? null : null;
    let path: string | null = cachedPath;
    if (!path) {
      try { path = await this.opts.findBinary(id); } catch { /* treated as not installed */ }
    }
    if (!path) {
      this.versions.delete(id);
      return this.publish({ ...base, status: 'not_installed', message: `${name} isn't installed.` });
    }

    // The installed version is cheap to read, so read it every time; the registry only when due or still unknown.
    const previous = this.versions.get(id) ?? null;
    const version = cachedPath ? previous : await this.opts.getVersion(id, path).catch(() => null);
    this.versions.set(id, version);
    const needLatest = !cachedPath && (this.versionsDue.delete(id) || !this.latestVersions.get(id));
    const latestPromise = needLatest
      ? this.opts.getLatest(id).catch(() => null).then((v) => { this.latestVersions.set(id, v); })
      : Promise.resolve();

    const adapter = await this.opts.adapters.ensure(id, path);
    if (adapter && previous && version && previous !== version) this.pendingRestart.add(id);
    if (adapter && this.pendingRestart.has(id)) {
      // The binary changed under a running helper process: replace it as soon as nothing is running on it (retried every check).
      const done = adapter.restartIfIdle ? await adapter.restartIfIdle().catch(() => false) : true;
      if (done) this.pendingRestart.delete(id);
    }
    let ping: PingResult | null = null;
    if (adapter) {
      try { ping = await adapter.ping({ manual }); } catch { ping = null; }
    }
    if (ping?.gaveUp) this.gaveUp.add(id); else this.gaveUp.delete(id);
    await latestPromise;
    const latestVersion = this.latestVersions.get(id) ?? null;
    // Antigravity is pinned: any other installed version (older or newer) is replaced by the pinned one.
    const updateAvailable = !!(version && latestVersion && (id === 'antigravity' ? latestVersion !== version : newer(latestVersion, version)));

    const common = { ...base, installed: true, path, version, latestVersion, updateAvailable };
    if (!ping?.ok) {
      return this.publish({ ...common, status: 'degraded', message: ping?.message || `${name} didn't respond. Restarting it…` });
    }
    const ok = { ...common, signedIn: ping.signedIn, processOk: true };
    if (ping.signedIn === false) return this.publish({ ...ok, status: 'signed_out', message: `${name} isn't signed in.` });
    // The update itself shows from latestVersion ("Update available: X"), so the message carries only other notes.
    const message = ping.message ? `Connected. ${ping.message}` : null;
    return this.publish({ ...ok, status: updateAvailable ? 'update_available' : 'connected', message });
  }

  /** Stores the new health and tells the listener only when something other than checkedAt changed. */
  private publish(h: Omit<ConnectionHealth, 'checkedAt'>): ConnectionHealth {
    const health: ConnectionHealth = { ...h, checkedAt: (this.opts.now?.() ?? new Date()).toISOString() };
    const before = this.current.get(h.provider);
    this.current.set(h.provider, health);
    if (!before || changed(before, health)) {
      try { this.opts.onUpdate(health); } catch (e) { console.error('[agent-kanban] connection listener failed', e); }
    }
    return health;
  }
}

function logFailure(e: unknown): void {
  console.error('[agent-kanban] connection check failed', e);
}

function changed(a: ConnectionHealth, b: ConnectionHealth): boolean {
  const { checkedAt: _a, ...x } = a;
  const { checkedAt: _b, ...y } = b;
  return JSON.stringify(x) !== JSON.stringify(y);
}

export interface ConnectionMonitorOptions {
  providers: ProviderId[];
  findBinary: (id: ProviderId) => Promise<string | null>;
  getVersion: (id: ProviderId, path: string) => Promise<string | null>;
  getLatest: (id: ProviderId) => Promise<string | null>;
  adapters: Pick<AdapterSource, 'ensure'>;
  onUpdate: (h: ConnectionHealth) => void;
  now?: () => Date;
  healthMs?: number; // default 60 s
  versionMs?: number; // default 6 h
  retryMs?: number; // how soon a degraded provider is first pinged again, default 5 s (then doubling)
  retryMaxMs?: number; // the longest gap between degraded retries, default 60 s
}
