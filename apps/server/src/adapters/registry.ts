import type { ProviderId } from '@agent-kanban/shared';
import type { ProviderAdapter } from './adapter.ts';

export interface AdapterSource {
  get(id: ProviderId): ProviderAdapter | undefined;
  /** The adapter for `id`, creating it on first use if the provider's binary has appeared since startup. */
  ensure(id: ProviderId, knownPath?: string): Promise<ProviderAdapter | undefined>;
  /** Calls `fn` for every adapter that exists now and every one created later. */
  onAdapter(fn: (id: ProviderId, adapter: ProviderAdapter) => void): void;
}

/** Adapters created lazily, so a provider installed after the server started works without a restart. */
export class AdapterRegistry implements AdapterSource {
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private paths = new Map<ProviderId, string>();
  private creating = new Map<ProviderId, Promise<ProviderAdapter | undefined>>();
  private listeners: Array<(id: ProviderId, adapter: ProviderAdapter) => void> = [];
  private findBinary: (id: ProviderId) => Promise<string | null>;
  private create: (id: ProviderId, path: string) => ProviderAdapter | undefined;
  private disposed = false;

  constructor(opts: {
    findBinary: (id: ProviderId) => Promise<string | null>;
    create: (id: ProviderId, path: string) => ProviderAdapter | undefined;
  }) {
    this.findBinary = opts.findBinary;
    this.create = opts.create;
  }

  /** A registry over adapters that already exist (tests, or callers with nothing to discover). */
  static of(map: Partial<Record<ProviderId, ProviderAdapter>>): AdapterRegistry {
    const r = new AdapterRegistry({ findBinary: async () => null, create: () => undefined });
    for (const [id, a] of Object.entries(map) as [ProviderId, ProviderAdapter | undefined][]) if (a) r.adapters.set(id, a);
    return r;
  }

  get(id: ProviderId): ProviderAdapter | undefined { return this.adapters.get(id); }

  onAdapter(fn: (id: ProviderId, adapter: ProviderAdapter) => void): void {
    this.listeners.push(fn);
    for (const [id, a] of this.adapters) fn(id, a);
  }

  ensure(id: ProviderId, knownPath?: string): Promise<ProviderAdapter | undefined> {
    const have = this.adapters.get(id);
    if (have && (!knownPath || this.paths.get(id) === undefined || this.paths.get(id) === knownPath)) return Promise.resolve(have);
    const running = this.creating.get(id);
    if (running) return running;
    const p = (async () => {
      const path = knownPath ?? (await this.findBinary(id).catch(() => null));
      if (!path || this.disposed) return have;
      // The binary moved (reinstalled elsewhere): swap adapters, but only once the old one has nothing running.
      if (have && have.isIdle && !have.isIdle()) return have;
      let adapter: ProviderAdapter | undefined;
      try { adapter = this.create(id, path); } catch (e) { console.error(`Couldn't set up ${id}:`, e); return have; }
      if (!adapter) return have;
      this.adapters.set(id, adapter);
      this.paths.set(id, path);
      for (const fn of this.listeners) fn(id, adapter);
      if (have) void Promise.resolve().then(() => have.dispose()).catch(() => {});
      return adapter;
    })().finally(() => { this.creating.delete(id); });
    this.creating.set(id, p);
    return p;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.adapters.values()].map((a) => Promise.resolve().then(() => a.dispose())));
  }
}
