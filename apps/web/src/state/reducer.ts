import type {
  Chat,
  Column,
  ConnectionHealth,
  HistoryChat,
  Message,
  NeedsReason,
  OpenRequest,
  Project,
  ProviderId,
  ServerEvent,
  ToolCall,
  UsageReading,
} from '@agent-kanban/shared';

export type AppNotification = {
  id: string;
  chatId: string;
  kind: Extract<ServerEvent, { type: 'notification' }>['kind'];
  at: string;
  unread: boolean;
};

/** null = not filtering on that key; an array = only these values (same semantics as design/board.html). */
export interface Filters {
  provider: ProviderId[] | null;
  project: string[] | null;
  status: Column[] | null;
  model: string[] | null;
  reason: NeedsReason[] | null;
  activity: 'hour' | 'today' | 'week' | null;
  source: ('here' | 'native')[] | null;
}

export interface UiState {
  view: 'board' | 'projects' | 'connections';
  projectId: string | null;
  openChatId: string | null;
  filters: Filters;
  focusProvider: ProviderId | null;
}

export interface SyncState {
  /** Counts every applied event; monotonic. */
  seq: number;
  /** Number of fetches in flight; events are only recorded in `touched` while this is above zero. */
  inflight: number;
  /** item key -> seq of the last event that wrote it while a fetch was in flight */
  touched: Record<string, number>;
  /** message key -> delta text received while a fetch was in flight */
  deltas: Record<string, string>;
}

export interface AppState {
  chats: Record<string, Chat>;
  messages: Record<string, Message[]>;
  /** chatId -> messageId -> text received so far */
  streaming: Record<string, Record<string, string>>;
  requests: Record<string, OpenRequest[]>;
  toolCalls: Record<string, ToolCall[]>;
  /** Partial: a provider has no reading until the server sends one. */
  usage: Partial<Record<ProviderId, UsageReading>>;
  suggested: ProviderId | null;
  connections: Partial<Record<ProviderId, ConnectionHealth>>;
  history: HistoryChat[];
  projects: Project[];
  notifications: AppNotification[];
  /** Chats whose thread was fetched with loadChat (see isChatLoaded). */
  loadedChats: Record<string, true>;
  /** Bookkeeping that lets a fetch tell which items an event wrote while it was in flight. */
  sync: SyncState;
  socket: 'live' | 'reconnecting' | 'unauthorized';
  ui: UiState;
}

export interface Snapshot {
  chats: Chat[];
  usage: UsageReading[];
  suggested: ProviderId | null;
  connections: ConnectionHealth[];
  history: HistoryChat[];
  projects: Project[];
}

const MAX_NOTIFICATIONS = 100;

export function initialState(): AppState {
  return {
    chats: {},
    messages: {},
    streaming: {},
    requests: {},
    toolCalls: {},
    usage: {},
    suggested: null,
    connections: {},
    history: [],
    projects: [],
    notifications: [],
    loadedChats: {},
    sync: { seq: 0, inflight: 0, touched: {}, deltas: {} },
    socket: 'reconnecting',
    ui: {
      view: 'board',
      projectId: null,
      openChatId: null,
      filters: { provider: null, project: null, status: null, model: null, reason: null, activity: null, source: null },
      focusProvider: null,
    },
  };
}

function upsertBy<T>(list: T[] | undefined, item: T, same: (a: T) => boolean): T[] {
  const cur = list ?? [];
  const i = cur.findIndex(same);
  if (i === -1) return [...cur, item];
  const next = cur.slice();
  next[i] = item;
  return next;
}

function omitKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = rec;
  return rest;
}

export const chatKey = (chatId: string) => `c:${chatId}`;
export const messageKey = (chatId: string, id: string) => `m:${chatId}:${id}`;
export const toolCallKey = (chatId: string, id: string) => `t:${chatId}:${id}`;
export const requestKey = (chatId: string, id: string) => `r:${chatId}:${id}`;

function bump(s: AppState, keys: string[], delta?: { key: string; text: string }): SyncState {
  const seq = s.sync.seq + 1;
  if (s.sync.inflight === 0) return { ...s.sync, seq };
  const touched = { ...s.sync.touched };
  for (const k of keys) touched[k] = seq;
  const deltas = delta ? { ...s.sync.deltas, [delta.key]: (s.sync.deltas[delta.key] ?? '') + delta.text } : s.sync.deltas;
  return { ...s.sync, seq, touched, deltas };
}

/** A fetch is starting: events from now on are remembered so the result can be merged with them. */
export function beginSync(s: AppState): { state: AppState; since: number } {
  return { state: { ...s, sync: { ...s.sync, inflight: s.sync.inflight + 1 } }, since: s.sync.seq };
}

export function endSync(s: AppState): AppState {
  const inflight = Math.max(0, s.sync.inflight - 1);
  return { ...s, sync: { ...s.sync, inflight, touched: inflight === 0 ? {} : s.sync.touched, deltas: inflight === 0 ? {} : s.sync.deltas } };
}

/** True when an event wrote this item after the fetch that started at `since`. */
export const touchedSince = (s: AppState, key: string, since: number): boolean => (s.sync.touched[key] ?? 0) > since;

export function applyEvent(s: AppState, e: ServerEvent, now: Date = new Date()): AppState {
  const mk = (keys: string[], patch: Partial<AppState>, delta?: { key: string; text: string }): AppState => ({ ...s, ...patch, sync: bump(s, keys, delta) });
  switch (e.type) {
    case 'chat.updated': {
      const patch: Partial<AppState> = { chats: { ...s.chats, [e.chat.id]: e.chat } };
      // Answered elsewhere (or the agent moved on): nothing is waiting on the user any more.
      if (e.chat.column !== 'needs_you' && (s.requests[e.chat.id]?.length ?? 0) > 0) {
        patch.requests = { ...s.requests, [e.chat.id]: [] };
      }
      return mk([chatKey(e.chat.id)], patch);
    }
    case 'message.delta': {
      const keys = [messageKey(e.chatId, e.messageId), chatKey(e.chatId)];
      const list = s.messages[e.chatId];
      const i = list ? list.findIndex((m) => m.id === e.messageId) : -1;
      if (list && i !== -1) {
        // The server stores a message on its first delta, so a fetched message may still be growing.
        const next = list.slice();
        next[i] = { ...list[i]!, text: list[i]!.text + e.text };
        return mk(keys, { messages: { ...s.messages, [e.chatId]: next } }, { key: keys[0]!, text: e.text });
      }
      const forChat = s.streaming[e.chatId] ?? {};
      return mk(keys, { streaming: { ...s.streaming, [e.chatId]: { ...forChat, [e.messageId]: (forChat[e.messageId] ?? '') + e.text } } }, { key: keys[0]!, text: e.text });
    }
    case 'message.completed': {
      const forChat = s.streaming[e.chatId];
      const streaming = forChat && e.message.id in forChat ? { ...s.streaming, [e.chatId]: omitKey(forChat, e.message.id) } : s.streaming;
      return mk([messageKey(e.chatId, e.message.id), chatKey(e.chatId)], {
        streaming,
        messages: { ...s.messages, [e.chatId]: upsertBy(s.messages[e.chatId], e.message, (m) => m.id === e.message.id) },
      });
    }
    case 'tool.call':
      return mk([toolCallKey(e.chatId, e.toolCall.id), chatKey(e.chatId)], {
        toolCalls: { ...s.toolCalls, [e.chatId]: upsertBy(s.toolCalls[e.chatId], e.toolCall, (t) => t.id === e.toolCall.id) },
      });
    case 'request.opened': {
      const cur = s.requests[e.chatId] ?? [];
      if (cur.some((r) => r.requestId === e.requestId)) return mk([], {});
      const req: OpenRequest = { requestId: e.requestId, kind: e.kind, summary: e.summary, createdAt: now.toISOString() };
      return mk([requestKey(e.chatId, e.requestId), chatKey(e.chatId)], { requests: { ...s.requests, [e.chatId]: [...cur, req] } });
    }
    case 'request.closed': {
      const cur = s.requests[e.chatId] ?? [];
      return mk([requestKey(e.chatId, e.requestId), chatKey(e.chatId)], {
        requests: { ...s.requests, [e.chatId]: cur.filter((r) => r.requestId !== e.requestId) },
      });
    }
    case 'usage.updated':
      return mk([], { usage: { ...s.usage, [e.reading.provider]: e.reading } });
    case 'connection.updated':
      return mk([], { connections: { ...s.connections, [e.health.provider]: e.health } });
    case 'notification': {
      const item: AppNotification = { id: `n${s.sync.seq + 1}`, chatId: e.chatId, kind: e.kind, at: now.toISOString(), unread: true };
      return mk([chatKey(e.chatId)], { notifications: [item, ...s.notifications].slice(0, MAX_NOTIFICATIONS) });
    }
  }
}

/** Inserts or updates chats without dropping any; a copy already in the store that is newer wins. */
export function mergeChats(s: AppState, chats: Chat[]): AppState {
  const merged = { ...s.chats };
  for (const c of chats) {
    const cur = merged[c.id];
    if (!cur || cur.updatedAt <= c.updatedAt) merged[c.id] = c;
  }
  return { ...s, chats: merged };
}

/**
 * Replaces server-owned lists with a fresh full snapshot (initial load and resync). `since` is the
 * sync position when the fetch started: a chat an event touched after that is newer than the snapshot,
 * so its copy is kept even if the snapshot lacks it; any other chat the snapshot lacks is gone
 * (archived or removed elsewhere).
 */
export function applySnapshot(s: AppState, snap: Snapshot, since: number = s.sync.seq): AppState {
  const chats: Record<string, Chat> = {};
  for (const c of snap.chats) chats[c.id] = c;
  for (const [id, cur] of Object.entries(s.chats)) {
    if (!touchedSince(s, chatKey(id), since)) continue;
    const fetched = chats[id];
    if (!fetched || cur.updatedAt > fetched.updatedAt) chats[id] = cur;
  }
  const gone = (id: string) => id in s.chats && !(id in chats);
  const keepKnown = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !gone(id)));

  const streaming: AppState['streaming'] = {};
  for (const [id, texts] of Object.entries(keepKnown(s.streaming))) {
    const chat = chats[id];
    // Unknown chats stay buffered; known ones keep partial text only while still running.
    if (!chat || chat.column === 'running') streaming[id] = texts;
  }

  const requests: AppState['requests'] = {};
  for (const [id, list] of Object.entries(keepKnown(s.requests))) {
    const chat = chats[id];
    if (!chat || chat.column === 'needs_you') requests[id] = list;
  }

  const usage = { ...s.usage };
  for (const r of snap.usage) usage[r.provider] = r;
  const connections = { ...s.connections };
  for (const h of snap.connections) connections[h.provider] = h;

  return {
    ...s,
    chats,
    streaming,
    requests,
    messages: keepKnown(s.messages),
    toolCalls: keepKnown(s.toolCalls),
    // Cached threads may have missed events while the socket was down: they must be fetched again.
    loadedChats: {},
    usage,
    connections,
    suggested: snap.suggested,
    history: snap.history,
    projects: snap.projects,
  };
}

export const isChatLoaded = (s: AppState, id: string): boolean => s.loadedChats[id] === true;

/** Chat ids that events or loaded data refer to but whose chat the store does not have. */
export function missingChats(s: AppState): string[] {
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!(id in s.chats)) seen.add(id);
  };
  for (const id of Object.keys(s.streaming)) add(id);
  for (const id of Object.keys(s.messages)) add(id);
  for (const id of Object.keys(s.requests)) add(id);
  for (const id of Object.keys(s.toolCalls)) add(id);
  for (const n of s.notifications) add(n.chatId);
  return [...seen];
}

export interface FetchedThread {
  messages?: Message[];
  requests?: OpenRequest[];
  toolCalls?: ToolCall[];
}

function mergeById<T extends { id: string }>(current: T[], fetched: T[], touched: (id: string) => boolean): T[] {
  const byId = new Map(fetched.map((x) => [x.id, x]));
  for (const c of current) if (touched(c.id) || !byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()];
}

/**
 * Folds data fetched since `since` into the store without losing what events wrote meanwhile:
 * messages and tool calls are united by id (the event's copy wins); requests are only written while
 * the chat is still waiting on the user, and a request an event opened or closed keeps the event's verdict.
 */
export function mergeFetched(s: AppState, chatId: string, part: FetchedThread, since: number): AppState {
  const next: AppState = { ...s };

  if (part.messages) {
    const merged = mergeById(s.messages[chatId] ?? [], part.messages, (id) => touchedSince(s, messageKey(chatId, id), since));
    const byId = new Map(merged.map((m) => [m.id, m]));
    const streaming = { ...(s.streaming[chatId] ?? {}) };
    for (const mid of Object.keys(streaming)) {
      const msg = byId.get(mid);
      if (!msg) continue;
      // Deltas that arrived during the fetch may or may not be in the fetched copy: add them unless it already ends with them.
      const late = s.sync.deltas[messageKey(chatId, mid)];
      if (late && touchedSince(s, messageKey(chatId, mid), since) && !(s.messages[chatId] ?? []).some((m) => m.id === mid) && !msg.text.endsWith(late)) {
        byId.set(mid, { ...msg, text: msg.text + late });
      }
      delete streaming[mid];
    }
    next.messages = { ...s.messages, [chatId]: [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)) };
    next.streaming = { ...s.streaming, [chatId]: streaming };
    next.loadedChats = { ...s.loadedChats, [chatId]: true };
  }

  if (part.toolCalls) {
    next.toolCalls = {
      ...s.toolCalls,
      [chatId]: mergeById(s.toolCalls[chatId] ?? [], part.toolCalls.map((t) => ({ ...t })), (id) => touchedSince(s, toolCallKey(chatId, id), since)),
    };
  }

  if (part.requests && s.chats[chatId]?.column === 'needs_you') {
    const current = s.requests[chatId] ?? [];
    const open = new Set(current.map((r) => r.requestId));
    const out: OpenRequest[] = [];
    for (const r of part.requests) {
      if (!touchedSince(s, requestKey(chatId, r.requestId), since) || open.has(r.requestId)) out.push(open.has(r.requestId) ? current.find((c) => c.requestId === r.requestId)! : r);
    }
    for (const r of current) {
      if (touchedSince(s, requestKey(chatId, r.requestId), since) && !out.some((o) => o.requestId === r.requestId)) out.push(r);
    }
    next.requests = { ...s.requests, [chatId]: out };
  }

  return next;
}
