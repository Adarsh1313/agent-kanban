import type { Chat, Column, ProviderId } from '@agent-kanban/shared';
import { CLAUDE_SCRATCH_NAME, folderKey, isClaudeScratch, projectFolder } from '@agent-kanban/shared';
import type { AppState, Filters } from './reducer.ts';

const MINUTE = 60_000;

/** The folder a chat is grouped under: its "Move to project" label, else where it runs (#40). */
export const chatFolder = (c: { cwd: string; projectLabel?: string | null }): string => c.projectLabel || c.cwd;
const ACTIVITY_LIMIT_MIN = { hour: 60, today: 1440, week: 10080 } as const;

/** A project with no activity for this long is "Older": folded away in New chat and the Project filter. */
export const OLDER_MS = 30 * 86_400_000;

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


export const isSnoozed = (c: { snoozedUntil: string | null }, now: number) => c.snoozedUntil !== null && Date.parse(c.snoozedUntil) > now;
/** Archived on the server, or archived here with its Undo toast still showing. */
export const isArchived = (s: AppState, c: { id: string; archived: boolean }) => c.archived || s.ui.archiving[c.id] === true;
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * Folders (by folderKey) whose chats are kept out of every list: projects the server hid automatically (temp folder),
 * unless unhid, and the ones in the hiddenProjects setting. The settings win over the server's 'manual' mark, so Hide and Unhide
 * take effect before the project list is fetched again; before settings load, the server's mark is used.
 */
function buildHidden(s: AppState): ReadonlySet<string> {
  const out = new Set<string>();
  const shown = new Set((s.settings?.unhiddenProjects ?? []).map(folderKey));
  for (const p of s.projects) {
    const k = folderKey(p.id);
    if ((p.hidden === 'auto' && !shown.has(k)) || (p.hidden === 'manual' && !s.settings)) out.add(k);
  }
  for (const f of s.settings?.hiddenProjects ?? []) out.add(folderKey(f));
  return out;
}
export const hiddenFolders = memoState((s) => [s.projects, s.settings], buildHidden);
/** The server's projects without the hidden ones: what the sidebar, New chat and onboarding count. */
export const visibleProjects = memoState((s) => [s.projects, s.settings], (s) => s.projects.filter((p) => !hiddenFolders(s).has(folderKey(p.id))));
/** True when a chat in this folder belongs to a hidden project (Claude scratch chats count as their one project). */
export const inHiddenProject = (s: AppState, cwd: string) => hiddenFolders(s).has(folderKey(projectFolder(cwd)));

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
  if (f.project && !f.project.some((p) => folderKey(projectFolder(p)) === folderKey(projectFolder(chatFolder(c))))) return false;
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
    .filter((c) => !c.deletedAt && c.column !== null && !isArchived(s, c) && !isSnoozed(c, now) && !inHiddenProject(s, chatFolder(c)) && passes(c, s.ui.filters, now))
    .sort(byRecent);
}

export function boardColumns(s: AppState, now: number = Date.now()): Record<Column, Chat[]> {
  const cols: Record<Column, Chat[]> = { running: [], needs_you: [], review: [], done: [] };
  for (const c of visibleChats(s, now)) cols[c.column!].push(c);
  return cols;
}

const toSidebar = (c: Chat): SidebarChat => ({
  key: c.id, chatId: c.id, provider: c.provider, sessionRef: c.sessionRef, title: c.title, cwd: chatFolder(c), updatedAt: c.updatedAt, column: c.column, pinned: c.pinned,
});

export function pinned(s: AppState, now: number = Date.now()): Chat[] {
  return Object.values(s.chats).filter((c) => !c.deletedAt && c.pinned && !isArchived(s, c) && !isSnoozed(c, now) && !inHiddenProject(s, chatFolder(c))).sort(byRecent);
}

/**
 * Board chats (not archived) and history-only chats outside hidden projects that pass the filters. The sidebar
 * leaves out pinned and snoozed ones (`everything` false); All chats lists them too.
 */
function listedChats(s: AppState, now: number, f: Filters = s.ui.filters, everything = false, archived = false): SidebarChat[] {
  const known = new Set<string>();
  for (const c of Object.values(s.chats)) if (c.sessionRef) known.add(`${c.provider}\u0000${c.sessionRef}`);
  const fromBoard = Object.values(s.chats)
    .filter((c) => !c.deletedAt && isArchived(s, c) === archived && (everything || (!c.pinned && !isSnoozed(c, now))) && !inHiddenProject(s, chatFolder(c)) && passes(c, f, now))
    .map(toSidebar);
  const fromHistory: SidebarChat[] = s.history
    .filter((h) => Boolean(h.archived) === archived && !known.has(`${h.provider}\u0000${h.sessionRef}`) && !inHiddenProject(s, h.cwd) && passes({ ...h, column: null, model: null, needsReason: null }, f, now))
    .map((h) => ({ key: `h:${h.provider}:${h.sessionRef}`, chatId: null, provider: h.provider, sessionRef: h.sessionRef, title: h.title, cwd: h.cwd, updatedAt: h.updatedAt, column: null, pinned: false }));
  return [...fromBoard, ...fromHistory];
}

/** A sidebar or All chats row: a chat with the project it belongs to. */
export interface ListedChat extends SidebarChat {
  projectId: string;
  projectName: string;
}

/** The chats the sidebar's project cards draw from: not pinned, archived or snoozed, after the Filter, newest first. */
export function sidebarChats(s: AppState, now: number = Date.now()): ListedChat[] {
  return listedChats(s, now).sort(byRecent).map((c) => withProject(s, c));
}

/** How many of a project's newest chats its sidebar card lists (running and needs-you chats beyond these are listed too). */
export const CARD_CHATS = 3;

/** My projects that are not hidden, most recently active first; empty until the user has picked (settings.myProjects null). */
export const myProjects = memoState((s) => [s.projects, s.settings], (s) => {
  const mine = new Set((s.settings?.myProjects ?? []).map((p) => folderKey(projectFolder(p))));
  return visibleProjects(s).filter((p) => mine.has(folderKey(p.id))).sort((a, b) => byRecent({ updatedAt: a.lastActivityAt }, { updatedAt: b.lastActivityAt }));
});

/** A sidebar project card: the chats it lists, how many more there are, and its one-line summary. */
export interface ProjectCard {
  chats: SidebarChat[];
  more: number;
  running: number;
  /** Needs you plus Review: chats waiting on the user. */
  needsYou: number;
}

/** Chats grouped by project folder (folderKey), newest first, with the sidebar's filters; computed once for every card. */
const chatsByProject = memoState((s) => [s.chats, s.history, s.projects, s.settings, s.ui.filters, s.ui.archiving, s.now], (s) => {
  const out = new Map<string, ListedChat[]>();
  for (const c of sidebarChats(s, s.now)) {
    const k = folderKey(projectFolder(c.cwd));
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(c);
  }
  return out;
});

export function projectCard(s: AppState, projectId: string): ProjectCard {
  const all = chatsByProject(s).get(folderKey(projectId)) ?? [];
  const waiting = (c: SidebarChat) => c.column === 'running' || c.column === 'needs_you';
  const chats = [...all.slice(0, CARD_CHATS), ...all.slice(CARD_CHATS).filter(waiting)];
  return {
    chats,
    more: all.length - chats.length,
    running: all.filter((c) => c.column === 'running').length,
    needsYou: all.filter((c) => c.column === 'needs_you' || c.column === 'review').length,
  };
}

const NO_FILTERS: Filters = { provider: null, project: null, status: null, model: null, reason: null, activity: null, source: null };

/** Every visible chat, newest first, without any filter: what global search looks through. */
export const searchableChats = memoState((s) => [s.chats, s.history, s.projects, s.settings, s.ui.archiving, s.now], (s) =>
  listedChats(s, s.now, NO_FILTERS, true).sort(byRecent).map((c) => withProject(s, c)));

/** All chats: every chat on the board (pinned and snoozed too) or only in a provider's history, newest first, with All chats' own filters. */
export function allChats(s: AppState, now: number = Date.now()): ListedChat[] {
  if (s.ui.chatsMode === 'trash') return [];
  return listedChats(s, now, s.ui.chatsFilters, true, s.ui.chatsMode === 'archived').sort(byRecent).map((c) => withProject(s, c));
}

const withProject = (s: AppState, c: SidebarChat): ListedChat =>
  ({ ...c, projectId: findProjectFor(s, chatFolder(c))?.id ?? projectFolder(chatFolder(c)), projectName: projectLabel(s, chatFolder(c)) });

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
    if (!c.deletedAt && !isArchived(s, c) && !inHiddenProject(s, chatFolder(c))) counts[c.provider] += 1;
  }
  for (const h of s.history) if (!known.has(`${h.provider}\u0000${h.sessionRef}`) && !inHiddenProject(s, h.cwd)) counts[h.provider] += 1;
  return counts;
}

export const providerCounts = memoState((s) => [s.chats, s.history, s.ui.archiving, s.projects, s.settings], countProviders);

/** The server's project a chat's folder belongs to (Claude scratch chats belong to their one project), if it knows one. */
function findProjectFor(s: AppState, cwd: string) {
  const folder = projectFolder(cwd);
  const k = folderKey(folder);
  return s.projects.find((p) => p.id === folder) ?? s.projects.find((p) => folderKey(p.id) === k);
}

/** The name to show for a chat's or project's folder: the server's project name when known, else the folder's last part. */
export function projectLabel(s: AppState, cwd: string): string {
  return findProjectFor(s, cwd)?.name ?? (isClaudeScratch(cwd) ? CLAUDE_SCRATCH_NAME : baseName(cwd));
}
