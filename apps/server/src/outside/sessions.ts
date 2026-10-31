import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat, Column, NeedsReason, ServerEvent } from '@agent-kanban/shared';
import { chatTitle, type Store } from '../store.ts';
import { HOOK_EVENTS, type HookEvent } from './hooks.ts';

/** What Claude Code sends a hook on stdin (only the fields we use). */
export interface HookPayload {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
  transcript_path?: string;
  prompt?: string;
  message?: string;
}

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;
const CATCH_UP_MS = 24 * 60 * 60_000;
/** An outside chat with no new writes for this long is settled to Review (the app missed its Stop). */
export const IDLE_MS = 10 * 60_000;
const UNTITLED = 'Claude Code chat';

/** A hook body we act on, or null: anything else is dropped without a reply body. */
export function parseHookPayload(body: Record<string, unknown>): HookPayload | null {
  const ev = body.hook_event_name;
  if (typeof ev !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(ev)) return null;
  if (typeof body.session_id !== 'string' || !SESSION_ID.test(body.session_id)) return null;
  if (typeof body.cwd !== 'string' || body.cwd === '' || body.cwd.length > 4096) return null;
  const opt = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, max) : undefined);
  return {
    hook_event_name: ev as HookEvent, session_id: body.session_id, cwd: body.cwd,
    transcript_path: opt('transcript_path', 4096), prompt: opt('prompt', 2000), message: opt('message', 500),
  };
}

/** Claude Code's notification text says when it wants permission; anything else is it waiting for a reply. */
function notificationReason(message: string | undefined): NeedsReason {
  return message && /permission/i.test(message) ? 'permission' : 'waiting';
}

/** Puts the Claude Code chats the user runs outside the app on the board, driven by its hooks (#37). */
export class OutsideSessions {
  private store: Store;
  private emit: (e: ServerEvent) => void;
  private runningHere: (chatId: string) => boolean;
  private claudeHome: string;
  private now: () => number;
  private transcripts = new Map<string, string>();

  constructor(opts: { store: Store; emit: (e: ServerEvent) => void; runningHere: (chatId: string) => boolean; claudeHome: string; now?: () => number }) {
    this.store = opts.store;
    this.emit = opts.emit;
    this.runningHere = opts.runningHere;
    this.claudeHome = opts.claudeHome;
    this.now = opts.now ?? Date.now;
  }

  handle(p: HookPayload): void {
    let chat = this.store.findBySessionRef('claude', p.session_id);
    // The app's own run of this chat is in charge of its card.
    if (chat && this.runningHere(chat.id)) return;
    if (p.transcript_path) this.transcripts.set(p.session_id, p.transcript_path);
    const first = p.prompt?.trim() ? p.prompt : undefined;
    if (!chat) chat = this.store.createChat({ provider: 'claude', cwd: p.cwd, title: first ?? UNTITLED, sessionRef: p.session_id });
    const next = this.place(p);
    const patch: Partial<Chat> = { origin: 'outside', ...next };
    if (first && chat.title === UNTITLED) patch.title = chatTitle(first.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? UNTITLED);
    // An outside chat that comes back to life leaves Done and the archive.
    if (next.column === 'running') { patch.archived = false; patch.doneAt = null; }
    const updated = this.store.updateChat(chat.id, patch);
    this.emit({ type: 'chat.updated', chat: updated });
    if (p.hook_event_name === 'Notification') this.emit({ type: 'notification', chatId: chat.id, kind: next.needsReason === 'permission' ? 'permission' : 'question' });
    else if (p.hook_event_name === 'Stop' && chat.column !== 'review') this.emit({ type: 'notification', chatId: chat.id, kind: 'finished' });
  }

  private place(p: HookPayload): { column: Column; needsReason: NeedsReason | null; outsideLive: boolean } {
    switch (p.hook_event_name) {
      case 'SessionStart':
      case 'UserPromptSubmit': return { column: 'running', needsReason: null, outsideLive: true };
      case 'Notification': return { column: 'needs_you', needsReason: notificationReason(p.message), outsideLive: true };
      case 'Stop':
      case 'SessionEnd': return { column: 'review', needsReason: null, outsideLive: false };
    }
  }

  /**
   * On start: Claude Code chats written in the last 24 hours that the board doesn't know get a card, so
   * chats run while the app was closed are caught up. One idle for 10 minutes goes straight to Review.
   */
  async catchUp(read: (path: string, sessionRef: string) => Promise<{ title: string; cwd: string } | null>): Promise<void> {
    const now = this.now();
    for (const { path, sessionRef, mtime } of this.sessionFiles()) {
      if (now - mtime > CATCH_UP_MS) continue;
      if (this.store.findBySessionRef('claude', sessionRef)) continue;
      const info = await read(path, sessionRef);
      if (!info || !info.cwd) continue;
      this.transcripts.set(sessionRef, path);
      const live = now - mtime < IDLE_MS;
      const chat = this.store.createChat({ provider: 'claude', cwd: info.cwd, title: info.title || UNTITLED, sessionRef });
      const updated = this.store.updateChat(chat.id, { origin: 'outside', outsideLive: live, column: live ? 'running' : 'review' }, { touch: false });
      this.emit({ type: 'chat.updated', chat: updated });
    }
  }

  /** Outside chats still marked running whose file has been quiet for 10 minutes are settled to Review. */
  settleIdle(): void {
    const now = this.now();
    for (const chat of this.store.listChats()) {
      if (chat.origin !== 'outside' || !chat.outsideLive || !chat.sessionRef || this.runningHere(chat.id)) continue;
      const path = this.transcripts.get(chat.sessionRef) ?? this.findTranscript(chat.sessionRef);
      let mtime = Date.parse(chat.updatedAt);
      if (path) { try { mtime = Math.max(mtime, statSync(path).mtimeMs); } catch { /* gone: use the card's time */ } }
      if (now - mtime < IDLE_MS) continue;
      const updated = this.store.updateChat(chat.id, { column: 'review', needsReason: null, outsideLive: false }, { touch: false });
      this.emit({ type: 'chat.updated', chat: updated });
    }
  }

  private findTranscript(sessionRef: string): string | undefined {
    for (const f of this.sessionFiles()) if (f.sessionRef === sessionRef) { this.transcripts.set(sessionRef, f.path); return f.path; }
    return undefined;
  }

  private *sessionFiles(): Generator<{ path: string; sessionRef: string; mtime: number }> {
    const root = join(this.claudeHome, 'projects');
    let dirs: string[];
    try { dirs = readdirSync(root); } catch { return; }
    for (const d of dirs) {
      let files: string[];
      try { files = readdirSync(join(root, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const path = join(root, d, f);
        try { yield { path, sessionRef: f.slice(0, -'.jsonl'.length), mtime: statSync(path).mtimeMs }; } catch { /* vanished */ }
      }
    }
  }
}
