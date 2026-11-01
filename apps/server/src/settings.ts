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
  return { onboarded: false, showChats: allOn(), suggest: allOn(), hiddenProjects: [], unhiddenProjects: [], suggestNextSteps: true, myProjects: null };
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

const isPaths = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** My projects: null (never picked) unless a folder list is stored. */
function readMine(v: unknown): string[] | null {
  return Array.isArray(v) ? readPaths(v) : null;
}

/** Agent Kanban's own preferences (onboarding done, which providers' chats to show and suggest, hidden projects), kept in the store. */
export class SettingsStore {
  private backend: SettingsBackend;

  constructor(backend: SettingsBackend) { this.backend = backend; }

  get(): Settings {
    const onboarded = readJson(this.backend, 'onboarded');
    const nextSteps = readJson(this.backend, 'suggestNextSteps');
    return {
      onboarded: typeof onboarded === 'boolean' ? onboarded : false,
      showChats: readFlags(readJson(this.backend, 'showChats')),
      suggest: readFlags(readJson(this.backend, 'suggest')),
      hiddenProjects: readPaths(readJson(this.backend, 'hiddenProjects')),
      unhiddenProjects: readPaths(readJson(this.backend, 'unhiddenProjects')),
      suggestNextSteps: typeof nextSteps === 'boolean' ? nextSteps : true,
      myProjects: readMine(readJson(this.backend, 'myProjects')),
    };
  }

  /**
   * Applies a partial update, e.g. `{ suggest: { codex: false } }`. Everything is checked before anything is
   * written, so a bad request changes nothing.
   */
  patch(body: Record<string, unknown>): Settings {
    const next = this.get();
    for (const [key, value] of Object.entries(body)) {
      if (key === 'onboarded' || key === 'suggestNextSteps') {
        if (typeof value !== 'boolean') throw new SettingsError(`"${key}" must be true or false.`);
        next[key] = value;
      } else if (key === 'showChats' || key === 'suggest') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError(`"${key}" must be an object like { "codex": false }.`);
        for (const [id, flag] of Object.entries(value as Record<string, unknown>)) {
          if (!PROVIDERS.includes(id as ProviderId)) throw new SettingsError('Unknown provider. Use claude, codex or antigravity.');
          if (typeof flag !== 'boolean') throw new SettingsError(`"${key}.${id}" must be true or false.`);
          next[key][id as ProviderId] = flag;
        }
      } else if (key === 'hiddenProjects' || key === 'unhiddenProjects') {
        if (!isPaths(value)) throw new SettingsError(`"${key}" must be a list of folders.`);
        next[key] = value as string[];
      } else if (key === 'myProjects') {
        if (value !== null && !isPaths(value)) throw new SettingsError('"myProjects" must be a list of folders, or null.');
        next.myProjects = value as string[] | null;
      } else {
        throw new SettingsError(`You can't change "${key}".`);
      }
    }
    this.backend.setSetting('onboarded', JSON.stringify(next.onboarded));
    this.backend.setSetting('showChats', JSON.stringify(next.showChats));
    this.backend.setSetting('suggest', JSON.stringify(next.suggest));
    this.backend.setSetting('hiddenProjects', JSON.stringify(next.hiddenProjects));
    this.backend.setSetting('unhiddenProjects', JSON.stringify(next.unhiddenProjects));
    this.backend.setSetting('suggestNextSteps', JSON.stringify(next.suggestNextSteps));
    this.backend.setSetting('myProjects', JSON.stringify(next.myProjects));
    return next;
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
