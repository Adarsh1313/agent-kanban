import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Chat, Message, ProviderId, ToolCall, UsageReading, UsageWindow } from '@agent-kanban/shared';

type Row = Record<string, any>;

const COLS: Record<keyof Chat, string> = {
  id: 'id', provider: 'provider', sessionRef: 'session_ref', cwd: 'cwd', title: 'title', model: 'model',
  column: 'column_name', needsReason: 'needs_reason', createdAt: 'created_at', updatedAt: 'updated_at',
  doneAt: 'done_at', archived: 'archived', pinned: 'pinned', snoozedUntil: 'snoozed_until',
};

function toChat(r: Row): Chat {
  return {
    id: r.id, provider: r.provider, sessionRef: r.session_ref, cwd: r.cwd, title: r.title, model: r.model,
    column: r.column_name, needsReason: r.needs_reason, createdAt: r.created_at, updatedAt: r.updated_at,
    doneAt: r.done_at, archived: r.archived === 1, pinned: r.pinned === 1, snoozedUntil: r.snoozed_until,
  };
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
    `);
  }

  /** ISO timestamp, strictly increasing within this process so ordering is stable. */
  private now(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  createChat(input: { provider: ProviderId; cwd: string; title: string; model?: string | null; sessionRef?: string | null }): Chat {
    const id = randomUUID();
    const now = this.now();
    const title = input.title.split(/\r?\n/)[0].slice(0, 60);
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

  updateChat(id: string, patch: Partial<Chat>): Chat {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof Chat, unknown][]) {
      if (k === 'id' || k === 'updatedAt' || !(k in COLS) || v === undefined) continue;
      sets.push(`${COLS[k]} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    sets.push('updated_at = ?');
    vals.push(this.now());
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

  listMessages(chatId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as Row[])
      .map((r) => ({ id: r.id, chatId: r.chat_id, role: r.role, text: r.text, createdAt: r.created_at }));
  }

  upsertToolCall(t: Omit<ToolCall, 'createdAt'>): void {
    this.db.prepare(
      `INSERT INTO tool_calls (id, chat_id, name, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, summary = excluded.summary, status = excluded.status`,
    ).run(t.id, t.chatId, t.name, t.summary, t.status, this.now());
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
}
