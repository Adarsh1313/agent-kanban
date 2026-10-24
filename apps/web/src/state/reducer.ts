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
import { suggest } from '@agent-kanban/shared';

/** The provider list (and order) the server passes to suggest(). */
const USAGE_PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];

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

/** A chat from a provider's own history that is not on the board yet. */
export interface HistoryRef { provider: ProviderId; sessionRef: string; cwd: string; title: string }

export interface UiState {
  view: 'board' | 'projects' | 'connections';
  projectId: string | null;
  /** The chat shown in the side panel; mutually exclusive with `openHistory`. */
  openChatId: string | null;
  /** A history-only chat shown in the side panel; mutually exclusive with `openChatId`. */
  openHistory: HistoryRef | null;
  /** Chats archived here whose Undo toast is still showing: hidden at once, archived on the server when it expires. */
  archiving: Record<string, true>;
  filters: Filters;
}

export interface SyncState {
  /** Counts every applied event; monotonic. */
  seq: number;
  /** Number of fetches in flight; events are only recorded in `touched` while this is above zero. */
  inflight: number;
  /** item key -> seq of the last event that wrote it while a fetch was in flight */
  touched: Record<string, number>;
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
  /** Deltas that arrived ahead of the text they extend (a gap), per chat, until a refetch fills it. */
  pendingDeltas: Record<string, PendingDelta[]>;
  /** Chats whose thread must be fetched again because a delta left a gap. */
  refetch: Record<string, true>;
  /** Bookkeeping that lets a fetch tell which items an event wrote while it was in flight. */
  sync: SyncState;
  socket: 'live' | 'reconnecting' | 'unauthorized';
  /** True once the first snapshot has been applied (before that the board is loading, not empty). */
  loaded: boolean;
  /** Wall clock (ms), bumped by the shell every 30 s so snooze checks re-evaluate without any event. */
  now: number;
  ui: UiState;
}

export interface PendingDelta { messageId: string; offset: number; text: string }

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
    pendingDeltas: {},
    refetch: {},
    sync: { seq: 0, inflight: 0, touched: {} },
    socket: 'reconnecting',
    loaded: false,
    now: Date.now(),
    ui: {
      view: 'board',
      projectId: null,
      openChatId: null,
      openHistory: null,
      archiving: {},
      filters: { provider: null, project: null, status: null, model: null, reason: null, activity: null, source: null },
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

/**
 * Applies a delta by position (idempotent): `offset` is the message length before the delta, so a
 * delta already covered is ignored, an overlapping one adds only its new tail, and one beyond the
 * current end is a gap. Mutates `messages` (a copy) and `streaming` (a copy).
 */
function applyDeltaTo(messages: Message[], streaming: Record<string, string>, d: PendingDelta): 'applied' | 'ignored' | 'gap' {
  const i = messages.findIndex((m) => m.id === d.messageId);
  const known = i !== -1 ? messages[i]!.text : streaming[d.messageId];
  const cur = known ?? '';
  if (d.offset > cur.length) return 'gap';
  const start = cur.length - d.offset;
  if (start >= d.text.length) return 'ignored';
  const text = cur + d.text.slice(start);
  if (i !== -1) messages[i] = { ...messages[i]!, text };
  else streaming[d.messageId] = text;
  return 'applied';
}

/** Applies held deltas that now fit; returns those still waiting. */
function drainPending(messages: Message[], streaming: Record<string, string>, pending: PendingDelta[]): PendingDelta[] {
  let rest = pending;
  for (let progress = true; progress && rest.length > 0; ) {
    progress = false;
    rest = rest.filter((d) => {
      const r = applyDeltaTo(messages, streaming, d);
      if (r !== 'gap') progress = true;
      return r === 'gap';
    });
  }
  return rest;
}

export const chatKey = (chatId: string) => `c:${chatId}`;
export const messageKey = (chatId: string, id: string) => `m:${chatId}:${id}`;
export const toolCallKey = (chatId: string, id: string) => `t:${chatId}:${id}`;
export const requestKey = (chatId: string, id: string) => `r:${chatId}:${id}`;

function bump(s: AppState, keys: string[]): SyncState {
  const seq = s.sync.seq + 1;
  if (s.sync.inflight === 0) return { ...s.sync, seq };
  const touched = { ...s.sync.touched };
  for (const k of keys) touched[k] = seq;
  return { ...s.sync, seq, touched };
}

/** A fetch is starting: events from now on are remembered so the result can be merged with them. */
export function beginSync(s: AppState): { state: AppState; since: number } {
  return { state: { ...s, sync: { ...s.sync, inflight: s.sync.inflight + 1 } }, since: s.sync.seq };
}

export function endSync(s: AppState): AppState {
  const inflight = Math.max(0, s.sync.inflight - 1);
  return { ...s, sync: { ...s.sync, inflight, touched: inflight === 0 ? {} : s.sync.touched } };
}

/** True when an event wrote this item after the fetch that started at `since`. */
export const touchedSince = (s: AppState, key: string, since: number): boolean => (s.sync.touched[key] ?? 0) > since;

/**
 * Merges usage readings. A reading older than the one held is ignored (a refresh answered after a newer
 * usage.updated event). A failed read normally carries the last good windows (the server keeps them); when it
 * carries none, the windows already held here are kept, so the numbers stay and only the message changes.
 */
export function mergeReadings(cur: AppState['usage'], readings: UsageReading[]): AppState['usage'] {
  const next = { ...cur };
  for (const r of readings) {
    const prev = next[r.provider];
    if (prev && Date.parse(prev.readAt) > Date.parse(r.readAt)) continue;
    next[r.provider] = r.status === 'error' && r.windows.length === 0 && prev && prev.windows.length > 0 ? { ...r, windows: prev.windows } : r;
  }
  return next;
}

/** The answer to a usage refresh: every reading plus the provider with the most room. */
export function applyUsage(s: AppState, res: { readings: UsageReading[]; suggested: ProviderId | null }): AppState {
  return { ...s, usage: mergeReadings(s.usage, res.readings), suggested: res.suggested };
}

export function applyEvent(s: AppState, e: ServerEvent, now: Date = new Date()): AppState {
  const mk = (keys: string[], patch: Partial<AppState>): AppState => ({ ...s, ...patch, sync: bump(s, keys) });
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
      const messages = (s.messages[e.chatId] ?? []).slice();
      const streaming = { ...(s.streaming[e.chatId] ?? {}) };
      const delta: PendingDelta = { messageId: e.messageId, offset: e.offset, text: e.text };
      const result = applyDeltaTo(messages, streaming, delta);
      if (result === 'ignored') return mk([], {});
      const patch: Partial<AppState> = {};
      if (result === 'gap') {
        // Part of the message is missing here: hold the delta and ask for a refetch of the thread.
        patch.pendingDeltas = { ...s.pendingDeltas, [e.chatId]: [...(s.pendingDeltas[e.chatId] ?? []), delta] };
        patch.refetch = { ...s.refetch, [e.chatId]: true };
      } else {
        const rest = drainPending(messages, streaming, s.pendingDeltas[e.chatId] ?? []);
        patch.messages = { ...s.messages, [e.chatId]: messages };
        patch.streaming = { ...s.streaming, [e.chatId]: streaming };
        patch.pendingDeltas = { ...s.pendingDeltas, [e.chatId]: rest };
      }
      return mk(keys, patch);
    }
    case 'message.completed': {
      const forChat = s.streaming[e.chatId];
      const streaming = forChat && e.message.id in forChat ? { ...s.streaming, [e.chatId]: omitKey(forChat, e.message.id) } : s.streaming;
      const pending = (s.pendingDeltas[e.chatId] ?? []).filter((d) => d.messageId !== e.message.id);
      return mk([messageKey(e.chatId, e.message.id), chatKey(e.chatId)], {
        streaming,
        pendingDeltas: { ...s.pendingDeltas, [e.chatId]: pending },
        refetch: pending.length === 0 && s.refetch[e.chatId] ? omitKey(s.refetch, e.chatId) : s.refetch,
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
    case 'usage.updated': {
      // The event carries no suggestion: recompute "Most room" the way the server does.
      const usage = mergeReadings(s.usage, [e.reading]);
      return mk([], { usage, suggested: suggest(Object.values(usage).filter((r): r is UsageReading => !!r), USAGE_PROVIDERS) });
    }
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

  const usage = mergeReadings(s.usage, snap.usage);
  const connections = { ...s.connections };
  for (const h of snap.connections) connections[h.provider] = h;

  return {
    ...s,
    loaded: true,
    chats,
    streaming,
    requests,
    messages: keepKnown(s.messages),
    pendingDeltas: keepKnown(s.pendingDeltas),
    refetch: keepKnown(s.refetch),
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

/** Opens a board chat in the side panel (closing any history chat shown there). */
export function openChatIn(s: AppState, id: string): AppState {
  if (s.ui.openChatId === id && s.ui.openHistory === null) return s;
  return { ...s, ui: { ...s.ui, openChatId: id, openHistory: null } };
}

/** Opens a history-only chat in the side panel (closing any board chat shown there). */
export function openHistoryIn(s: AppState, ref: HistoryRef): AppState {
  const cur = s.ui.openHistory;
  if (s.ui.openChatId === null && cur && cur.provider === ref.provider && cur.sessionRef === ref.sessionRef) return s;
  return { ...s, ui: { ...s.ui, openChatId: null, openHistory: ref } };
}

export function closePanelIn(s: AppState): AppState {
  if (s.ui.openChatId === null && s.ui.openHistory === null) return s;
  return { ...s, ui: { ...s.ui, openChatId: null, openHistory: null } };
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
    const byId = new Map(part.messages.map((m) => [m.id, m]));
    for (const c of s.messages[chatId] ?? []) {
      const f = byId.get(c.id);
      if (!f) byId.set(c.id, c);
      else if (touchedSince(s, messageKey(chatId, c.id), since)) {
        // Both are the same message at different moments; the longer text extends the shorter one.
        byId.set(c.id, c.text.startsWith(f.text) || !f.text.startsWith(c.text) ? c : f);
      }
    }
    const streaming = { ...(s.streaming[chatId] ?? {}) };
    for (const [mid, text] of Object.entries(streaming)) {
      const msg = byId.get(mid);
      if (!msg) continue;
      if (text.length > msg.text.length && text.startsWith(msg.text)) byId.set(mid, { ...msg, text });
      delete streaming[mid];
    }
    const list = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const rest = drainPending(list, streaming, s.pendingDeltas[chatId] ?? []);
    next.pendingDeltas = { ...s.pendingDeltas, [chatId]: rest };
    next.refetch = rest.length === 0 ? omitKey(s.refetch, chatId) : s.refetch;
    next.messages = { ...s.messages, [chatId]: list };
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
