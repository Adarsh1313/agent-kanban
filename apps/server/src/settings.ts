import type { HistoryChat, ProviderId, Settings } from '@agent-kanban/shared';

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];

/** The part of Store that settings need (one row per key, JSON text). */
export interface SettingsBackend {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

/** A PATCH that can't be applied; the API answers 400 with the message. */
export class SettingsError extends Error {}

const allOn = (): Record<ProviderId, boolean> => ({ claude: true, codex: true, antigravity: true });

export function defaultSettings(): Settings {
  return { onboarded: false, showChats: allOn(), suggest: allOn(), hiddenProjects: [], unhiddenProjects: [], homeProvider: null, skillSync: false, notesProjects: [] };
}

function readJson(backend: SettingsBackend, key: string): unknown {
  const raw = backend.getSetting(key);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Stored per-provider flags over the defaults: unknown keys and non-booleans are ignored. */
function readFlags(v: unknown): Record<ProviderId, boolean> {
  const out = allOn();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const id of PROVIDERS) {
      const f = (v as Record<string, unknown>)[id];
      if (typeof f === 'boolean') out[id] = f;
    }
  }
  return out;
}

/** Stored folder list: anything that isn't a non-empty string is dropped. */
function readPaths(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Agent Kanban's own preferences (onboarding done, which providers' chats to show and suggest, hidden projects), kept in the store. */
export class SettingsStore {
  private backend: SettingsBackend;

  constructor(backend: SettingsBackend) { this.backend = backend; }

  get(): Settings {
    const onboarded = readJson(this.backend, 'onboarded');
    const rawHome = readJson(this.backend, 'homeProvider');
    const homeProvider = PROVIDERS.includes(rawHome as ProviderId) ? rawHome as ProviderId : null;
    const skillSync = readJson(this.backend, 'skillSync');
    return {
      onboarded: typeof onboarded === 'boolean' ? onboarded : false,
      showChats: readFlags(readJson(this.backend, 'showChats')),
      suggest: readFlags(readJson(this.backend, 'suggest')),
      hiddenProjects: readPaths(readJson(this.backend, 'hiddenProjects')),
      unhiddenProjects: readPaths(readJson(this.backend, 'unhiddenProjects')),
      homeProvider,
      // On by default once a home provider is picked.
      skillSync: typeof skillSync === 'boolean' ? skillSync : homeProvider !== null,
      notesProjects: readPaths(readJson(this.backend, 'notesProjects')),
    };
  }

  /**
   * Applies a partial update, e.g. `{ suggest: { codex: false } }`. Everything is checked before anything is
   * written, so a bad request changes nothing.
   */
  patch(body: Record<string, unknown>): Settings {
    const next = this.get();
    let explicitSync = this.backend.getSetting('skillSync') !== undefined;
    for (const [key, value] of Object.entries(body)) {
      if (key === 'onboarded') {
        if (typeof value !== 'boolean') throw new SettingsError('Onboarded must be true or false.');
        next.onboarded = value;
      } else if (key === 'showChats' || key === 'suggest') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError(`"${key}" must be an object like { "codex": false }.`);
        for (const [id, flag] of Object.entries(value as Record<string, unknown>)) {
          if (!PROVIDERS.includes(id as ProviderId)) throw new SettingsError('Unknown provider. Use claude, codex or antigravity.');
          if (typeof flag !== 'boolean') throw new SettingsError(`"${key}.${id}" must be true or false.`);
          next[key][id as ProviderId] = flag;
        }
      } else if (key === 'homeProvider') {
        if (value !== null && !PROVIDERS.includes(value as ProviderId)) throw new SettingsError('Unknown provider. Use claude, codex or antigravity.');
        next.homeProvider = value as ProviderId | null;
      } else if (key === 'skillSync') {
        if (typeof value !== 'boolean') throw new SettingsError('Skill sync must be true or false.');
        next.skillSync = value;
        explicitSync = true;
      } else if (key === 'hiddenProjects' || key === 'unhiddenProjects' || key === 'notesProjects') {
        if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && x.trim() !== '')) throw new SettingsError(`"${key}" must be a list of folders.`);
        next[key] = value as string[];
      } else {
        throw new SettingsError(`You can't change "${key}".`);
      }
    }
    this.backend.setSetting('onboarded', JSON.stringify(next.onboarded));
    this.backend.setSetting('showChats', JSON.stringify(next.showChats));
    this.backend.setSetting('suggest', JSON.stringify(next.suggest));
    this.backend.setSetting('hiddenProjects', JSON.stringify(next.hiddenProjects));
    this.backend.setSetting('unhiddenProjects', JSON.stringify(next.unhiddenProjects));
    this.backend.setSetting('homeProvider', JSON.stringify(next.homeProvider));
    this.backend.setSetting('notesProjects', JSON.stringify(next.notesProjects));
    // Left unset until chosen, so picking a home provider later turns sync on by default.
    if (explicitSync) this.backend.setSetting('skillSync', JSON.stringify(next.skillSync));
    return this.get();
  }

  /** Providers the "Most room" suggestion may pick. */
  suggestable(): ProviderId[] {
    const s = this.get().suggest;
    return PROVIDERS.filter((id) => s[id]);
  }

  /** History with the chats of providers the user chose to hide removed. */
  filterHistory(history: HistoryChat[]): HistoryChat[] {
    const show = this.get().showChats;
    return history.filter((h) => show[h.provider] !== false);
  }
}
