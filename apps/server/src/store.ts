import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Chat, Effort, Message, OpenRequest, ProviderId, RequestAction, Routine, RoutineResult, RoutineSchedule, ToolCall, UsageReading, UsageWindow } from '@agent-kanban/shared';

type Row = Record<string, any>;

const COLS: Record<keyof Chat, string> = {
  id: 'id', provider: 'provider', sessionRef: 'session_ref', cwd: 'cwd', title: 'title', model: 'model',
  column: 'column_name', needsReason: 'needs_reason', createdAt: 'created_at', updatedAt: 'updated_at',
  doneAt: 'done_at', archived: 'archived', pinned: 'pinned', snoozedUntil: 'snoozed_until', routineId: 'routine_id', effort: 'effort',
  resumeAt: 'resume_at', autoResume: 'auto_resume', queue: 'queue',
  origin: 'origin', outsideLive: 'outside_live',
  providerRefs: 'provider_refs', projectLabel: 'project_label',
};

function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toChat(r: Row): Chat {
  return {
    id: r.id, provider: r.provider, sessionRef: r.session_ref, cwd: r.cwd, title: r.title, model: r.model,
    column: r.column_name, needsReason: r.needs_reason, createdAt: r.created_at, updatedAt: r.updated_at,
    doneAt: r.done_at, archived: r.archived === 1, pinned: r.pinned === 1, snoozedUntil: r.snoozed_until,
    effort: r.effort ?? 'normal',
    routineId: r.routine_id ?? null,
    // Out-of-usage fields appear only when they differ from the default (#39).
    ...(r.resume_at ? { resumeAt: r.resume_at } : {}),
    ...(r.auto_resume === 0 ? { autoResume: false } : {}),
    ...(r.queue && r.queue !== '[]' ? { queue: JSON.parse(r.queue) } : {}),
    ...(r.origin === 'outside' ? { origin: 'outside' as const, outsideLive: r.outside_live === 1 } : {}),
    providerRefs: json(r.provider_refs, {}), projectLabel: r.project_label ?? null,
  };
}

/** A stored routine; `armedAt` is when it was created or last resumed (runs due before it are never caught up). */
export type StoredRoutine = Omit<Routine, 'nextRunAt'> & { armedAt: string };
export type RoutineInput = Pick<Routine, 'name' | 'cwd' | 'provider' | 'effort' | 'kind' | 'text' | 'schedule' | 'chime'>;

function toRoutine(r: Row): StoredRoutine {
  return {
    id: r.id, name: r.name, cwd: r.cwd, provider: r.provider, effort: r.effort as Effort, kind: r.kind, text: r.text,
    schedule: JSON.parse(r.schedule) as RoutineSchedule, paused: r.paused === 1, chime: r.chime === 1,
    lastRunAt: r.last_run_at, lastResult: r.last_result as RoutineResult | null, lastChatId: r.last_chat_id,
    createdAt: r.created_at, armedAt: r.armed_at,
  };
}

const ROUTINE_COLS: Partial<Record<keyof StoredRoutine, string>> = {
  name: 'name', cwd: 'cwd', provider: 'provider', effort: 'effort', kind: 'kind', text: 'text', schedule: 'schedule',
  paused: 'paused', chime: 'chime', lastRunAt: 'last_run_at', lastResult: 'last_result', lastChatId: 'last_chat_id', armedAt: 'armed_at',
};

function toMessage(r: Row): Message {
  const m: Message = { id: r.id, chatId: r.chat_id, role: r.role, text: r.text, createdAt: r.created_at };
  if (r.effort) m.effort = r.effort;
  if (r.suggestions) m.suggestions = JSON.parse(r.suggestions) as string[];
  if (r.provider) m.provider = r.provider;
  return m;
}

function requestKey(chatId: string, requestId: string): string {
  return `${chatId}:${requestId}`;
}

/** A chat's title from its first line: at most 60 characters, cut at a word with "…" rather than mid-word (#9). */
export function chatTitle(line: string, max = 60): string {
  if (line.length <= max) return line;
  const room = line.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return (space >= max / 2 ? room.slice(0, space) : room).trimEnd() + '…';
}

export class Store {
  private db: DatabaseSync;
  private lastStamp = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_ref TEXT, cwd TEXT NOT NULL, title TEXT NOT NULL,
        model TEXT, column_name TEXT, needs_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        done_at TEXT, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, status TEXT NOT NULL,
        windows TEXT NOT NULL, read_at TEXT NOT NULL, message TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS history_labels (
        provider TEXT NOT NULL, session_ref TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, session_ref)
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, provider TEXT NOT NULL, effort TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, schedule TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        chime INTEGER NOT NULL DEFAULT 0, last_run_at TEXT, last_result TEXT, last_chat_id TEXT,
        created_at TEXT NOT NULL, armed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id);
      CREATE INDEX IF NOT EXISTS tool_calls_chat ON tool_calls (chat_id);
      CREATE INDEX IF NOT EXISTS requests_chat ON requests (chat_id);
      CREATE INDEX IF NOT EXISTS chats_session ON chats (provider, session_ref);
    `);
    // Added in Plan 3: what a permission request is for. Older databases get the column (NULL = a command).
    const requestCols = (this.db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name);
    if (!requestCols.includes('action')) this.db.exec('ALTER TABLE requests ADD COLUMN action TEXT');
    // Added for the composer (#42): effort per chat (NULL = normal), and per reply with its suggested next steps.
    const chatCols = (this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name);
    if (!chatCols.includes('effort')) this.db.exec('ALTER TABLE chats ADD COLUMN effort TEXT');
    const messageCols = (this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
    if (!messageCols.includes('effort')) this.db.exec('ALTER TABLE messages ADD COLUMN effort TEXT');
    if (!messageCols.includes('suggestions')) this.db.exec('ALTER TABLE messages ADD COLUMN suggestions TEXT');
    // Added for routines (#45): the routine that started a chat.
    if (!chatCols.includes('routine_id')) this.db.exec('ALTER TABLE chats ADD COLUMN routine_id TEXT');
    // Added for #39: out of usage, auto-resume and the follow-up queue.
    if (!chatCols.includes('resume_at')) this.db.exec('ALTER TABLE chats ADD COLUMN resume_at TEXT');
    if (!chatCols.includes('auto_resume')) this.db.exec('ALTER TABLE chats ADD COLUMN auto_resume INTEGER NOT NULL DEFAULT 1');
    if (!chatCols.includes('queue')) this.db.exec("ALTER TABLE chats ADD COLUMN queue TEXT NOT NULL DEFAULT '[]'");
    // Added for #37: chats run in Claude Code outside the app.
    if (!chatCols.includes('origin')) this.db.exec('ALTER TABLE chats ADD COLUMN origin TEXT');
    if (!chatCols.includes('outside_live')) this.db.exec('ALTER TABLE chats ADD COLUMN outside_live INTEGER NOT NULL DEFAULT 0');
    // Added for handoff (#40): each message's provider, each provider's session and where it left off, the project label.
    if (!chatCols.includes('provider_refs')) this.db.exec('ALTER TABLE chats ADD COLUMN provider_refs TEXT');
    if (!chatCols.includes('handoff_seen')) this.db.exec('ALTER TABLE chats ADD COLUMN handoff_seen TEXT');
    if (!chatCols.includes('project_label')) this.db.exec('ALTER TABLE chats ADD COLUMN project_label TEXT');
    if (!messageCols.includes('provider')) this.db.exec('ALTER TABLE messages ADD COLUMN provider TEXT');
  }

  /** Closes the database (tests remove its folder afterwards). */
  close(): void { this.db.close(); }

  /** ISO timestamp, strictly increasing within this process so ordering is stable. */
  private now(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  createChat(input: { provider: ProviderId; cwd: string; title: string; model?: string | null; sessionRef?: string | null; effort?: Effort; routineId?: string | null }): Chat {
    const id = randomUUID();
    const now = this.now();
    const title = chatTitle(input.title.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? 'Untitled chat');
    this.db.prepare(
      `INSERT INTO chats (id, provider, session_ref, cwd, title, model, column_name, needs_reason, created_at, updated_at, archived, pinned, effort, routine_id)
       VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, 0, 0, ?, ?)`,
    ).run(id, input.provider, input.sessionRef ?? null, input.cwd, title, input.model ?? null, now, now, input.effort ?? 'normal', input.routineId ?? null);
    return this.getChat(id)!;
  }

  getChat(id: string): Chat | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
    return r ? toChat(r) : undefined;
  }

  listChats(includeArchived = false): Chat[] {
    const sql = `SELECT * FROM chats${includeArchived ? '' : ' WHERE archived = 0'} ORDER BY updated_at DESC, rowid DESC`;
    return (this.db.prepare(sql).all() as Row[]).map(toChat);
  }

  historyArchived(provider: ProviderId, sessionRef: string): boolean {
    const row = this.db.prepare('SELECT archived FROM history_labels WHERE provider = ? AND session_ref = ?').get(provider, sessionRef) as Row | undefined;
    return row?.archived === 1;
  }

  setHistoryArchived(provider: ProviderId, sessionRef: string, archived: boolean): void {
    this.db.prepare(`INSERT INTO history_labels (provider, session_ref, archived) VALUES (?, ?, ?)
      ON CONFLICT(provider, session_ref) DO UPDATE SET archived = excluded.archived`).run(provider, sessionRef, archived ? 1 : 0);
  }

  /** `touch: false` keeps updatedAt (pin, rename and snooze are not activity). */
  updateChat(id: string, patch: Partial<Chat>, opts: { touch?: boolean } = {}): Chat {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof Chat, unknown][]) {
      if (k === 'id' || k === 'updatedAt' || !(k in COLS) || v === undefined) continue;
      sets.push(`${COLS[k]} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
    }
    if (opts.touch !== false) {
      sets.push('updated_at = ?');
      vals.push(this.now());
    }
    if (sets.length === 0) {
      const chat = this.getChat(id);
      if (!chat) throw new Error(`Chat not found: ${id}`);
      return chat;
    }
    const res = this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    if (res.changes === 0) throw new Error(`Chat not found: ${id}`);
    return this.getChat(id)!;
  }

  findBySessionRef(provider: ProviderId, sessionRef: string): Chat | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE provider = ? AND session_ref = ?').get(provider, sessionRef) as Row | undefined;
    return r ? toChat(r) : undefined;
  }

  addMessage(chatId: string, role: 'user' | 'assistant', text: string): Message {
    // Each message keeps the provider the chat had when it was written.
    const provider = (this.db.prepare('SELECT provider FROM chats WHERE id = ?').get(chatId) as Row | undefined)?.provider as ProviderId | undefined;
    const m: Message = { id: randomUUID(), chatId, role, text, createdAt: this.now(), ...(provider ? { provider } : {}) };
    this.db.prepare('INSERT INTO messages (id, chat_id, role, text, created_at, provider) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.id, chatId, role, text, m.createdAt, provider ?? null);
    return m;
  }

  appendToMessage(messageId: string, delta: string): void {
    this.db.prepare('UPDATE messages SET text = text || ? WHERE id = ?').run(delta, messageId);
  }

  /** The effort a reply ran at (only stored when it wasn't Normal). */
  setMessageEffort(id: string, effort: Effort): void {
    this.db.prepare('UPDATE messages SET effort = ? WHERE id = ?').run(effort, id);
  }

  setMessageSuggestions(id: string, suggestions: string[]): void {
    this.db.prepare('UPDATE messages SET suggestions = ? WHERE id = ?').run(JSON.stringify(suggestions), id);
  }

  setMessageText(id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, id);
  }

  listMessages(chatId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as Row[]).map(toMessage);
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  upsertToolCall(t: Omit<ToolCall, 'createdAt'>): ToolCall {
    this.db.prepare(
      `INSERT INTO tool_calls (id, chat_id, name, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, summary = excluded.summary, status = excluded.status`,
    ).run(t.id, t.chatId, t.name, t.summary, t.status, this.now());
    const r = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(t.id) as Row;
    return { id: r.id, chatId: r.chat_id, name: r.name, summary: r.summary, status: r.status, createdAt: r.created_at };
  }

  listToolCalls(chatId: string): ToolCall[] {
    return (this.db.prepare('SELECT * FROM tool_calls WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as Row[])
      .map((r) => ({ id: r.id, chatId: r.chat_id, name: r.name, summary: r.summary, status: r.status, createdAt: r.created_at }));
  }

  // Requests are keyed by chat and request id together: Codex numbers its requests per process, so ids repeat.
  addRequest(chatId: string, r: { requestId: string; kind: 'permission' | 'question'; summary: string; action?: RequestAction }): OpenRequest {
    const createdAt = this.now();
    this.db.prepare(
      `INSERT INTO requests (id, chat_id, kind, summary, status, created_at, action) VALUES (?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary, status = 'open', created_at = excluded.created_at, action = excluded.action`,
    ).run(requestKey(chatId, r.requestId), chatId, r.kind, r.summary, createdAt, r.action ?? null);
    return { requestId: r.requestId, kind: r.kind, summary: r.summary, createdAt, ...(r.action ? { action: r.action } : {}) };
  }

  setRequestStatus(chatId: string, requestId: string, status: 'answered' | 'closed'): void {
    this.db.prepare(`UPDATE requests SET status = ? WHERE id = ? AND status = 'open'`).run(status, requestKey(chatId, requestId));
  }

  /** Marks every still-open request closed: for one chat, or (no id) for all chats after a restart. */
  closeOpenRequests(chatId?: string): void {
    if (chatId === undefined) this.db.prepare(`UPDATE requests SET status = 'closed' WHERE status = 'open'`).run();
    else this.db.prepare(`UPDATE requests SET status = 'closed' WHERE chat_id = ? AND status = 'open'`).run(chatId);
  }

  listOpenRequests(chatId: string): OpenRequest[] {
    return (this.db.prepare(`SELECT * FROM requests WHERE chat_id = ? AND status = 'open' ORDER BY created_at, rowid`).all(chatId) as Row[])
      .map((r) => ({ requestId: (r.id as string).slice(chatId.length + 1), kind: r.kind, summary: r.summary, createdAt: r.created_at, ...(r.action ? { action: r.action } : {}) }));
  }

  saveUsage(reading: UsageReading): void {
    this.db.prepare('INSERT INTO usage_snapshots (provider, status, windows, read_at, message) VALUES (?, ?, ?, ?, ?)')
      .run(reading.provider, reading.status, JSON.stringify(reading.windows), reading.readAt, reading.message ?? null);
  }

  lastUsage(provider: ProviderId): UsageReading | undefined {
    const r = this.db.prepare('SELECT * FROM usage_snapshots WHERE provider = ? ORDER BY id DESC LIMIT 1').get(provider) as Row | undefined;
    if (!r) return undefined;
    const out: UsageReading = { provider: r.provider, status: r.status, windows: JSON.parse(r.windows) as UsageWindow[], readAt: r.read_at };
    if (r.message !== null) out.message = r.message;
    return out;
  }

  /** How many messages each provider had seen when the chat last moved away from it (handoff deltas). */
  getHandoffSeen(chatId: string): Partial<Record<ProviderId, number>> {
    const r = this.db.prepare('SELECT handoff_seen FROM chats WHERE id = ?').get(chatId) as Row | undefined;
    return json(r?.handoff_seen, {});
  }

  setHandoffSeen(chatId: string, seen: Partial<Record<ProviderId, number>>): void {
    this.db.prepare('UPDATE chats SET handoff_seen = ? WHERE id = ?').run(JSON.stringify(seen), chatId);
  }

  /** A stored setting (JSON text), or undefined when it was never set. */
  getSetting(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r && typeof r.value === 'string' ? r.value : undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  createRoutine(input: RoutineInput, at: string): StoredRoutine {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO routines (id, name, cwd, provider, effort, kind, text, schedule, paused, chime, created_at, armed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(id, input.name, input.cwd, input.provider, input.effort, input.kind, input.text, JSON.stringify(input.schedule), input.chime ? 1 : 0, at, at);
    return this.getRoutine(id)!;
  }

  getRoutine(id: string): StoredRoutine | undefined {
    const r = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Row | undefined;
    return r ? toRoutine(r) : undefined;
  }

  listRoutines(): StoredRoutine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY created_at, rowid').all() as Row[]).map(toRoutine);
  }

  updateRoutine(id: string, patch: Partial<StoredRoutine>): StoredRoutine | undefined {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof StoredRoutine, unknown][]) {
      const col = ROUTINE_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : k === 'schedule' ? JSON.stringify(v) : v);
    }
    if (sets.length > 0) this.db.prepare(`UPDATE routines SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getRoutine(id);
  }

  deleteRoutine(id: string): boolean {
    return this.db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes > 0;
  }
}
