import type { ProviderId, UsageReading } from '@agent-kanban/shared';
import type { Store } from '../store.ts';

type Reader = () => Promise<UsageReading>;

const unsaved = new WeakSet<object>();

/** The reading for a provider that isn't installed: shown as is, never stored as the "last numbers we had". */
export function notInstalledReading(provider: ProviderId): UsageReading {
  const r: UsageReading = { provider, status: 'unavailable', windows: [], readAt: new Date().toISOString(), message: `${NAMES[provider]} isn't installed.` };
  unsaved.add(r);
  return r;
}

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

export class UsageService {
  private readers: Partial<Record<ProviderId, Reader>>;
  private store: Store;
  private onUpdate: (r: UsageReading) => void;
  private intervalMs: number;
  private timeoutMs: number;
  private inFlight = new Map<ProviderId, Promise<UsageReading>>();
  private last = new Map<ProviderId, UsageReading>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: {
    readers: Partial<Record<ProviderId, Reader>>;
    store: Store;
    onUpdate: (r: UsageReading) => void;
    intervalMs?: number;
    timeoutMs?: number;
  }) {
    this.readers = opts.readers;
    this.store = opts.store;
    this.onUpdate = opts.onUpdate;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(provider?: ProviderId): Promise<UsageReading[]> {
    const ids = provider
      ? [provider]
      : (Object.keys(this.readers) as ProviderId[]);
    const out = await Promise.all(ids.map((id) => this.readOne(id)));
    return out.filter((r): r is UsageReading => r !== undefined);
  }

  latest(): UsageReading[] {
    return [...this.last.values()];
  }

  private readOne(id: ProviderId): Promise<UsageReading | undefined> | undefined {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const reader = this.readers[id];
    if (!reader) return undefined;
    const p = this.doRead(id, reader).finally(() => {
      if (this.inFlight.get(id) === p) this.inFlight.delete(id);
    });
    this.inFlight.set(id, p);
    return p;
  }

  private async doRead(id: ProviderId, reader: Reader): Promise<UsageReading> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reading: UsageReading;
    try {
      const timed = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
      });
      reading = await Promise.race([reader(), timed]);
      if (reading.status !== 'error' && !unsaved.has(reading)) this.store.saveUsage(reading);
    } catch {
      const prev = this.store.lastUsage(id);
      reading = {
        provider: id,
        status: 'error',
        windows: prev?.windows ?? [],
        readAt: new Date().toISOString(),
        message: `Couldn't read ${NAMES[id]} usage. Showing the last numbers we had.`,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    this.last.set(id, reading);
    this.onUpdate(reading);
    return reading;
  }
}
