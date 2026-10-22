import type { Chat, Column, ProviderId } from '@agent-kanban/shared';
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

const isSnoozed = (c: { snoozedUntil: string | null }, now: number) => c.snoozedUntil !== null && Date.parse(c.snoozedUntil) > now;
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function focusedProvider(s: AppState): ProviderId | null {
  if (s.ui.focusProvider) return s.ui.focusProvider;
  const p = s.ui.filters.provider;
  return p && p.length === 1 ? p[0]! : null;
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
  if (f.project && !f.project.includes(c.cwd)) return false;
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

/** Board chats that pass the filters and provider focus; archived and snoozed ones are hidden. */
export function visibleChats(s: AppState, now: number = Date.now()): Chat[] {
  const focus = focusedProvider(s);
  return Object.values(s.chats)
    .filter((c) => c.column !== null && !c.archived && !isSnoozed(c, now) && (!focus || c.provider === focus) && passes(c, s.ui.filters, now))
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
  return Object.values(s.chats).filter((c) => c.pinned && !c.archived && !isSnoozed(c, now)).sort(byRecent);
}

function sidebarChats(s: AppState, now: number): SidebarChat[] {
  const focus = focusedProvider(s);
  const known = new Set<string>();
  for (const c of Object.values(s.chats)) if (c.sessionRef) known.add(`${c.provider}\u0000${c.sessionRef}`);
  const fromBoard = Object.values(s.chats).filter((c) => !c.archived && !c.pinned && !isSnoozed(c, now)).map(toSidebar);
  const fromHistory: SidebarChat[] = s.history
    .filter((h) => !known.has(`${h.provider}\u0000${h.sessionRef}`))
    .map((h) => ({ key: `h:${h.provider}:${h.sessionRef}`, chatId: null, provider: h.provider, sessionRef: h.sessionRef, title: h.title, cwd: h.cwd, updatedAt: h.updatedAt, column: null, pinned: false }));
  return [...fromBoard, ...fromHistory].filter((c) => !focus || c.provider === focus);
}

/** Sidebar "Recent chats": the most recently active projects, each with its latest chats (design: 4 x 3). */
export function recentChatsByProject(
  s: AppState,
  now: number = Date.now(),
  limits: { projects: number; chats: number } = { projects: MAX_SIDEBAR_PROJECTS, chats: MAX_SIDEBAR_CHATS },
): ProjectGroup[] {
  const byProject = new Map<string, SidebarChat[]>();
  for (const c of sidebarChats(s, now)) {
    const list = byProject.get(c.cwd);
    if (list) list.push(c);
    else byProject.set(c.cwd, [c]);
  }
  const names = new Map(s.projects.map((p) => [p.id, p.name]));
  return [...byProject.entries()]
    .map(([projectId, list]) => ({ projectId, list: list.sort(byRecent) }))
    .sort((a, b) => byRecent(a.list[0]!, b.list[0]!))
    .slice(0, limits.projects)
    .map(({ projectId, list }) => ({ projectId, name: names.get(projectId) ?? baseName(projectId), chats: list.slice(0, limits.chats), total: list.length }));
}

/** The provider to preselect in New chat: the server's suggestion if allowed, else the first allowed one. */
export function suggestFor(s: AppState, allowed: ProviderId[]): { provider: ProviderId; suggested: boolean } | null {
  if (s.suggested && allowed.includes(s.suggested)) return { provider: s.suggested, suggested: true };
  const first = allowed[0];
  return first ? { provider: first, suggested: false } : null;
}

export function unreadCount(s: AppState): number {
  return s.notifications.filter((n) => n.unread).length;
}
