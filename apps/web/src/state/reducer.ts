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

export function applyEvent(s: AppState, e: ServerEvent, now: Date = new Date()): AppState {
  switch (e.type) {
    case 'chat.updated': {
      const next: AppState = { ...s, chats: { ...s.chats, [e.chat.id]: e.chat } };
      // Answered elsewhere (or the agent moved on): nothing is waiting on the user any more.
      if (e.chat.column !== 'needs_you' && (s.requests[e.chat.id]?.length ?? 0) > 0) {
        next.requests = { ...s.requests, [e.chat.id]: [] };
      }
      return next;
    }
    case 'message.delta': {
      const forChat = s.streaming[e.chatId] ?? {};
      return { ...s, streaming: { ...s.streaming, [e.chatId]: { ...forChat, [e.messageId]: (forChat[e.messageId] ?? '') + e.text } } };
    }
    case 'message.completed': {
      const forChat = s.streaming[e.chatId];
      const streaming = forChat && e.message.id in forChat ? { ...s.streaming, [e.chatId]: omitKey(forChat, e.message.id) } : s.streaming;
      return { ...s, streaming, messages: { ...s.messages, [e.chatId]: upsertBy(s.messages[e.chatId], e.message, (m) => m.id === e.message.id) } };
    }
    case 'tool.call':
      return { ...s, toolCalls: { ...s.toolCalls, [e.chatId]: upsertBy(s.toolCalls[e.chatId], e.toolCall, (t) => t.id === e.toolCall.id) } };
    case 'request.opened': {
      const req: OpenRequest = { requestId: e.requestId, kind: e.kind, summary: e.summary, createdAt: now.toISOString() };
      const cur = s.requests[e.chatId] ?? [];
      if (cur.some((r) => r.requestId === e.requestId)) return s;
      return { ...s, requests: { ...s.requests, [e.chatId]: [...cur, req] } };
    }
    case 'usage.updated':
      return { ...s, usage: { ...s.usage, [e.reading.provider]: e.reading } };
    case 'connection.updated':
      return { ...s, connections: { ...s.connections, [e.health.provider]: e.health } };
    case 'notification': {
      const at = now.toISOString();
      const item: AppNotification = { id: `${at}:${e.chatId}:${e.kind}:${s.notifications.length}`, chatId: e.chatId, kind: e.kind, at, unread: true };
      return { ...s, notifications: [item, ...s.notifications].slice(0, MAX_NOTIFICATIONS) };
    }
  }
}

/**
 * Replaces server-owned lists with a fresh snapshot (initial load and resync after a reconnect).
 * A chat already in the store that is newer than the snapshot's copy wins, and chats the snapshot
 * lacks are kept: both can only come from events that arrived while the fetch was in flight.
 */
export function applySnapshot(s: AppState, snap: Snapshot): AppState {
  const chats = { ...s.chats };
  for (const c of snap.chats) {
    const cur = chats[c.id];
    if (!cur || cur.updatedAt <= c.updatedAt) chats[c.id] = c;
  }

  const streaming: AppState['streaming'] = {};
  for (const [id, texts] of Object.entries(s.streaming)) {
    const chat = chats[id];
    // Unknown chats stay buffered; known ones keep partial text only while still running.
    if (!chat || chat.column === 'running') streaming[id] = texts;
  }

  const requests: AppState['requests'] = {};
  for (const [id, list] of Object.entries(s.requests)) {
    const chat = chats[id];
    if (!chat || chat.column === 'needs_you') requests[id] = list;
  }

  const usage = { ...s.usage };
  for (const r of snap.usage) usage[r.provider] = r;
  const connections = { ...s.connections };
  for (const h of snap.connections) connections[h.provider] = h;

  return { ...s, chats, streaming, requests, usage, connections, suggested: snap.suggested, history: snap.history, projects: snap.projects };
}

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
