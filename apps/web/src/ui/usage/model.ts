import type { ProviderId, UsageReading, UsageWindow } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { applyUsage, type AppState } from '../../state/reducer.ts';
import type { Store } from '../../state/store.ts';
import { clockTime } from '../board/format.ts';
import { PROVIDER_IDS, providerName, toast } from '../primitives/index.ts';

export type Level = 'ok' | 'low' | 'out';

/** Meters turn amber under 25 % and red under 5 % (design/components.js `level`). */
export const levelOf = (left: number): Level => (left < 5 ? 'out' : left < 25 ? 'low' : 'ok');

export const windowOf = (r: UsageReading | undefined, kind: 'five_hour' | 'weekly'): UsageWindow | undefined =>
  r?.windows.find((w) => w.kind === kind);

export const modelWindows = (r: UsageReading | undefined): UsageWindow[] => r?.windows.filter((w) => w.kind === 'model') ?? [];

export const pct = (left: number) => `${Math.round(left)}%`;

/** Providers that get a chip: only those with a connection (installed). */
export function shownProviders(s: AppState): ProviderId[] {
  return PROVIDER_IDS.filter((id) => s.connections[id]?.installed === true);
}

/** The chip's number: the lower of 5-hour and weekly left; null when neither was read. */
export function chipPercent(r: UsageReading | undefined): number | null {
  const left = [windowOf(r, 'five_hour'), windowOf(r, 'weekly')].filter((w): w is UsageWindow => !!w).map((w) => w.leftPct);
  return left.length ? Math.min(...left) : null;
}

/** What a chip says instead of numbers, or null when it shows numbers. */
export function chipNote(r: UsageReading | undefined, installed = true): string | null {
  if (!installed) return 'Not connected';
  if (!r) return 'Checking…';
  if (r.status === 'signed_out') return 'Not signed in';
  if (r.status === 'unavailable') return 'Limits unavailable';
  if (chipPercent(r) === null) return r.status === 'error' ? "Couldn't read usage" : 'Limits unavailable';
  return null;
}

/** "Claude Code: 82% of 5-hour left, 64% of weekly left" (or the note, e.g. "Codex: Not signed in"). */
export function chipLabel(id: ProviderId, r: UsageReading | undefined, installed = true): string {
  const name = providerName(id);
  const note = chipNote(r, installed);
  if (note) return `${name}: ${note}`;
  const parts = [['5-hour', windowOf(r, 'five_hour')], ['weekly', windowOf(r, 'weekly')]] as const;
  const text = parts.filter(([, w]) => w).map(([n, w]) => `${pct(w!.leftPct)} of ${n} left`).join(', ');
  return `${name}: ${text}${r?.status === 'error' ? ' (last numbers we had)' : ''}`;
}

/**
 * "Resets 2:40 pm" today, "Resets Thu 9:00 am" within the week, "Resets Nov 21" further out (a weekday alone
 * would be ambiguous); null when the provider gave no reset time.
 */
export function resetText(w: UsageWindow, now: number): string | null {
  if (!w.resetsAt) return null;
  const at = Date.parse(w.resetsAt);
  if (!Number.isFinite(at)) return null;
  if (at - now >= 6 * 24 * 60 * 60_000) return `Resets ${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  return `Resets ${clockTime(w.resetsAt, now)}`;
}

/** "Updated just now", "Updated 5 min ago", "Updated 2:40 pm" (from the newest reading). */
export function updatedText(readings: (UsageReading | undefined)[], now: number): string | null {
  const times = readings.filter((r): r is UsageReading => !!r).map((r) => Date.parse(r.readAt)).filter(Number.isFinite);
  if (times.length === 0) return null;
  const at = Math.max(...times);
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  return `Updated ${clockTime(new Date(at).toISOString(), now)}`;
}

/** Asks every provider again; the answer goes into the store. A failure toasts the server's text and keeps the numbers. */
export async function refreshUsage(store: Store): Promise<boolean> {
  try {
    const res = await api.refreshUsage();
    store.setState((s) => applyUsage(s, res));
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    return false;
  }
}
