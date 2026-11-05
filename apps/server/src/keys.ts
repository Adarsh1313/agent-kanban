// The user's own API keys (#43). The desktop app's main process keeps them encrypted (apps/desktop/src/keys.ts);
// the server holds metadata only and asks for a key's value just before it starts a provider with it.
// Browser mode has no key store, so there is no KeyService and every key route answers 404.
// Spec: docs/specs/api-keys.md.
import { KEY_PROVIDERS, type ApiKey, type DesktopToServer, type KeyProvider, type KeyReply, type KeyRequest, type ServerEvent, type ServerToDesktop } from '@agent-kanban/shared';

/** Where the keys live: the desktop app's main process (or a fake in tests). */
export interface KeyVault {
  request(r: KeyRequest): Promise<unknown>;
}

export class KeyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The key store in the desktop app, reached over the server's IPC channel. */
export function desktopVault(channel: {
  send(m: ServerToDesktop): void;
  onMessage(fn: (m: unknown) => void): void;
}, timeoutMs = 10_000): KeyVault {
  let next = 1;
  const waiting = new Map<number, (r: KeyReply) => void>();
  channel.onMessage((raw) => {
    const m = raw as DesktopToServer | null;
    if (m?.type !== 'keys.reply') return;
    const done = waiting.get(m.reqId);
    if (!done) return;
    waiting.delete(m.reqId);
    done(m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error });
  });
  return {
    request(request) {
      const reqId = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(reqId);
          reject(new KeyError(503, "The desktop app didn't answer. Try again."));
        }, timeoutMs);
        waiting.set(reqId, (r) => {
          clearTimeout(timer);
          if (r.ok) resolve(r.result);
          else reject(new KeyError(409, r.error));
        });
        channel.send({ type: 'keys', reqId, request });
      });
    },
  };
}

/** The key has a cap and this month's spend has reached it. */
export const overCap = (k: ApiKey) => k.capUsd !== null && k.spentUsd >= k.capUsd;

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const MAX_NAME = 60;
const MAX_KEY = 1_000;
const MAX_CAP = 100_000;

export class KeyService {
  private vault: KeyVault;
  private emit: (e: ServerEvent) => void;
  private now: () => Date;
  private spending: Promise<unknown> = Promise.resolve();

  constructor(opts: { vault: KeyVault; broadcast?: (e: ServerEvent) => void; now?: () => Date }) {
    this.vault = opts.vault;
    this.emit = opts.broadcast ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** Metadata only. A key last used in an earlier month shows this month's spend: 0. */
  async list(): Promise<ApiKey[]> {
    const keys = (await this.vault.request({ op: 'list' })) as ApiKey[];
    return keys.map((k) => this.current(k));
  }

  async get(id: string): Promise<ApiKey> {
    const k = (await this.list()).find((x) => x.id === id);
    if (!k) throw new KeyError(404, 'API key not found.');
    return k;
  }

  async add(input: { provider: unknown; name: unknown; key: unknown }): Promise<ApiKey> {
    const provider = keyProvider(input.provider);
    const name = keyName(input.name);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!key) throw new KeyError(400, 'Paste the API key.');
    if (key.length > MAX_KEY || /\s/.test(key)) throw new KeyError(400, "That doesn't look like an API key.");
    const added = this.current((await this.vault.request({ op: 'add', provider, name, key })) as ApiKey);
    await this.announce();
    return added;
  }

  async update(id: string, patch: { name?: unknown; capUsd?: unknown }): Promise<ApiKey> {
    const next: { name?: string; capUsd?: number | null } = {};
    if (patch.name !== undefined) next.name = keyName(patch.name);
    if (patch.capUsd !== undefined) next.capUsd = capUsd(patch.capUsd);
    const updated = (await this.vault.request({ op: 'update', id, patch: next })) as ApiKey | null;
    if (!updated) throw new KeyError(404, 'API key not found.');
    await this.announce();
    return this.current(updated);
  }

  async remove(id: string): Promise<void> {
    const removed = (await this.vault.request({ op: 'remove', id })) as boolean;
    if (!removed) throw new KeyError(404, 'API key not found.');
    await this.announce();
  }

  /**
   * Adds a turn's cost to the key's spend this month (a new month starts again at 0). Calls run one at a
   * time, so two turns ending together both count.
   */
  addSpend(id: string, usd: number): Promise<ApiKey | null> {
    const run = this.spending.then(async () => {
      if (!(usd > 0)) return null;
      const k = (await this.list()).find((x) => x.id === id);
      if (!k) return null;
      const spentUsd = Math.round((k.spentUsd + usd) * 1e6) / 1e6;
      const updated = (await this.vault.request({ op: 'update', id, patch: { spentUsd, month: k.month } })) as ApiKey | null;
      await this.announce();
      return updated ? this.current(updated) : null;
    });
    this.spending = run.catch(() => null);
    return run;
  }

  /** The key's value, for a provider's spawn environment only. Never log, store or send it anywhere else. */
  async reveal(id: string): Promise<string> {
    const value = (await this.vault.request({ op: 'reveal', id })) as string | null;
    if (!value) throw new KeyError(404, 'API key not found.');
    return value;
  }

  private current(k: ApiKey): ApiKey {
    const month = monthOf(this.now());
    return k.month === month ? k : { ...k, spentUsd: 0, month };
  }

  private async announce(): Promise<void> {
    try { this.emit({ type: 'keys.updated', keys: await this.list() }); } catch { /* the next list call will catch up */ }
  }
}

function keyProvider(v: unknown): KeyProvider {
  if (typeof v !== 'string' || !KEY_PROVIDERS.includes(v as KeyProvider)) throw new KeyError(400, 'API keys are for claude or codex.');
  return v as KeyProvider;
}

function keyName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new KeyError(400, 'Give the key a name.');
  if (name.length > MAX_NAME) throw new KeyError(400, `Keep the name under ${MAX_NAME} characters.`);
  return name;
}

function capUsd(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_CAP) throw new KeyError(400, 'The spend cap must be a dollar amount above 0.');
  return Math.round(v * 100) / 100;
}
