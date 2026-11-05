// Chats that run on the user's own API key (#43) get their own adapter per key: its provider process is
// spawned with the key in its environment (ANTHROPIC_API_KEY / OPENAI_API_KEY) and nowhere else, so
// chats on the user's sign-in never see it. The key's value is asked for only when that process is made.
import { KEY_ENV, type KeyProvider, type ProviderId } from '@agent-kanban/shared';
import type { ProviderAdapter } from './adapter.ts';

export interface KeyedAdapterSource {
  /** The adapter already running for this key, if any. */
  get(keyId: string): ProviderAdapter | undefined;
  /** The adapter for this key, creating it (and so asking for the key) on first use. */
  ensure(keyId: string, provider: ProviderId): Promise<ProviderAdapter | undefined>;
  /** Calls `fn` for every keyed adapter created from now on. */
  onAdapter(fn: (provider: ProviderId, adapter: ProviderAdapter) => void): void;
}

export class KeyMismatchError extends Error {}

export class KeyedAdapters implements KeyedAdapterSource {
  private adapters = new Map<string, ProviderAdapter>();
  private creating = new Map<string, Promise<ProviderAdapter | undefined>>();
  private listeners: Array<(provider: ProviderId, adapter: ProviderAdapter) => void> = [];
  private reveal: (keyId: string) => Promise<{ provider: KeyProvider; value: string }>;
  private create: (provider: KeyProvider, env: Record<string, string>) => Promise<ProviderAdapter | undefined>;

  constructor(opts: {
    reveal: (keyId: string) => Promise<{ provider: KeyProvider; value: string }>;
    create: (provider: KeyProvider, env: Record<string, string>) => Promise<ProviderAdapter | undefined>;
  }) {
    this.reveal = opts.reveal;
    this.create = opts.create;
  }

  get(keyId: string): ProviderAdapter | undefined { return this.adapters.get(keyId); }

  onAdapter(fn: (provider: ProviderId, adapter: ProviderAdapter) => void): void { this.listeners.push(fn); }

  ensure(keyId: string, provider: ProviderId): Promise<ProviderAdapter | undefined> {
    const have = this.adapters.get(keyId);
    if (have) return Promise.resolve(have);
    const running = this.creating.get(keyId);
    if (running) return running;
    const p = (async () => {
      const key = await this.reveal(keyId);
      if (key.provider !== provider) throw new KeyMismatchError('That API key is for another provider.');
      const adapter = await this.create(key.provider, { [KEY_ENV[key.provider]]: key.value });
      if (!adapter) return undefined;
      this.adapters.set(keyId, adapter);
      for (const fn of this.listeners) fn(provider, adapter);
      return adapter;
    })().finally(() => { this.creating.delete(keyId); });
    this.creating.set(keyId, p);
    return p;
  }

  /** The key was deleted or changed: its process goes, and the next use asks for the key again. */
  async release(keyId: string): Promise<void> {
    const a = this.adapters.get(keyId);
    this.adapters.delete(keyId);
    if (a) await a.dispose().catch(() => {});
  }

  async dispose(): Promise<void> {
    const all = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.allSettled(all.map((a) => a.dispose()));
  }
}
