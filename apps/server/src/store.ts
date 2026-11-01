import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Chat, Message, OpenRequest, ProviderId, RequestAction, ToolCall, UsageReading, UsageWindow } from '@agent-kanban/shared';

type Row = Record<string, any>;

const COLS: Record<keyof Chat, string> = {
  id: 'id', provider: 'provider', sessionRef: 'session_ref', cwd: 'cwd', title: 'title', model: 'model',
  column: 'column_name', needsReason: 'needs_reason', createdAt: 'created_at', updatedAt: 'updated_at',
  doneAt: 'done_at', archived: 'archived', pinned: 'pinned', snoozedUntil: 'snoozed_until',
  origin: 'origin', outsideLive: 'outside_live',
};

function toChat(r: Row): Chat {
  return {
    id: r.id, provider: r.provider, sessionRef: r.session_ref, cwd: r.cwd, title: r.title, model: r.model,
    column: r.column_name, needsReason: r.needs_reason, createdAt: r.created_at, updatedAt: r.updated_at,
    doneAt: r.done_at, archived: r.archived === 1, pinned: r.pinned === 1, snoozedUntil: r.snoozed_until,
    ...(r.origin === 'outside' ? { origin: 'outside' as const, outsideLive: r.outside_live === 1 } : {}),
  };
}

function toMessage(r: Row): Message {
  return { id: r.id, chatId: r.chat_id, role: r.role, text: r.text, createdAt: r.created_at };
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
      CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id);
      CREATE INDEX IF NOT EXISTS tool_calls_chat ON tool_calls (chat_id);
      CREATE INDEX IF NOT EXISTS requests_chat ON requests (chat_id);
      CREATE INDEX IF NOT EXISTS chats_session ON chats (provider, session_ref);
    `);
    // Added in Plan 3: what a permission request is for. Older databases get the column (NULL = a command).
    const requestCols = (this.db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name);
    if (!requestCols.includes('action')) this.db.exec('ALTER TABLE requests ADD COLUMN action TEXT');
    // Added for #37: chats run in Claude Code outside the app.
    const chatCols = (this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name);
    if (!chatCols.includes('origin')) this.db.exec('ALTER TABLE chats ADD COLUMN origin TEXT');
    if (!chatCols.includes('outside_live')) this.db.exec('ALTER TABLE chats ADD COLUMN outside_live INTEGER NOT NULL DEFAULT 0');
  }

  /** Closes the database (tests remove its folder afterwards). */
  close(): void { this.db.close(); }

  /** ISO timestamp, strictly increasing within this process so ordering is stable. */
  private now(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  createChat(input: { provider: ProviderId; cwd: string; title: string; model?: string | null; sessionRef?: string | null }): Chat {
    const id = randomUUID();
    const now = this.now();
    const title = chatTitle(input.title.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? 'Untitled chat');
    this.db.prepare(
      `INSERT INTO chats (id, provider, session_ref, cwd, title, model, column_name, needs_reason, created_at, updated_at, archived, pinned)
       VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, 0, 0)`,
    ).run(id, input.provider, input.sessionRef ?? null, input.cwd, title, input.model ?? null, now, now);
    return this.getChat(id)!;
  }

  getChat(id: string): Chat | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
    return r ? toChat(r) : undefined;
  }

  listChats(): Chat[] {
    return (this.db.prepare('SELECT * FROM chats WHERE archived = 0 ORDER BY updated_at DESC, rowid DESC').all() as Row[]).map(toChat);
  }

  /** `touch: false` keeps updatedAt (pin, rename and snooze are not activity). */
  updateChat(id: string, patch: Partial<Chat>, opts: { touch?: boolean } = {}): Chat {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof Chat, unknown][]) {
      if (k === 'id' || k === 'updatedAt' || !(k in COLS) || v === undefined) continue;
      sets.push(`${COLS[k]} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
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
    const m: Message = { id: randomUUID(), chatId, role, text, createdAt: this.now() };
    this.db.prepare('INSERT INTO messages (id, chat_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, chatId, role, text, m.createdAt);
    return m;
  }

  appendToMessage(messageId: string, delta: string): void {
    this.db.prepare('UPDATE messages SET text = text || ? WHERE id = ?').run(delta, messageId);
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

  /** A stored setting (JSON text), or undefined when it was never set. */
  getSetting(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r && typeof r.value === 'string' ? r.value : undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
