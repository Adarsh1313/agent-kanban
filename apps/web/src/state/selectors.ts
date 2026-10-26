import type { Chat, Column, ProviderId } from '@agent-kanban/shared';
import { folderKey } from '@agent-kanban/shared';
import type { AppState, Filters } from './reducer.ts';

const MINUTE = 60_000;
const ACTIVITY_LIMIT_MIN = { hour: 60, today: 1440, week: 10080 } as const;

export const MAX_SIDEBAR_PROJECTS = 4;
export const MAX_SIDEBAR_CHATS = 3;

/** A sidebar row: a board chat, or a history-only chat from the provider's own app (chatId null). */
export interface SidebarChat {
  key: string;
  chatId: string | null;
  provider: ProviderId;
  sessionRef: string | null;
  title: string;
  cwd: string;
  updatedAt: string;
  column: Column | null;
  pinned: boolean;
}

export interface ProjectGroup {
  projectId: string;
  name: string;
  chats: SidebarChat[];
  total: number;
}

export const isSnoozed = (c: { snoozedUntil: string | null }, now: number) => c.snoozedUntil !== null && Date.parse(c.snoozedUntil) > now;
/** Archived on the server, or archived here with its Undo toast still showing. */
export const isArchived = (s: AppState, c: { id: string; archived: boolean }) => c.archived || s.ui.archiving[c.id] === true;
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** A single-provider filter (set from the sidebar's provider rows or the Filter menu) focuses that provider. */
export function focusedProvider(s: AppState): ProviderId | null {
  const p = s.ui.filters.provider;
  return p?.length === 1 ? p[0]! : null;
}

interface Filterable {
  provider: ProviderId;
  cwd: string;
  column: Column | null;
  model: string | null;
  needsReason: string | null;
  updatedAt: string;
}

function passes(c: Filterable, f: Filters, now: number): boolean {
  if (f.provider && !f.provider.includes(c.provider)) return false;
  if (f.project && !f.project.some((p) => folderKey(p) === folderKey(c.cwd))) return false;
  if (f.status && !(c.column && f.status.includes(c.column))) return false;
  if (f.model && !(c.model !== null && f.model.includes(c.model))) return false;
  if (f.reason && !(c.needsReason !== null && (f.reason as string[]).includes(c.needsReason))) return false;
  if (f.activity) {
    const mins = (now - Date.parse(c.updatedAt)) / MINUTE;
    if (!(mins < ACTIVITY_LIMIT_MIN[f.activity])) return false;
  }
  // No startedHere field exists: chats on the board were started here, history-only ones in the provider's own app.
  if (f.source && !f.source.includes(c.column !== null ? 'here' : 'native')) return false;
  return true;
}

const byRecent = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

/** Board chats that pass the filters; archived and snoozed ones are hidden. */
export function visibleChats(s: AppState, now: number = Date.now()): Chat[] {
  return Object.values(s.chats)
    .filter((c) => c.column !== null && !isArchived(s, c) && !isSnoozed(c, now) && passes(c, s.ui.filters, now))
    .sort(byRecent);
}

export function boardColumns(s: AppState, now: number = Date.now()): Record<Column, Chat[]> {
  const cols: Record<Column, Chat[]> = { running: [], needs_you: [], review: [], done: [] };
  for (const c of visibleChats(s, now)) cols[c.column!].push(c);
  return cols;
}

const toSidebar = (c: Chat): SidebarChat => ({
  key: c.id, chatId: c.id, provider: c.provider, sessionRef: c.sessionRef, title: c.title, cwd: c.cwd, updatedAt: c.updatedAt, column: c.column, pinned: c.pinned,
});

export function pinned(s: AppState, now: number = Date.now()): Chat[] {
  return Object.values(s.chats).filter((c) => c.pinned && !isArchived(s, c) && !isSnoozed(c, now)).sort(byRecent);
}

function sidebarChats(s: AppState, now: number): SidebarChat[] {
  const known = new Set<string>();
  for (const c of Object.values(s.chats)) if (c.sessionRef) known.add(`${c.provider}\u0000${c.sessionRef}`);
  const f = s.ui.filters;
  const fromBoard = Object.values(s.chats).filter((c) => !isArchived(s, c) && !c.pinned && !isSnoozed(c, now) && passes(c, f, now)).map(toSidebar);
  const fromHistory: SidebarChat[] = s.history
    .filter((h) => !known.has(`${h.provider}\u0000${h.sessionRef}`) && passes({ ...h, column: null, model: null, needsReason: null }, f, now))
    .map((h) => ({ key: `h:${h.provider}:${h.sessionRef}`, chatId: null, provider: h.provider, sessionRef: h.sessionRef, title: h.title, cwd: h.cwd, updatedAt: h.updatedAt, column: null, pinned: false }));
  return [...fromBoard, ...fromHistory];
}

/** Sidebar "Recent chats": the most recently active projects, each with its latest chats (design: 4 x 3); the Filter applies here too. */
export function recentChatsByProject(
  s: AppState,
  now: number = Date.now(),
  limits: { projects: number; chats: number } = { projects: MAX_SIDEBAR_PROJECTS, chats: MAX_SIDEBAR_CHATS },
  /** Projects whose chats are all listed (the sidebar's "N more"). */
  expanded: ReadonlySet<string> = new Set(),
): ProjectGroup[] {
  // One group per folder however it is spelled; named and linked by the server's project when there is one.
  const known = new Map<string, { id: string; name: string }>();
  for (const p of s.projects) if (!known.has(folderKey(p.id))) known.set(folderKey(p.id), { id: p.id, name: p.name });
  const byProject = new Map<string, { projectId: string; name: string; list: SidebarChat[] }>();
  for (const c of sidebarChats(s, now)) {
    const k = folderKey(c.cwd);
    const g = byProject.get(k);
    if (g) g.list.push(c);
    else {
      const p = known.get(k);
      byProject.set(k, { projectId: p?.id ?? c.cwd, name: p?.name ?? baseName(c.cwd), list: [c] });
    }
  }
  return [...byProject.values()]
    .map(({ projectId, name, list }) => ({ projectId, name, list: list.sort(byRecent) }))
    .sort((a, b) => byRecent(a.list[0]!, b.list[0]!))
    .slice(0, limits.projects)
    .map(({ projectId, name, list }) => ({ projectId, name, chats: expanded.has(projectId) ? list : list.slice(0, limits.chats), total: list.length }));
}

/**
 * The provider to preselect in New chat: the suggestion if allowed, else the first allowed one whose
 * "Suggest it for new chats" is on, else the first allowed one.
 */
export function suggestFor(s: Pick<AppState, 'suggested'> & { settings?: AppState['settings'] }, allowed: ProviderId[]): { provider: ProviderId; suggested: boolean } | null {
  const ok = (id: ProviderId) => s.settings?.suggest[id] !== false;
  if (s.suggested && allowed.includes(s.suggested) && ok(s.suggested)) return { provider: s.suggested, suggested: true };
  const first = allowed.find(ok) ?? allowed[0];
  return first ? { provider: first, suggested: false } : null;
}

export function unreadCount(s: AppState): number {
  return s.notifications.filter((n) => n.unread).length;
}

/** Re-computes only when one of the referenced parts of the state changed (so streaming deltas do not re-sort the sidebar). */
export function memoState<R>(deps: (s: AppState) => readonly unknown[], fn: (s: AppState) => R): (s: AppState) => R {
  let last: { d: readonly unknown[]; r: R } | null = null;
  return (s) => {
    const d = deps(s);
    if (last && last.d.length === d.length && last.d.every((x, i) => Object.is(x, d[i]))) return last.r;
    const r = fn(s);
    last = { d, r };
    return r;
  };
}

/** Chats per provider for the sidebar's Providers rows: board chats plus provider-history chats not on the board. */
function countProviders(s: AppState): Record<ProviderId, number> {
  const counts: Record<ProviderId, number> = { claude: 0, codex: 0, antigravity: 0 };
  const known = new Set<string>();
  for (const c of Object.values(s.chats)) {
    if (c.sessionRef) known.add(`${c.provider}\u0000${c.sessionRef}`);
    if (!isArchived(s, c)) counts[c.provider] += 1;
  }
  for (const h of s.history) if (!known.has(`${h.provider}\u0000${h.sessionRef}`)) counts[h.provider] += 1;
  return counts;
}

export const providerCounts = memoState((s) => [s.chats, s.history, s.ui.archiving], countProviders);

/** The name to show for a project folder: the server's project name when known, else the folder's last part. */
export function projectLabel(s: AppState, projectId: string): string {
  const k = folderKey(projectId);
  return (s.projects.find((p) => p.id === projectId) ?? s.projects.find((p) => folderKey(p.id) === k))?.name ?? baseName(projectId);
}
