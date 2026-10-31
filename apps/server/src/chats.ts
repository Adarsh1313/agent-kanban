import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterEvent, Chat, HistoryChat, Message, OpenRequest, ProviderId, ServerEvent, ToolCall, UserAction,
} from '@agent-kanban/shared';
import { nextState } from './columns.ts';
import type { Store } from './store.ts';
import type { ProviderAdapter } from './adapters/adapter.ts';
import { AdapterRegistry } from './adapters/registry.ts';
import type { AdapterSource } from './adapters/registry.ts';
import type { UsageService } from './usage/service.ts';
import { ANTIGRAVITY_SIGNED_OUT } from './adapters/antigravity.ts';

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const ACTIVE_WINDOW_MS = 15_000;
const OWN_WRITE_SLACK_MS = 2_000;
const BUFFER_MAX = 500;
const BUFFER_MAX_AGE_MS = 60_000;

/** Provider errors sometimes arrive as a JSON body; show the human message inside it. */
function readable(msg: string): string {
  let out = msg;
  try {
    const j = JSON.parse(msg) as { error?: { message?: unknown }; message?: unknown };
    const inner = j?.error?.message ?? j?.message;
    if (typeof inner === 'string' && inner) out = inner;
  } catch { /* plain text */ }
  return out.length > 300 ? out.slice(0, 300) + '…' : out;
}

export class ActiveElsewhereError extends Error {
  constructor() {
    super("This chat is active in Claude Code right now. Try again when it's idle.");
    this.name = 'ActiveElsewhereError';
  }
}

/** The provider refused to reopen a conversation from its history (the API answers 409). */
export class CantContinueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CantContinueError';
  }
}

export const ANTIGRAVITY_CANT_CONTINUE = "This Antigravity chat can't be continued here yet. Start a new chat in the same folder.";

type Decision = 'allow' | 'deny' | { reply: string };
type LiveRequest = { kind: 'permission' | 'question'; summary: string };

export class ChatService {
  private store: Store;
  private adapters: AdapterSource;
  private usage: UsageService;
  private emit: (e: ServerEvent) => void;
  private claudeHome: string;
  private now: () => Date;
  private buffers = new Map<ProviderId, { at: number; event: AdapterEvent }[]>();
  private messageIds = new Map<string, Map<string, string>>();
  /** Stored ids of assistant messages that received deltas but no message.completed yet, per chat. */
  private partials = new Map<string, Set<string>>();
  /** Open requests the adapter can still answer (this process). The store keeps a copy for read-back. */
  private requests = new Map<string, Map<string, LiveRequest>>();
  /** Chats whose provider session is attached in this process (started or resumed). */
  private live = new Set<string>();
  /** Resolves when an in-progress startChat for the chat has settled. */
  private pending = new Map<string, Promise<void>>();
  private resuming = new Map<string, Promise<void>>();
  /** Chats stopped while their session was still starting: stopped as soon as the session arrives. */
  private stopAfterStart = new Set<string>();
  /**
   * Chats stopped while starting whose first turn may still report: its turn.started / request.opened are dropped and
   * its terminal event (turn.completed / stopped / error) ends it without moving the card. Cleared by that terminal
   * event or the user's next message, not when the start settles.
   */
  private userStopped = new Set<string>();
  /** Last time this process drove or heard from each chat (ms). Distinguishes our own .jsonl writes from another app's. */
  private lastOwn = new Map<string, number>();
  /** Errors already reported, per chat: one failed resume is shared by concurrent callers of the SAME chat only. */
  private reported = new WeakMap<object, Set<string>>();
  private historyGates = new Map<string, Promise<void>>();

  constructor(opts: {
    store: Store;
    adapters: Partial<Record<ProviderId, ProviderAdapter>> | AdapterSource;
    usage: UsageService;
    broadcast: (e: ServerEvent) => void;
    claudeHome: string;
    now?: () => Date;
  }) {
    this.store = opts.store;
    this.adapters = typeof (opts.adapters as AdapterSource).onAdapter === 'function' ? (opts.adapters as AdapterSource) : AdapterRegistry.of(opts.adapters as Partial<Record<ProviderId, ProviderAdapter>>);
    this.usage = opts.usage;
    this.emit = opts.broadcast;
    this.claudeHome = opts.claudeHome;
    this.now = opts.now ?? (() => new Date());
    this.adapters.onAdapter((id, adapter) => {
      adapter.onEvent((e) => this.onAdapterEvent(id, e));
      // A new adapter (e.g. the binary moved) knows none of the old one's chats: the next message resumes them.
      for (const chatId of [...this.live]) {
        if (this.store.getChat(chatId)?.provider === id) this.live.delete(chatId);
      }
    });
  }

  // ---- public API ----

  /** `title` and `routineId` are set by a routine's run (#45); a plain new chat is titled from its prompt. */
  async start(input: { provider: ProviderId; cwd: string; prompt: string; model?: string; title?: string; routineId?: string }): Promise<Chat> {
    const chat = this.store.createChat({
      provider: input.provider, cwd: input.cwd, title: input.title ?? input.prompt, model: input.model ?? null, routineId: input.routineId ?? null,
    });
    this.addMessage(chat.id, 'user', input.prompt);
    this.broadcast({ type: 'chat.updated', chat });
    // Answer as soon as the card exists (running, "Getting started…"): a cold Antigravity takes a minute or two to
    // open a session. The session arrives by chat.updated; a failure moves the card to Needs you with the error.
    // begin() marks the chat pending synchronously, so a message or answer sent meanwhile waits for it.
    void this.begin(chat, input.prompt);
    return chat;
  }

  /** Resolves once the chat's provider session has started or failed to (at once when nothing is starting). */
  async started(chatId: string): Promise<void> {
    while (this.pending.has(chatId)) await this.pending.get(chatId);
  }

  async send(chatId: string, text: string): Promise<void> {
    this.mustGet(chatId);
    while (this.pending.has(chatId)) await this.pending.get(chatId);
    const chat = this.mustGet(chatId);
    if (chat.sessionRef && !this.live.has(chat.id) && chat.provider === 'claude' && this.isActiveElsewhere(chat.sessionRef, chat.id)) {
      throw new ActiveElsewhereError();
    }
    this.touch(chatId);
    this.userStopped.delete(chatId); // the user moved on: the new turn's events count
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
    const adapter = this.adapters.get(chat.provider);
    if (!adapter || !chat.sessionRef) throw new Error('That request is no longer open.');
    try {
      await adapter.respondToRequest(chat.sessionRef, requestId, decision);
    } catch (err) {
      this.fail(chatId, chat.provider, err);
      return;
    }
    open.delete(requestId);
    this.store.setRequestStatus(chatId, requestId, 'answered');
    this.broadcast({ type: 'request.closed', chatId, requestId });
    if (open.size === 0) this.transition(chatId, { type: 'user.answered' });
  }

  async stop(chatId: string): Promise<void> {
    this.mustGet(chatId);
    if (this.pending.has(chatId)) {
      // Still starting (a cold Antigravity can take minutes): park the card now; begin() stops the turn once the session arrives.
      this.stopAfterStart.add(chatId);
      this.userStopped.add(chatId);
      this.closeRequests(chatId);
      this.touch(chatId);
      this.transition(chatId, { type: 'user.stop' });
      return;
    }
    const chat = this.mustGet(chatId);
    const adapter = this.adapters.get(chat.provider);
    // Park the card at once; the agent may take a while to end its turn (Antigravity's stop waits up to 10 s).
    this.closeRequests(chatId);
    this.live.delete(chatId);
    this.touch(chatId);
    this.transition(chatId, { type: 'user.stop' });
    if (adapter && chat.sessionRef) {
      try { await adapter.stop(chat.sessionRef); } catch { /* the card is already parked as stopped */ }
    }
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
    this.partials.delete(chatId);
    this.broadcast({ type: 'chat.updated', chat });
    return chat;
  }

  /** Rename, pin or snooze a chat. */
  patch(chatId: string, patch: { title?: string; pinned?: boolean; snoozedUntil?: string | null }): Chat {
    const current = this.mustGet(chatId);
    if (Object.values(patch).every((v) => v === undefined)) return current;
    // Not activity: the card keeps its place and its "5m ago".
    const chat = this.store.updateChat(chatId, patch, { touch: false });
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
    // Antigravity: reopen the conversation (session/load) before making a card, so a refusal leaves nothing behind.
    let attached: ProviderAdapter | undefined;
    if (h.provider === 'antigravity') {
      attached = await this.adapters.ensure('antigravity');
      if (attached) {
        try { await attached.resume(h.sessionRef, h.cwd); } catch (err) {
          // Signed out: make the card anyway, so it says to sign in (the send below fails the same way).
          if (err instanceof Error && err.message === ANTIGRAVITY_SIGNED_OUT) attached = undefined;
          // The agent answered with a JSON-RPC error: it refuses this conversation.
          else if (typeof (err as { code?: unknown } | null)?.code === 'number') throw new CantContinueError(ANTIGRAVITY_CANT_CONTINUE);
          else throw err; // couldn't start or reach the agent: not a refusal
        }
      }
    }
    const chat = this.store.createChat({ provider: h.provider, cwd: h.cwd, title: h.title, sessionRef: h.sessionRef });
    if (attached && this.adapters.get('antigravity') === attached) this.live.add(chat.id);
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

  /** The permissions and questions this chat is waiting on. */
  listOpenRequests(chatId: string): OpenRequest[] {
    this.mustGet(chatId);
    return this.store.listOpenRequests(chatId);
  }

  listToolCalls(chatId: string): ToolCall[] {
    this.mustGet(chatId);
    return this.store.listToolCalls(chatId);
  }

  /** After a restart nothing from the old processes can continue: interrupt running and waiting chats, close their requests. */
  recoverAfterRestart(): void {
    this.live.clear();
    this.requests.clear();
    for (const chat of this.store.listChats()) this.announceClosed(chat.id);
    this.store.closeOpenRequests();
    for (const chat of this.store.listChats()) this.transition(chat.id, { type: 'app.restarted' });
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
    return /\b(sign(ed)?[ -]?in|log(ged)?[ -]?in|login|unauthori[sz]ed|authenticat\w*|not authenticated|401)\b/i.test(msg)
      ? `${name} isn't signed in. Open Connections to sign in.`
      : msg.startsWith(`${name} stopped unexpectedly`)
        ? `${name} stopped unexpectedly. Resume to try again.`
        : msg.startsWith(`${name} stopped responding and was restarted`)
          ? `${name} stopped responding and was restarted. Resume to continue.`
          : `${name} couldn't continue: ${readable(msg)}`;
  }

  /** err === null means no adapter is configured. */
  private fail(chatId: string, provider: ProviderId, err: unknown | null): Chat {
    this.closeRequests(chatId);
    this.live.delete(chatId);
    this.touch(chatId);
    this.addMessage(chatId, 'assistant', this.errorCopy(provider, err));
    this.transition(chatId, { type: 'error', sessionRef: '', message: '' });
    this.broadcast({ type: 'notification', chatId, kind: 'error' });
    return this.store.getChat(chatId)!;
  }

  /** A failure the user no longer waits for (they stopped the chat or marked it done): store the copy, move nothing. */
  private failQuietly(chatId: string, provider: ProviderId, err: unknown | null): void {
    this.closeRequests(chatId);
    this.live.delete(chatId);
    this.userStopped.delete(chatId);
    this.addMessage(chatId, 'assistant', this.errorCopy(provider, err));
  }

  /** Start a provider session for a chat that has none, and claim its sessionRef. Never throws. */
  // Callers wait with `while (this.pending.has(id)) await ...` inline: no await when idle, so same-tick calls queue correctly.

  private async begin(chat: Chat, prompt: string): Promise<void> {
    let release!: () => void;
    this.pending.set(chat.id, new Promise<void>((r) => { release = r; }));
    try {
      const adapter = await this.adapters.ensure(chat.provider);
      if (!adapter) { this.fail(chat.id, chat.provider, null); return; }
      const { sessionRef } = await adapter.startChat({ cwd: chat.cwd, prompt, ...(chat.model ? { model: chat.model } : {}) });
      this.live.add(chat.id);
      this.claim(chat.id, chat.provider, sessionRef);
      // Stopped, or marked done, while the session was starting: its first turn must not keep running.
      if (this.stopAfterStart.has(chat.id) || this.store.getChat(chat.id)?.column === 'done') {
        try { await adapter.stop(sessionRef); } catch { /* the card is already parked */ }
      }
    } catch (err) {
      // Nobody awaits a start: any failure (also from ensure) belongs on the card, never an unhandled rejection.
      try {
        // Stopped, or marked done, while starting: the card stays where the user put it; the error is kept quietly.
        if (this.stopAfterStart.has(chat.id) || this.store.getChat(chat.id)?.column === 'done') this.failQuietly(chat.id, chat.provider, err);
        else this.fail(chat.id, chat.provider, err);
      } catch { /* the chat is gone */ }
    } finally {
      this.stopAfterStart.delete(chat.id);
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
    const adapter = await this.adapters.ensure(chat.provider);
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
    if (this.userStopped.has(chatId)) {
      // The turn the user stopped while it was starting: it must not reopen the card or ask anything.
      if (e.type === 'turn.started' || e.type === 'request.opened') return;
      if (e.type === 'turn.completed' || e.type === 'stopped' || e.type === 'error') {
        this.userStopped.delete(chatId);
        if (e.type !== 'turn.completed') this.live.delete(chatId);
        this.settle(chatId);
        return;
      }
    }
    switch (e.type) {
      case 'message.delta': {
        const ids = this.idsFor(chatId);
        let id = ids.get(e.messageId);
        let offset = 0;
        if (!id) {
          id = this.store.addMessage(chatId, 'assistant', e.text).id;
          ids.set(e.messageId, id);
        } else {
          offset = this.store.getMessage(id)?.text.length ?? 0;
          this.store.appendToMessage(id, e.text);
        }
        let open = this.partials.get(chatId);
        if (!open) { open = new Set(); this.partials.set(chatId, open); }
        open.add(id);
        this.broadcast({ type: 'message.delta', chatId, messageId: id, text: e.text, offset });
        return;
      }
      case 'message.completed': {
        const ids = this.idsFor(chatId);
        const id = ids.get(e.messageId);
        if (id) {
          this.partials.get(chatId)?.delete(id);
          this.store.setMessageText(id, e.text);
          const message = this.store.getMessage(id);
          if (message) this.broadcast({ type: 'message.completed', chatId, message });
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
        // A permission says what it is for (edit / command / tool) so the card and notification copy can match.
        const action = e.kind === 'permission' && e.action ? { action: e.action } : {};
        this.store.addRequest(chatId, { requestId: e.requestId, kind: e.kind, summary: e.summary, ...action });
        this.transition(chatId, e);
        this.broadcast({ type: 'request.opened', chatId, requestId: e.requestId, kind: e.kind, summary: e.summary, ...action });
        this.broadcast({ type: 'notification', chatId, kind: e.kind, ...action });
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
        this.closeRequests(chatId);
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
    this.closeRequests(chatId);
    this.messageIds.delete(chatId);
  }

  /** Open requests can no longer be answered (turn over, stopped, failed): drop them here and in the store. */
  private closeRequests(chatId: string): void {
    this.finalizePartials(chatId);
    this.requests.delete(chatId);
    this.announceClosed(chatId);
    this.store.closeOpenRequests(chatId);
  }

  /** A turn ended (stop, error, limit) with assistant text still streaming: settle it with the stored text. */
  private finalizePartials(chatId: string): void {
    const open = this.partials.get(chatId);
    if (!open) return;
    this.partials.delete(chatId);
    for (const id of open) {
      const message = this.store.getMessage(id);
      if (message) this.broadcast({ type: 'message.completed', chatId, message });
    }
  }

  /** Tells every open page that the chat's still-open requests are gone. */
  private announceClosed(chatId: string): void {
    for (const r of this.store.listOpenRequests(chatId)) this.broadcast({ type: 'request.closed', chatId, requestId: r.requestId });
  }

  private idsFor(chatId: string): Map<string, string> {
    let m = this.messageIds.get(chatId);
    if (!m) { m = new Map(); this.messageIds.set(chatId, m); }
    return m;
  }
}
