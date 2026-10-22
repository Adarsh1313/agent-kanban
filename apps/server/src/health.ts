import { execFile } from 'node:child_process';
import type { ConnectionHealth, ProviderId } from '@agent-kanban/shared';
import type { AdapterSource } from './adapters/registry.ts';
import { resolveSpawnTarget } from './adapters/spawn-target.ts';

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

/** The newest published version on npm. Offline, slow or odd responses give null, never an error. */
export async function getLatest(provider: ProviderId): Promise<string | null> {
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
  private current = new Map<ProviderId, ConnectionHealth>();
  private inFlight = new Map<ProviderId, { promise: Promise<ConnectionHealth>; manual: boolean }>();
  private versions = new Map<ProviderId, string | null>();
  private latestVersions = new Map<ProviderId, string | null>();
  private versionsDue = new Set<ProviderId>(); // providers whose installed/latest version must be re-read on the next check
  private timers: NodeJS.Timeout[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: ConnectionMonitorOptions) {
    this.opts = opts;
    this.healthMs = opts.healthMs ?? 60_000;
    this.versionMs = opts.versionMs ?? 6 * 3_600_000;
    this.retryMs = opts.retryMs ?? 5_000;
    for (const id of opts.providers) this.versionsDue.add(id);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runChecks(this.opts.providers, false);
    const health = setInterval(() => void this.runChecks(this.opts.providers, false), this.healthMs);
    const versions = setInterval(() => {
      for (const id of this.opts.providers) this.versionsDue.add(id);
      void this.runChecks(this.opts.providers, false);
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
    return this.runChecks(ids, true);
  }

  private runChecks(ids: ProviderId[], manual: boolean): Promise<ConnectionHealth[]> {
    return Promise.all(ids.map((id) => this.checkOne(id, manual))).then((hs) => { this.scheduleRetry(); return hs; });
  }

  /** A provider that is down gets looked at again soon, so the status flips back quickly after a restart. */
  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    if (![...this.current.values()].some((h) => h.status === 'degraded')) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const down = this.opts.providers.filter((id) => this.current.get(id)?.status === 'degraded');
      void this.runChecks(down, false);
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private checkOne(id: ProviderId, manual: boolean): Promise<ConnectionHealth> {
    const running = this.inFlight.get(id);
    if (running && (running.manual || !manual)) return running.promise;
    // A manual check waits for the periodic one in flight, then runs its own (it may restart things).
    const after = running ? running.promise.catch(() => undefined) : Promise.resolve();
    const entry = { promise: after.then(() => this.doCheck(id, manual)), manual };
    const clear = () => { if (this.inFlight.get(id) === entry) this.inFlight.delete(id); };
    entry.promise.then(clear, clear);
    this.inFlight.set(id, entry);
    return entry.promise;
  }

  private async doCheck(id: ProviderId, manual: boolean): Promise<ConnectionHealth> {
    const name = NAMES[id];
    const base = { provider: id, installed: false, path: null, version: null, latestVersion: null, updateAvailable: false, signedIn: null, processOk: false } as const;
    let path: string | null = null;
    try { path = await this.opts.findBinary(id); } catch { /* treated as not installed */ }
    if (!path) {
      this.versions.delete(id);
      return this.publish({ ...base, status: 'not_installed', message: `${name} isn't installed.` });
    }

    // The installed version is cheap to read, so read it every time; the registry only when due or still unknown.
    const previous = this.versions.get(id) ?? null;
    const version = await this.opts.getVersion(id, path).catch(() => null);
    this.versions.set(id, version);
    const needLatest = this.versionsDue.delete(id) || !this.latestVersions.get(id);
    const latestPromise = needLatest
      ? this.opts.getLatest(id).catch(() => null).then((v) => { this.latestVersions.set(id, v); })
      : Promise.resolve();

    const adapter = await this.opts.adapters.ensure(id, path);
    if (adapter && previous && version && previous !== version) {
      // The binary changed under a running helper process: restart it when nothing is running on it.
      await adapter.restartIfIdle?.().catch(() => false);
    }
    let ping: { ok: boolean; signedIn: boolean | null; message?: string } | null = null;
    if (adapter) {
      try { ping = await adapter.ping({ manual }); } catch { ping = null; }
    }
    await latestPromise;
    const latestVersion = this.latestVersions.get(id) ?? null;
    const updateAvailable = !!(version && latestVersion && newer(latestVersion, version));

    const common = { ...base, installed: true, path, version, latestVersion, updateAvailable };
    if (!ping?.ok) {
      return this.publish({ ...common, status: 'degraded', message: ping?.message || `${name} didn't respond. Restarting it…` });
    }
    const ok = { ...common, signedIn: ping.signedIn, processOk: true };
    if (ping.signedIn === false) return this.publish({ ...ok, status: 'signed_out', message: `${name} isn't signed in.` });
    if (updateAvailable) return this.publish({ ...ok, status: 'update_available', message: `${name} ${latestVersion} is available (you have ${version}).` });
    return this.publish({ ...ok, status: 'connected', message: ping.message ? `Connected. ${ping.message}` : null });
  }

  /** Stores the new health and tells the listener only when something other than checkedAt changed. */
  private publish(h: Omit<ConnectionHealth, 'checkedAt'>): ConnectionHealth {
    const health: ConnectionHealth = { ...h, checkedAt: (this.opts.now?.() ?? new Date()).toISOString() };
    const before = this.current.get(h.provider);
    this.current.set(h.provider, health);
    if (!before || changed(before, health)) this.opts.onUpdate(health);
    return health;
  }
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
  retryMs?: number; // how soon a degraded provider is looked at again, default 5 s
}
