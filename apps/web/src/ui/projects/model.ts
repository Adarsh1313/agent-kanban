import type { Chat, Column, NeedsReason, Project, ProjectInfo, ProviderId } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import type { AppState } from '../../state/reducer.ts';
import { isArchived, isSnoozed, memoState } from '../../state/selectors.ts';
import { relativeTime } from '../board/format.ts';

/** The file each provider reads its project instructions from. */
export const INSTRUCTION_FILE: Record<ProviderId, string> = { claude: 'CLAUDE.md', codex: 'AGENTS.md', antigravity: 'GEMINI.md' };

/**
 * One folder, however a chat spelled it: no trailing separator, and Windows drive paths compare
 * case-insensitively with backslashes (the server groups projects the same way).
 */
export function folderKey(path: string): string {
  const t = path.trim().replace(/[\\/]+$/, '');
  return /^[a-z]:/i.test(t) || t.startsWith('\\\\') ? t.replace(/\//g, '\\').toLowerCase() : t;
}

/** A chat in a project: on the board (chatId set) or only in the provider's own history. */
export interface ProjectChat {
  key: string;
  chatId: string | null;
  chat: Chat | null;
  provider: ProviderId;
  sessionRef: string | null;
  title: string;
  cwd: string;
  model: string | null;
  column: Column | null;
  needsReason: NeedsReason | null;
  snoozed: boolean;
  updatedAt: string;
}

function buildIndex(s: AppState): Record<string, ProjectChat[]> {
  const out: Record<string, ProjectChat[]> = {};
  const add = (c: ProjectChat) => {
    const k = folderKey(c.cwd);
    (out[k] ??= []).push(c);
  };
  const known = new Set<string>();
  for (const c of Object.values(s.chats)) {
    if (c.sessionRef) known.add(`${c.provider}\u0000${c.sessionRef}`);
    if (isArchived(s, c)) continue;
    add({
      key: c.id, chatId: c.id, chat: c, provider: c.provider, sessionRef: c.sessionRef, title: c.title, cwd: c.cwd, model: c.model,
      column: c.column, needsReason: c.needsReason, snoozed: isSnoozed(c, s.now), updatedAt: c.updatedAt,
    });
  }
  for (const h of s.history) {
    if (known.has(`${h.provider}\u0000${h.sessionRef}`)) continue;
    add({
      key: `h:${h.provider}:${h.sessionRef}`, chatId: null, chat: null, provider: h.provider, sessionRef: h.sessionRef, title: h.title, cwd: h.cwd,
      model: null, column: null, needsReason: null, snoozed: false, updatedAt: h.updatedAt,
    });
  }
  return out;
}

/** Every project's chats (board chats that aren't archived, plus history-only ones), keyed by folderKey. One pass, shared by the list and the detail. */
export const chatsByFolder = memoState((s) => [s.chats, s.history, s.ui.archiving, s.now], buildIndex);

export interface ProviderStats { chats: number; lastAt: string; lastModel: string | null }
export interface ProjectStats {
  total: number;
  /** Chats on the board per column (snoozed ones are left out, as on the board). */
  columns: Record<Column, number>;
  /** History-only and snoozed chats: the grey end of the status bar. */
  quiet: number;
  providers: Partial<Record<ProviderId, ProviderStats>>;
  lastAt: string;
}

export function statsOf(list: ProjectChat[]): ProjectStats {
  const columns: Record<Column, number> = { running: 0, needs_you: 0, review: 0, done: 0 };
  const providers: Partial<Record<ProviderId, ProviderStats>> = {};
  let lastAt = '';
  let onBoard = 0;
  for (const c of list) {
    if (c.column && !c.snoozed) { columns[c.column] += 1; onBoard += 1; }
    const p = (providers[c.provider] ??= { chats: 0, lastAt: '', lastModel: null });
    p.chats += 1;
    if (c.updatedAt > p.lastAt) {
      p.lastAt = c.updatedAt;
      if (c.model) p.lastModel = c.model;
    } else if (!p.lastModel && c.model) p.lastModel = c.model;
    if (c.updatedAt > lastAt) lastAt = c.updatedAt;
  }
  return { total: list.length, columns, quiet: list.length - onBoard, providers, lastAt };
}

/**
 * Providers that have worked in a project, from its live chats; the server's list only when the store has
 * no chat there at all (so a provider card never says "0 chats").
 */
export function workedWith(project: Project, stats: ProjectStats, ids: ProviderId[]): ProviderId[] {
  if (stats.total > 0) return ids.filter((id) => stats.providers[id]);
  return ids.filter((id) => project.providers.some((p) => p.provider === id));
}

/**
 * The projects with a page: one per folder however it is spelled (C:, C:/a and C:\ are one row; the first
 * entry wins), and none for the empty folder history can carry.
 */
function dedupe(projects: Project[]): Project[] {
  const seen = new Set<string>();
  return projects.filter((p) => {
    if (p.id.trim() === '') return false;
    const k = folderKey(p.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
export const uniqueProjects = memoState((s) => [s.projects], (s) => dedupe(s.projects));

/** The project a route's id points at (the sidebar links by a chat's folder, which may be spelled differently). */
export function findByFolder(projects: Project[], id: string): Project | undefined {
  const k = folderKey(id);
  return projects.find((p) => p.id === id) ?? projects.find((p) => p.id.trim() !== '' && (folderKey(p.id) === k || folderKey(p.path) === k));
}

/** "just now", "5m ago", "yesterday", "3d ago"; "—" when there is no time. */
export function agoLabel(iso: string, now: number): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—';
  const r = relativeTime(iso, now);
  return r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** /api/projects/info reads the folder (git, files), so each path is asked once per page load; a failure is asked again. */
const infoCache = new Map<string, Promise<ProjectInfo>>();
const infoDone = new Map<string, ProjectInfo>();
/** Info already fetched for this path, so a revisit shows it at once (no skeleton flash). */
export const cachedProjectInfo = (path: string): ProjectInfo | undefined => infoDone.get(path);
export function loadProjectInfo(path: string, force = false): Promise<ProjectInfo> {
  let p = force ? undefined : infoCache.get(path);
  if (!p) {
    const entry: Promise<ProjectInfo> = api.projectInfo(path).then((info) => {
      if (infoCache.get(path) === entry) infoDone.set(path, info);
      return info;
    }, (e: unknown) => {
      if (infoCache.get(path) === entry) infoCache.delete(path);
      throw e;
    });
    p = entry;
    infoCache.set(path, entry);
  }
  return p;
}
/** Tests start without cached folder info. */
export const resetProjectInfoCache = () => { infoCache.clear(); infoDone.clear(); };
