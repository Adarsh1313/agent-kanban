import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterEvent, Chat, HistoryChat, Message, ProviderId, ServerEvent, UserAction,
} from '@agent-kanban/shared';
import { nextState } from './columns.ts';
import type { Store } from './store.ts';
import type { ProviderAdapter } from './adapters/adapter.ts';
import type { UsageService } from './usage/service.ts';

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const ACTIVE_WINDOW_MS = 15_000;
const OWN_WRITE_SLACK_MS = 2_000;
const BUFFER_MAX = 500;
const BUFFER_MAX_AGE_MS = 60_000;

export class ActiveElsewhereError extends Error {
  constructor() {
    super("This chat is active in Claude Code right now. Try again when it's idle.");
    this.name = 'ActiveElsewhereError';
  }
}

type Decision = 'allow' | 'deny' | { reply: string };
type OpenRequest = { kind: 'permission' | 'question'; summary: string };

export class ChatService {
  private store: Store;
  private adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  private usage: UsageService;
  private emit: (e: ServerEvent) => void;
  private claudeHome: string;
  private now: () => Date;
  private buffers = new Map<ProviderId, { at: number; event: AdapterEvent }[]>();
  private messageIds = new Map<string, Map<string, string>>();
  private requests = new Map<string, Map<string, OpenRequest>>();
  /** Chats whose provider session is attached in this process (started or resumed). */
  private live = new Set<string>();
  /** Resolves when an in-progress startChat for the chat has settled. */
  private pending = new Map<string, Promise<void>>();
  private resuming = new Map<string, Promise<void>>();
  /** Last time this process drove or heard from each chat (ms). Distinguishes our own .jsonl writes from another app's. */
  private lastOwn = new Map<string, number>();
  /** Errors already reported, per chat: one failed resume is shared by concurrent callers of the SAME chat only. */
  private reported = new WeakMap<object, Set<string>>();
  private historyGates = new Map<string, Promise<void>>();

  constructor(opts: {
    store: Store;
    adapters: Partial<Record<ProviderId, ProviderAdapter>>;
    usage: UsageService;
    broadcast: (e: ServerEvent) => void;
    claudeHome: string;
    now?: () => Date;
  }) {
    this.store = opts.store;
    this.adapters = opts.adapters;
    this.usage = opts.usage;
    this.emit = opts.broadcast;
    this.claudeHome = opts.claudeHome;
    this.now = opts.now ?? (() => new Date());
    for (const [id, adapter] of Object.entries(this.adapters) as [ProviderId, ProviderAdapter | undefined][]) {
      adapter?.onEvent((e) => this.onAdapterEvent(id, e));
    }
  }

  // ---- public API ----

  async start(input: { provider: ProviderId; cwd: string; prompt: string; model?: string }): Promise<Chat> {
    const chat = this.store.createChat({
      provider: input.provider, cwd: input.cwd, title: input.prompt, model: input.model ?? null,
    });
    this.addMessage(chat.id, 'user', input.prompt);
    this.broadcast({ type: 'chat.updated', chat });
    await this.begin(chat, input.prompt);
    return this.store.getChat(chat.id)!;
  }

  async send(chatId: string, text: string): Promise<void> {
    this.mustGet(chatId);
    while (this.pending.has(chatId)) await this.pending.get(chatId);
    const chat = this.mustGet(chatId);
    if (chat.sessionRef && !this.live.has(chat.id) && chat.provider === 'claude' && this.isActiveElsewhere(chat.sessionRef, chat.id)) {
      throw new ActiveElsewhereError();
    }
    this.touch(chatId);
    this.addMessage(chatId, 'user', text);
    this.transition(chatId, { type: 'user.message' });
    if (!chat.sessionRef) await this.begin(chat, text);
    else await this.deliver(chat, text);
  }

  async answer(chatId: string, requestId: string, decision: Decision): Promise<void> {
    this.mustGet(chatId);
    while (this.pending.has(chatId)) await this.pending.get(chatId);
    const chat = this.mustGet(chatId);
    const open = this.requests.get(chatId);
    if (!open?.has(requestId)) throw new Error('That request is no longer open.');
    const adapter = this.adapters[chat.provider];
    if (!adapter || !chat.sessionRef) throw new Error('That request is no longer open.');
    try {
      await adapter.respondToRequest(chat.sessionRef, requestId, decision);
    } catch (err) {
      this.fail(chatId, chat.provider, err);
      return;
    }
    open.delete(requestId);
    if (open.size === 0) this.transition(chatId, { type: 'user.answered' });
  }

  async stop(chatId: string): Promise<void> {
    this.mustGet(chatId);
    while (this.pending.has(chatId)) await this.pending.get(chatId);
    const chat = this.mustGet(chatId);
    const adapter = this.adapters[chat.provider];
    if (adapter && chat.sessionRef) {
      try { await adapter.stop(chat.sessionRef); } catch { /* still park the card as stopped */ }
    }
    this.requests.delete(chatId);
    this.live.delete(chatId);
    this.touch(chatId);
    this.transition(chatId, { type: 'user.stop' });
  }

  markDone(chatId: string): Chat {
    this.mustGet(chatId);
    this.transition(chatId, { type: 'user.markDone' }, { doneAt: this.now().toISOString() });
    return this.store.getChat(chatId)!;
  }

  dragOutOfDone(chatId: string): Chat {
    this.mustGet(chatId);
    this.transition(chatId, { type: 'user.dragOut' }, { doneAt: null });
    return this.store.getChat(chatId)!;
  }

  archive(chatId: string): Chat {
    this.mustGet(chatId);
    const chat = this.store.updateChat(chatId, { archived: true });
    this.broadcast({ type: 'chat.updated', chat });
    return chat;
  }

  async continueHistory(h: HistoryChat, text: string): Promise<Chat> {
    // Serialize per (provider, sessionRef) so concurrent calls reuse one chat.
    const key = `${h.provider}:${h.sessionRef}`;
    const prev = this.historyGates.get(key);
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.historyGates.set(key, mine);
    try {
      await prev;
      return await this.continueHistoryNow(h, text);
    } finally {
      release();
      if (this.historyGates.get(key) === mine) this.historyGates.delete(key);
    }
  }

  private async continueHistoryNow(h: HistoryChat, text: string): Promise<Chat> {
    const existing = this.store.findBySessionRef(h.provider, h.sessionRef);
    if (existing) {
      await this.send(existing.id, text);
      return this.store.getChat(existing.id)!;
    }
    if (h.provider === 'claude' && this.isActiveElsewhere(h.sessionRef)) throw new ActiveElsewhereError();
    const chat = this.store.createChat({ provider: h.provider, cwd: h.cwd, title: h.title, sessionRef: h.sessionRef });
    this.addMessage(chat.id, 'user', text);
    this.broadcast({ type: 'chat.updated', chat });
    this.replayBuffered(h.provider, h.sessionRef, chat.id);
    await this.deliver(chat, text);
    return this.store.getChat(chat.id)!;
  }

  listChats(): Chat[] { return this.store.listChats(); }

  getChat(chatId: string): Chat { return this.mustGet(chatId); }

  listMessages(chatId: string): Message[] {
    this.mustGet(chatId);
    return this.store.listMessages(chatId);
  }

  recoverAfterRestart(): void {
    this.live.clear();
    for (const chat of this.store.listChats()) {
      if (chat.column === 'running') this.transition(chat.id, { type: 'app.restarted' });
    }
  }

  // ---- internals ----

  private mustGet(chatId: string): Chat {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error('Chat not found.');
    return chat;
  }

  private broadcast(e: ServerEvent): void {
    try { this.emit(e); } catch { /* a bad listener must not break state handling */ }
  }

  private addMessage(chatId: string, role: 'user' | 'assistant', text: string) {
    const message = this.store.addMessage(chatId, role, text);
    this.broadcast({ type: 'message.completed', chatId, message });
    return message;
  }

  /** Apply an event through the column state machine; broadcast chat.updated on any change. */
  private transition(chatId: string, event: AdapterEvent | UserAction, extra: Partial<Chat> = {}): void {
    const chat = this.store.getChat(chatId);
    if (!chat) return;
    const current = { column: chat.column ?? 'running', needsReason: chat.needsReason };
    const next = nextState(current, event);
    const changed = next.column !== chat.column || next.needsReason !== chat.needsReason
      || Object.entries(extra).some(([k, v]) => chat[k as keyof Chat] !== v);
    if (!changed) return;
    const updated = this.store.updateChat(chatId, { column: next.column, needsReason: next.needsReason, ...extra });
    this.broadcast({ type: 'chat.updated', chat: updated });
  }

  private errorCopy(provider: ProviderId, err: unknown | null): string {
    const name = NAMES[provider];
    if (err === null) return `${name} isn't installed. Open Connections to install it.`;
    const msg = err instanceof Error ? err.message : String(err);
    return /sign|auth|login/i.test(msg)
      ? `${name} isn't signed in. Open Connections to sign in.`
      : `${name} stopped unexpectedly. Resume to try again.`;
  }

  /** err === null means no adapter is configured. */
  private fail(chatId: string, provider: ProviderId, err: unknown | null): Chat {
    this.requests.delete(chatId);
    this.live.delete(chatId);
    this.touch(chatId);
    this.addMessage(chatId, 'assistant', this.errorCopy(provider, err));
    this.transition(chatId, { type: 'error', sessionRef: '', message: '' });
    this.broadcast({ type: 'notification', chatId, kind: 'error' });
    return this.store.getChat(chatId)!;
  }

  /** Start a provider session for a chat that has none, and claim its sessionRef. Never throws. */
  // Callers wait with `while (this.pending.has(id)) await ...` inline: no await when idle, so same-tick calls queue correctly.

  private async begin(chat: Chat, prompt: string): Promise<void> {
    let release!: () => void;
    this.pending.set(chat.id, new Promise<void>((r) => { release = r; }));
    try {
      const adapter = this.adapters[chat.provider];
      if (!adapter) { this.fail(chat.id, chat.provider, null); return; }
      try {
        const { sessionRef } = await adapter.startChat({ cwd: chat.cwd, prompt, ...(chat.model ? { model: chat.model } : {}) });
        this.live.add(chat.id);
        this.claim(chat.id, chat.provider, sessionRef);
      } catch (err) {
        this.fail(chat.id, chat.provider, err);
      }
    } finally {
      this.pending.delete(chat.id);
      release();
    }
  }

  /** Attach the provider session to the chat, then replay any events that arrived early. */
  private claim(chatId: string, provider: ProviderId, sessionRef: string): void {
    const chat = this.store.updateChat(chatId, { sessionRef });
    this.broadcast({ type: 'chat.updated', chat });
    this.replayBuffered(provider, sessionRef, chatId);
  }

  private replayBuffered(provider: ProviderId, sessionRef: string, chatId: string): void {
    const buf = this.freshBuffer(provider);
    const mine = buf.filter((b) => b.event.sessionRef === sessionRef);
    this.buffers.set(provider, buf.filter((b) => b.event.sessionRef !== sessionRef));
    if (mine.length === 0) return;
    for (const b of mine) this.handle(chatId, provider, b.event);
  }

  private async deliver(chat: Chat, text: string): Promise<void> {
    const adapter = this.adapters[chat.provider];
    if (!adapter) { this.fail(chat.id, chat.provider, null); return; }
    try {
      if (!chat.sessionRef) throw new Error('no session');
      if (!this.live.has(chat.id)) {
        let p = this.resuming.get(chat.id);
        if (!p) {
          p = adapter.resume(chat.sessionRef, chat.cwd).then(() => { this.live.add(chat.id); });
          this.resuming.set(chat.id, p);
          const clear = () => { this.resuming.delete(chat.id); };
          p.then(clear, clear);
        }
        await p;
      }
      await adapter.sendMessage(chat.sessionRef, text);
    } catch (err) {
      // Concurrent callers share one failed resume: report it once.
      if (typeof err === 'object' && err !== null) {
        let chats = this.reported.get(err);
        if (!chats) { chats = new Set(); this.reported.set(err, chats); }
        if (chats.has(chat.id)) return;
        chats.add(chat.id);
      }
      this.fail(chat.id, chat.provider, err);
    }
  }

  private touch(chatId: string): void {
    this.lastOwn.set(chatId, this.now().getTime());
  }

  private isActiveElsewhere(sessionRef: string, chatId?: string): boolean {
    const root = join(this.claudeHome, 'projects');
    let dirs: string[];
    try { dirs = readdirSync(root); } catch { return false; }
    const nowMs = this.now().getTime();
    const own = chatId === undefined ? undefined : this.lastOwn.get(chatId);
    for (const d of dirs) {
      try {
        const m = statSync(join(root, d, `${sessionRef}.jsonl`)).mtimeMs;
        if (own !== undefined && m <= own + OWN_WRITE_SLACK_MS) continue; // our own write
        if (nowMs - m < ACTIVE_WINDOW_MS) return true;
      } catch { /* no such file in this project */ }
    }
    return false;
  }

  private onAdapterEvent(provider: ProviderId, e: AdapterEvent): void {
    let chatId: string | undefined;
    try {
      const chat = this.store.findBySessionRef(provider, e.sessionRef);
      if (!chat) { this.buffer(provider, e); return; }
      chatId = chat.id;
      this.handle(chat.id, provider, e);
    } catch (err) {
      console.error(`ChatService: failed handling ${e.type} for chat ${chatId ?? `(${provider} ${e.sessionRef})`}`, err);
      if (chatId) {
        try { this.fail(chatId, provider, err); } catch { /* store is unusable; nothing more to do */ }
      }
    }
  }

  private freshBuffer(provider: ProviderId): { at: number; event: AdapterEvent }[] {
    const cutoff = this.now().getTime() - BUFFER_MAX_AGE_MS;
    return (this.buffers.get(provider) ?? []).filter((b) => b.at >= cutoff);
  }

  private buffer(provider: ProviderId, e: AdapterEvent): void {
    const buf = this.freshBuffer(provider);
    buf.push({ at: this.now().getTime(), event: e });
    while (buf.length > BUFFER_MAX) buf.shift();
    this.buffers.set(provider, buf);
  }

  private handle(chatId: string, provider: ProviderId, e: AdapterEvent): void {
    this.touch(chatId);
    switch (e.type) {
      case 'message.delta': {
        const ids = this.idsFor(chatId);
        let id = ids.get(e.messageId);
        if (!id) {
          id = this.store.addMessage(chatId, 'assistant', e.text).id;
          ids.set(e.messageId, id);
        } else {
          this.store.appendToMessage(id, e.text);
        }
        this.broadcast({ type: 'message.delta', chatId, messageId: id, text: e.text });
        return;
      }
      case 'message.completed': {
        const ids = this.idsFor(chatId);
        const id = ids.get(e.messageId);
        if (id) {
          this.store.setMessageText(id, e.text);
          const message = this.store.listMessages(chatId).find((m) => m.id === id)!;
          this.broadcast({ type: 'message.completed', chatId, message });
        } else {
          ids.set(e.messageId, this.addMessage(chatId, 'assistant', e.text).id);
        }
        return;
      }
      case 'tool.call': {
        const toolCall = this.store.upsertToolCall({ id: e.toolCallId, chatId, name: e.name, summary: e.summary, status: e.status });
        this.broadcast({ type: 'tool.call', chatId, toolCall });
        return;
      }
      case 'request.opened': {
        let open = this.requests.get(chatId);
        if (!open) { open = new Map(); this.requests.set(chatId, open); }
        open.set(e.requestId, { kind: e.kind, summary: e.summary });
        this.transition(chatId, e);
        this.broadcast({ type: 'request.opened', chatId, requestId: e.requestId, kind: e.kind, summary: e.summary });
        this.broadcast({ type: 'notification', chatId, kind: e.kind });
        return;
      }
      case 'turn.completed': {
        this.settle(chatId);
        this.transition(chatId, e);
        this.broadcast({ type: 'notification', chatId, kind: 'finished' });
        try { this.usage.refresh(provider).catch(() => {}); } catch { /* usage must never break a chat */ }
        return;
      }
      case 'limit.reached':
        this.requests.delete(chatId);
        this.transition(chatId, e);
        this.broadcast({ type: 'notification', chatId, kind: 'limit' });
        return;
      case 'error': {
        this.live.delete(chatId);
        this.settle(chatId);
        this.addMessage(chatId, 'assistant', this.errorCopy(provider, new Error(e.message)));
        this.transition(chatId, e);
        if (this.store.getChat(chatId)?.column !== 'done') this.broadcast({ type: 'notification', chatId, kind: 'error' });
        return;
      }
      case 'stopped':
        this.live.delete(chatId);
        this.settle(chatId);
        this.transition(chatId, e);
        return;
      case 'turn.started':
        this.transition(chatId, e);
        return;
      case 'session.started':
        return;
    }
  }

  /** The turn is over: forget its open requests and message-id mapping. */
  private settle(chatId: string): void {
    this.requests.delete(chatId);
    this.messageIds.delete(chatId);
  }

  private idsFor(chatId: string): Map<string, string> {
    let m = this.messageIds.get(chatId);
    if (!m) { m = new Map(); this.messageIds.set(chatId, m); }
    return m;
  }
}
