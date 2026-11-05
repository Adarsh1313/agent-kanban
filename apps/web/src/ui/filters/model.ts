import type { Column, ProviderId } from '@agent-kanban/shared';
import { folderKey, projectFolder } from '@agent-kanban/shared';
import type { AppState, Filters } from '../../state/reducer.ts';
import { inHiddenProject, isArchived, OLDER_MS, projectLabel, providerCounts } from '../../state/selectors.ts';
import { PROVIDER_IDS, providerName, type IconName } from '../primitives/index.ts';

export type FilterKey = keyof Filters;

/** Which filters a menu or chip row works on: the board's, or All chats' own (Project and Provider only). */
export type FilterScope = 'board' | 'chats';
export const filtersIn = (s: AppState, scope: FilterScope): Filters => (scope === 'chats' ? s.ui.chatsFilters : s.ui.filters);

export interface FilterOption {
  v: string;
  label: string;
  /** What to draw before the label (design: provider logo, status icon). */
  provider?: ProviderId;
  status?: Column;
  /** A project with no activity for 30 days: listed after the others, under its own label. */
  older?: boolean;
}

export interface Category {
  label: string;
  icon: IconName;
  /** Chip text for three or more values: "3 providers". */
  plural: string;
  /** One value at a time (no Select all / None). */
  single?: boolean;
}

/** Categories in design/board.html order. */
export const FILTER_KEYS: FilterKey[] = ['provider', 'project', 'status', 'model', 'reason', 'activity', 'source'];
/** The categories each scope offers. */
export const SCOPE_KEYS: Record<FilterScope, FilterKey[]> = { board: FILTER_KEYS, chats: ['provider', 'project'] };

export const CATEGORIES: Record<FilterKey, Category> = {
  provider: { label: 'Provider', icon: 'plug', plural: 'providers' },
  project: { label: 'Project', icon: 'projects', plural: 'projects' },
  status: { label: 'Status', icon: 'board', plural: 'statuses' },
  model: { label: 'Model', icon: 'gauge', plural: 'models' },
  reason: { label: 'Waiting on you for', icon: 'bell', plural: 'reasons' },
  activity: { label: 'Last activity', icon: 'clock', plural: 'times', single: true },
  source: { label: 'Started in', icon: 'external', plural: 'places' },
};

const STATUS: [Column, string][] = [['running', 'Running'], ['needs_you', 'Needs you'], ['review', 'Review'], ['done', 'Done']];
const REASONS: [string, string][] = [
  ['permission', 'Permission to run a command'],
  ['question', 'An answer to a question'],
  ['waiting', 'Waiting for you'],
  ['stopped', 'You stopped it'],
  ['limit', 'Out of usage'],
  ['error', 'Something went wrong'],
  ['interrupted', 'Interrupted'],
  ['spend-cap', 'Spend cap reached'],
];
const ACTIVITY: [string, string][] = [['hour', 'In the last hour'], ['today', 'Today'], ['week', 'This week']];
const SOURCE: [string, string][] = [['here', 'Agent Kanban'], ['native', 'The provider’s own app']];

/** The values chosen for a category, as a list (null = not filtering on it). */
export function selected(f: Filters, key: FilterKey): string[] | null {
  if (key === 'activity') return f.activity ? [f.activity] : null;
  return f[key] as string[] | null;
}

/** Values seen in the data, plus any value already chosen (so it can still be unticked). */
function fromData(values: Iterable<string>, chosen: string[] | null): string[] {
  const set = new Set(values);
  for (const v of chosen ?? []) set.add(v);
  return [...set];
}

/** The options a category offers, from the current data: providers and projects with chats, models seen on chats. */
export function filterOptions(s: AppState, key: FilterKey, scope: FilterScope = 'board'): FilterOption[] {
  const chosen = selected(filtersIn(s, scope), key);
  const chats = Object.values(s.chats).filter((c) => !isArchived(s, c));
  switch (key) {
    case 'provider': {
      const counts = providerCounts(s);
      const present = PROVIDER_IDS.filter((p) => counts[p] > 0 || chosen?.includes(p));
      return (present.length ? present : PROVIDER_IDS).map((p) => ({ v: p, label: providerName(p), provider: p }));
    }
    case 'project': {
      // One option per project however its folder is spelled (the first spelling seen is the value); Claude scratch
      // chats are one project; hidden projects are left out unless already chosen. Older ones go last.
      const byKey = new Map<string, { v: string; last: string }>();
      const seen = (cwd: string, at: string) => {
        if (inHiddenProject(s, cwd) && !chosen?.some((v) => folderKey(projectFolder(v)) === folderKey(projectFolder(cwd)))) return;
        const k = folderKey(projectFolder(cwd));
        const cur = byKey.get(k);
        if (!cur) byKey.set(k, { v: projectFolder(cwd), last: at });
        else if (at > cur.last) cur.last = at;
      };
      for (const c of chats) seen(c.cwd, c.updatedAt);
      for (const h of s.history) seen(h.cwd, h.updatedAt);
      for (const v of chosen ?? []) seen(v, '');
      const cutoff = s.now - OLDER_MS;
      return [...byKey.values()]
        .map(({ v, last }) => ({ v, label: projectLabel(s, v), older: !last || Date.parse(last) < cutoff }))
        .sort((a, b) => Number(a.older) - Number(b.older) || a.label.localeCompare(b.label));
    }
    case 'status':
      return STATUS.map(([v, label]) => ({ v, label, status: v }));
    case 'model': {
      const providerOf = new Map<string, ProviderId>();
      for (const c of chats) if (c.model && !providerOf.has(c.model)) providerOf.set(c.model, c.provider);
      return fromData(providerOf.keys(), chosen)
        .sort((a, b) => a.localeCompare(b))
        .map((m) => ({ v: m, label: m, provider: providerOf.get(m) }));
    }
    case 'reason':
      return REASONS.map(([v, label]) => ({ v, label }));
    case 'activity':
      return ACTIVITY.map(([v, label]) => ({ v, label }));
    case 'source':
      return SOURCE.map(([v, label]) => ({ v, label }));
  }
}

/**
 * Sets one category. As in the design, choosing every option of a multi-value category means "no filter" (null);
 * an empty list stays and matches nothing ("none selected").
 */
export function withFilter(s: AppState, key: FilterKey, values: string[] | null, scope: FilterScope = 'board'): Filters {
  const f = filtersIn(s, scope);
  if (key === 'activity') return { ...f, activity: (values?.[0] as Filters['activity'] | undefined) ?? null };
  let next = values;
  if (next) {
    const all = filterOptions(s, key, scope).map((o) => o.v);
    const set = new Set(next);
    if (set.size === all.length && all.every((v) => set.has(v))) next = null;
  }
  return { ...f, [key]: next };
}

export const NO_FILTERS: Filters = { provider: null, project: null, status: null, model: null, reason: null, activity: null, source: null };

export const setFilter = (s: AppState, key: FilterKey, values: string[] | null, scope: FilterScope = 'board'): AppState =>
  ({ ...s, ui: { ...s.ui, [scope === 'chats' ? 'chatsFilters' : 'filters']: withFilter(s, key, values, scope) } });
export const clearAllFilters = (s: AppState, scope: FilterScope = 'board'): AppState =>
  ({ ...s, ui: { ...s.ui, [scope === 'chats' ? 'chatsFilters' : 'filters']: NO_FILTERS } });
export const activeKeys = (f: Filters): FilterKey[] => FILTER_KEYS.filter((k) => f[k] !== null);

/** Chip parts, as design/board.html words them: "Provider" "is any of" "Claude Code, Codex" / "3 providers" / "none selected". */
export function chipParts(s: AppState, key: FilterKey, scope: FilterScope = 'board'): { op: string; values: FilterOption[]; text: string | null } {
  const cat = CATEGORIES[key];
  const chosen = selected(filtersIn(s, scope), key) ?? [];
  const opts = filterOptions(s, key, scope).filter((o) => chosen.includes(o.v));
  const op = cat.single || chosen.length <= 1 ? 'is' : 'is any of';
  if (chosen.length === 0) return { op, values: [], text: 'none selected' };
  if (opts.length <= 2) return { op, values: opts, text: null };
  return { op, values: opts.slice(0, 2), text: `${opts.length} ${cat.plural}` };
}
