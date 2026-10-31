import { watch, type FSWatcher } from 'node:fs';
import type { ProviderId, SkillsReport } from '@agent-kanban/shared';
import { sourceRoots, sourceSkills, syncSkills } from './sync.ts';

const DEBOUNCE_MS = 1_000;

/**
 * Runs skill sync when it is on: on start, when the home provider's skill folders change (debounced) and on
 * Sync now. Keeps the last report for GET /api/skills.
 */
export class SkillService {
  private home: string;
  private settings: () => { homeProvider: ProviderId | null; skillSync: boolean };
  private last: SkillsReport = { synced: [], skipped: [] };
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private watching: string | null = null;

  constructor(opts: { home: string; settings: () => { homeProvider?: ProviderId | null; skillSync?: boolean } }) {
    this.home = opts.home;
    this.settings = () => { const s = opts.settings(); return { homeProvider: s.homeProvider ?? null, skillSync: s.skillSync ?? false }; };
  }

  /** The last sync's result, or (sync off) nothing synced. */
  report(): SkillsReport { return this.last; }

  /** Names of the home provider's skills, for the composer's `/` list (empty until a home provider is picked). */
  names(): string[] {
    const { homeProvider } = this.settings();
    return homeProvider ? sourceSkills(this.home, homeProvider).map((s) => s.name).sort() : [];
  }

  sync(): SkillsReport {
    const { homeProvider, skillSync } = this.settings();
    this.rewatch();
    if (!homeProvider || !skillSync) { this.last = { synced: [], skipped: [] }; return this.last; }
    try { this.last = syncSkills(this.home, homeProvider); } catch (e) { console.error('[agent-kanban] skill sync failed', e); }
    return this.last;
  }

  /** Watches the current home provider's folders; called again whenever the settings may have changed. */
  private rewatch(): void {
    const { homeProvider, skillSync } = this.settings();
    const want = homeProvider && skillSync ? homeProvider : null;
    if (want === this.watching) return;
    this.unwatch();
    this.watching = want;
    if (!want) return;
    for (const root of sourceRoots(this.home, want)) {
      try {
        const w = watch(root, { recursive: true }, () => {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.sync(), DEBOUNCE_MS);
          this.timer.unref();
        });
        w.on('error', () => w.close());
        this.watchers.push(w);
      } catch { /* folder missing: nothing to watch yet */ }
    }
  }

  private unwatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.timer);
  }

  stop(): void { this.unwatch(); this.watching = null; }
}
