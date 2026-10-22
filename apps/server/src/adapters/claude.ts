import { randomUUID } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, UsageReading } from '@agent-kanban/shared';
import type { PingResult, ProviderAdapter } from './adapter.ts';
import { resolveSpawnTarget } from './spawn-target.ts';
import { claudeUsageToReading } from '../usage/parse.ts';

type Listener = (e: AdapterEvent) => void;
type Decision = 'allow' | 'deny' | { reply: string };
type Pending = { toolName: string; input: Record<string, unknown>; resolve: (r: PermissionResult) => void };

/** The only caller of the SDK's experimental usage method: if it is renamed, fix it here. */
export async function readClaudeUsage(q: Query): Promise<UsageReading> {
  const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  // The parser reads only the keys it knows; the SDK type also carries array-valued extras.
  return claudeUsageToReading(r as unknown as Parameters<typeof claudeUsageToReading>[0], new Date());
}

/** A push-able async iterable: the streaming-input prompt for one query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: msg, done: false }); }
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: undefined, done: true }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

type Chat = {
  sessionRef: string | null;
  cwd: string;
  model: string | undefined;
  queue: InputQueue;
  query: Query | null;
  turnRunning: boolean;
  turnAnnounced: boolean;
  stopping: boolean;
  pending: Map<string, Pending>;
  onStarted?: { resolve: () => void; reject: (e: Error) => void };
  deferred: Array<() => void>; // request.opened emissions waiting for the session id
};

const SHUT_DOWN = 'Claude Code adapter is shut down.';
const DIED = 'Claude Code stopped unexpectedly.';

export class ClaudeAdapter implements ProviderAdapter {
  id = 'claude' as const;
  private listeners = new Set<Listener>();
  private chats = new Map<string, Chat>();
  private claudePath: string;
  private query: typeof sdkQuery;
  private disposed = false;
  private live = new Set<Chat>(); // every chat with a launched query, including ones still starting
  private usageQuery: Query | null = null;
  private usageTimeoutMs: number;

  constructor(opts: { claudePath: string; query?: typeof sdkQuery; usageTimeoutMs?: number }) {
    this.usageTimeoutMs = opts.usageTimeoutMs ?? 15_000;
    // The SDK needs the real executable (an .exe, or a .js script it runs with node), never a .cmd shim.
    const target = resolveSpawnTarget(opts.claudePath);
    this.claudePath = target.args.length === 0 ? target.command : target.args[0]!;
    this.query = opts.query ?? sdkQuery;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(e: AdapterEvent): void {
    for (const l of [...this.listeners]) {
      try { l(e); } catch { /* a faulty listener must not look like a process death */ }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error(SHUT_DOWN);
  }

  private newChat(cwd: string, model: string | undefined, sessionRef: string | null): Chat {
    return { sessionRef, cwd, model, queue: new InputQueue(), query: null, turnRunning: false, turnAnnounced: false, stopping: false, pending: new Map(), deferred: [] };
  }

  private launch(chat: Chat, resume?: string): void {
    const canUseTool: CanUseTool = (toolName, input, { signal }) => new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      chat.pending.set(requestId, { toolName, input, resolve });
      signal.addEventListener('abort', () => { chat.pending.delete(requestId); }, { once: true });
      const announce = () => this.emit({
        type: 'request.opened', sessionRef: chat.sessionRef!, requestId,
        kind: toolName === 'AskUserQuestion' ? 'question' : 'permission',
        summary: requestSummary(toolName, input),
      });
      if (chat.sessionRef === null) chat.deferred.push(() => { if (chat.pending.has(requestId)) announce(); });
      else announce();
    });
    const options: Record<string, unknown> = { cwd: chat.cwd, pathToClaudeCodeExecutable: this.claudePath, permissionMode: 'default', canUseTool };
    if (chat.model) options.model = chat.model;
    if (resume) options.resume = resume;
    const q = this.query({ prompt: chat.queue, options: options as never });
    chat.query = q;
    this.live.add(chat);
    void this.consume(chat, q);
  }

  private async consume(chat: Chat, q: Query): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const m of q) this.handle(chat, m as any);
    } catch (e) {
      failure = e;
    }
    if (chat.query !== q) return; // replaced, closed or disposed on purpose
    chat.query = null;
    this.live.delete(chat);
    try { q.close(); } catch { /* already gone */ }
    chat.queue.close();
    for (const p of chat.pending.values()) p.resolve({ behavior: 'deny', message: 'Claude Code stopped.' });
    chat.pending.clear();
    chat.deferred = [];
    if (this.disposed) return;
    if (chat.sessionRef === null) {
      chat.onStarted?.reject(new Error(failure instanceof Error && failure.message ? failure.message : DIED));
      return;
    }
    const wasRunning = chat.turnRunning && !chat.stopping;
    chat.turnRunning = false; chat.turnAnnounced = false; chat.stopping = false;
    chat.queue = new InputQueue();
    if (wasRunning) this.emit({ type: 'error', sessionRef: chat.sessionRef, message: DIED });
  }

  private handle(chat: Chat, m: any): void {
    if (this.disposed) return;
    if (typeof m?.session_id === 'string' && m.session_id && chat.sessionRef === null) {
      chat.sessionRef = m.session_id;
      this.chats.set(m.session_id, chat);
      this.emit({ type: 'session.started', sessionRef: m.session_id });
      const deferred = chat.deferred; chat.deferred = [];
      for (const d of deferred) d();
      chat.onStarted?.resolve();
    }
    if (m.type === 'result' && chat.sessionRef === null) {
      chat.onStarted?.reject(new Error(typeof m.result === 'string' && m.result ? m.result : 'Claude Code ran into a problem.'));
      return;
    }
    const sessionRef = chat.sessionRef;
    if (sessionRef === null) return;
    if (m.type === 'assistant') {
      if (chat.stopping) return;
      if (!chat.turnAnnounced) { chat.turnAnnounced = true; chat.turnRunning = true; this.emit({ type: 'turn.started', sessionRef }); }
      const content: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
      content.forEach((block, i) => {
        if (block?.type === 'text' && typeof block.text === 'string') {
          this.emit({ type: 'message.completed', sessionRef, messageId: `${m.uuid ?? m.message?.id ?? randomUUID()}:${i}`, role: 'assistant', text: block.text });
        } else if (block?.type === 'tool_use') {
          this.emit({ type: 'tool.call', sessionRef, toolCallId: String(block.id), name: String(block.name), summary: toolSummary(block.name, block.input ?? {}), status: 'running' });
        }
      });
    } else if (m.type === 'result') {
      const swallow = chat.stopping;
      chat.turnRunning = false; chat.turnAnnounced = false; chat.stopping = false;
      if (swallow) return;
      if (m.is_error) this.emit({ type: 'error', sessionRef, message: typeof m.result === 'string' && m.result ? m.result : 'Claude Code ran into a problem.' });
      else this.emit({ type: 'turn.completed', sessionRef });
    }
  }

  async startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }> {
    this.assertOpen();
    const chat = this.newChat(input.cwd, input.model, null);
    const started = new Promise<void>((resolve, reject) => { chat.onStarted = { resolve, reject }; });
    chat.turnRunning = true;
    chat.queue.push(input.prompt);
    this.launch(chat);
    try {
      await started;
    } catch (e) {
      const q = chat.query;
      chat.query = null;
      this.live.delete(chat);
      chat.queue.close();
      try { q?.close(); } catch { /* already gone */ }
      throw e;
    }
    return { sessionRef: chat.sessionRef! };
  }

  private chatFor(sessionRef: string): Chat {
    const chat = this.chats.get(sessionRef);
    if (!chat) throw new Error("Claude Code doesn't know this chat yet. Open it again first.");
    return chat;
  }

  async sendMessage(sessionRef: string, text: string): Promise<void> {
    this.assertOpen();
    const chat = this.chatFor(sessionRef);
    chat.turnRunning = true;
    chat.queue.push(text);
    if (!chat.query) this.launch(chat, sessionRef);
  }

  async respondToRequest(_sessionRef: string, requestId: string, decision: Decision): Promise<void> {
    for (const chat of this.chats.values()) {
      const p = chat.pending.get(requestId);
      if (!p) continue;
      chat.pending.delete(requestId);
      if (decision === 'allow') p.resolve({ behavior: 'allow', updatedInput: p.input });
      else if (decision === 'deny') p.resolve({ behavior: 'deny', message: 'The user declined.' });
      else if (p.toolName === 'AskUserQuestion') p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers: decision.reply } });
      else p.resolve({ behavior: 'deny', message: decision.reply });
      return;
    }
  }

  async stop(sessionRef: string): Promise<void> {
    const chat = this.chats.get(sessionRef);
    if (!chat?.query || !chat.turnRunning) return;
    chat.stopping = true;
    chat.turnRunning = false;
    for (const [id, p] of chat.pending) { p.resolve({ behavior: 'deny', message: 'The user declined.' }); chat.pending.delete(id); }
    try { await chat.query.interrupt(); } catch { /* the process may already be gone */ }
    this.emit({ type: 'stopped', sessionRef });
  }

  async resume(sessionRef: string, cwd: string): Promise<void> {
    this.assertOpen();
    const existing = this.chats.get(sessionRef);
    if (existing?.query) return;
    const chat = existing ?? this.newChat(cwd, undefined, sessionRef);
    chat.cwd = cwd;
    this.chats.set(sessionRef, chat);
    this.launch(chat, sessionRef);
  }

  /** A query to ask account/usage questions of: a live chat's, else the shared long-lived one (created on demand). */
  private usageHandle(): { q: Query; shared: boolean } {
    const live = [...this.live].find((c) => c.query && c.sessionRef !== null)?.query ?? null;
    if (live) return { q: live, shared: false };
    if (!this.usageQuery) {
      // One long-lived query with an empty prompt stream; strictMcpConfig + no mcpServers keeps user MCP servers from loading.
      const q = this.query({
        prompt: new InputQueue(),
        options: { pathToClaudeCodeExecutable: this.claudePath, permissionMode: 'default', mcpServers: {}, strictMcpConfig: true } as never,
      });
      this.usageQuery = q;
      this.drain(q);
    }
    return { q: this.usageQuery, shared: true };
  }

  /** Nobody reads the shared query's output, so consume and discard it or its buffer grows for as long as we run. */
  private drain(q: Query): void {
    void (async () => {
      try {
        for await (const _ of q) { if (this.usageQuery !== q) break; }
      } catch { /* closed or crashed: the next call recreates it */ }
    })();
  }

  /** Runs `fn` against a usage handle with the timeout; a failure on the shared query closes it so the next call starts fresh. */
  private async withUsageQuery<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const { q, shared } = this.usageHandle();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.usageTimeoutMs); });
      return await Promise.race([fn(q), timeout]);
    } catch (e) {
      if (shared && this.usageQuery === q) this.closeUsageQuery();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async readUsage(): Promise<UsageReading> {
    this.assertOpen();
    const failed: UsageReading = { provider: 'claude', status: 'error', windows: [], readAt: new Date().toISOString(), message: "Couldn't read Claude Code usage." };
    try {
      return await this.withUsageQuery(readClaudeUsage);
    } catch {
      return failed;
    }
  }

  /** Health check: ask the shared query for the account (no new process per ping). Signed in when it has a token source. */
  async ping(): Promise<PingResult> {
    if (this.disposed) return { ok: false, signedIn: null, message: SHUT_DOWN };
    try {
      const info = await this.withUsageQuery((q) => q.accountInfo());
      return { ok: true, signedIn: !!info?.tokenSource && info.tokenSource !== 'none' };
    } catch (e) {
      return { ok: false, signedIn: null, message: e instanceof Error ? e.message : 'Claude Code did not respond.' };
    }
  }

  private closeUsageQuery(): void {
    const q = this.usageQuery;
    this.usageQuery = null;
    try { q?.close(); } catch { /* already gone */ }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    this.closeUsageQuery();
    const all = new Set<Chat>([...this.chats.values(), ...this.live]);
    this.chats.clear();
    this.live.clear();
    await Promise.all([...all].map(async (chat) => {
      chat.onStarted?.reject(new Error(SHUT_DOWN));
      for (const p of chat.pending.values()) p.resolve({ behavior: 'deny', message: 'Claude Code stopped.' });
      chat.pending.clear();
      chat.deferred = [];
      chat.queue.close();
      const q = chat.query;
      chat.query = null;
      if (!q) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([q.interrupt(), new Promise((r) => { timer = setTimeout(r, 3_000); })]);
      } catch { /* already gone */ }
      clearTimeout(timer);
      try { q.close(); } catch { /* already gone */ }
    }));
  }
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? input.file_path : null;
  if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit') && file) return `Editing ${file}`;
  if (name === 'Read' && file) return `Reading ${file}`;
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') return `Running ${input.command}`;
  return name;
}

function requestSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'AskUserQuestion') {
    const q = (input.questions as Array<{ question?: unknown }> | undefined)?.[0]?.question;
    return typeof q === 'string' ? q : 'Claude Code has a question';
  }
  return toolSummary(name, input);
}
