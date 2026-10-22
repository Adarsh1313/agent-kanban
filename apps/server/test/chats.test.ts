import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, HistoryChat, ProviderId, ServerEvent } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { ChatService, ActiveElsewhereError } from '../src/chats.ts';
import type { ProviderAdapter } from '../src/adapters/adapter.ts';

class FakeAdapter implements ProviderAdapter {
  id: ProviderId;
  calls: string[] = [];
  listeners = new Set<(e: AdapterEvent) => void>();
  startError: Error | null = null;
  beforeResolve: (() => void) | null = null;
  constructor(id: ProviderId) { this.id = id; }
  async startChat() {
    this.calls.push('startChat');
    if (this.startError) throw this.startError;
    this.beforeResolve?.();
    return { sessionRef: 's1' };
  }
  async sendMessage(ref: string, text: string) { this.calls.push(`send:${ref}:${text}`); }
  async respondToRequest(ref: string, rid: string, d: unknown) { this.calls.push(`respond:${ref}:${rid}:${JSON.stringify(d)}`); }
  async stop(ref: string) { this.calls.push(`stop:${ref}`); }
  async resume(ref: string, cwd: string) { this.calls.push(`resume:${ref}:${cwd}`); }
  onEvent(l: (e: AdapterEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async readUsage(): Promise<never> { throw new Error('unused'); }
  async dispose() {}
  emit(e: AdapterEvent) { for (const l of this.listeners) l(e); }
}

function setup(provider: ProviderId = 'codex', now?: () => Date, claudeHome = '/nowhere') {
  const store = new Store(':memory:');
  const adapter = new FakeAdapter(provider);
  const events: ServerEvent[] = [];
  const refreshed: (ProviderId | undefined)[] = [];
  const usage = { refresh: async (p?: ProviderId) => { refreshed.push(p); return []; } };
  const svc = new ChatService({
    store, adapters: { [provider]: adapter }, usage: usage as any, broadcast: (e) => events.push(e), claudeHome, now,
  });
  return { store, adapter, events, refreshed, svc };
}

test('start creates a running chat, stores sessionRef, broadcasts', async () => {
  const { store, adapter, events, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'hello' });
  assert.deepEqual(adapter.calls, ['startChat']);
  const got = store.getChat(chat.id)!;
  assert.equal(got.column, 'running');
  assert.equal(got.sessionRef, 's1');
  assert.ok(events.some((e) => e.type === 'chat.updated' && e.chat.sessionRef === 's1'));
  assert.equal(store.listMessages(chat.id)[0].role, 'user');
});

test('request.opened -> needs_you/permission with notification', async () => {
  const { store, adapter, events, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'request.opened', sessionRef: 's1', requestId: 'r1', kind: 'permission', summary: 'run ls' });
  const got = store.getChat(chat.id)!;
  assert.deepEqual([got.column, got.needsReason], ['needs_you', 'permission']);
  assert.ok(events.some((e) => e.type === 'request.opened' && e.requestId === 'r1'));
  assert.ok(events.some((e) => e.type === 'notification' && e.kind === 'permission'));
  await svc.answer(chat.id, 'r1', 'allow');
  assert.equal(store.getChat(chat.id)!.column, 'running');
  assert.ok(adapter.calls.includes('respond:s1:r1:"allow"'));
  await assert.rejects(svc.answer(chat.id, 'r1', 'allow'), /That request is no longer open\./);
});

test('turn.completed -> review, finished notification, usage refreshed once', async () => {
  const { store, adapter, events, refreshed, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
  assert.equal(store.getChat(chat.id)!.column, 'review');
  assert.ok(events.some((e) => e.type === 'notification' && e.kind === 'finished'));
  assert.deepEqual(refreshed, ['codex']);
});

test('usage refresh rejection is swallowed', async () => {
  const { adapter, svc } = setup();
  (svc as any).usage = { refresh: () => Promise.reject(new Error('boom')) };
  await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
  await new Promise((r) => setTimeout(r, 10));
});

test('deltas then completed produce one assistant message', async () => {
  const { store, adapter, events, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'message.delta', sessionRef: 's1', messageId: 'm1', text: 'Hel' });
  adapter.emit({ type: 'message.delta', sessionRef: 's1', messageId: 'm1', text: 'lo' });
  adapter.emit({ type: 'message.completed', sessionRef: 's1', messageId: 'm1', role: 'assistant', text: 'Hello' });
  const msgs = store.listMessages(chat.id).filter((m) => m.role === 'assistant');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'Hello');
  const delta = events.find((e) => e.type === 'message.delta');
  assert.ok(delta && delta.type === 'message.delta' && delta.messageId === msgs[0].id);
});

test('completed without deltas adds the message; tool.call is stored', async () => {
  const { store, adapter, events, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'message.completed', sessionRef: 's1', messageId: 'm9', role: 'assistant', text: 'whole' });
  adapter.emit({ type: 'tool.call', sessionRef: 's1', toolCallId: 't1', name: 'Bash', summary: 'ls', status: 'running' });
  assert.equal(store.listMessages(chat.id).filter((m) => m.text === 'whole').length, 1);
  assert.ok(events.some((e) => e.type === 'tool.call' && e.toolCall.id === 't1'));
});

test('stop calls the adapter and parks the chat as stopped', async () => {
  const { store, adapter, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  await svc.stop(chat.id);
  assert.ok(adapter.calls.includes('stop:s1'));
  const got = store.getChat(chat.id)!;
  assert.deepEqual([got.column, got.needsReason], ['needs_you', 'stopped']);
});

test('Review 2: startChat rejection lands in needs_you/error with friendly copy', async () => {
  const { store, adapter, svc } = setup();
  adapter.startError = new Error('not signed in');
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  const got = store.getChat(chat.id)!;
  assert.deepEqual([got.column, got.needsReason], ['needs_you', 'error']);
  const last = store.listMessages(chat.id).filter((m) => m.role === 'assistant').pop()!;
  assert.equal(last.text, "Codex isn't signed in. Open Connections to sign in.");
});

test('missing adapter -> not installed copy, no throw', async () => {
  const { store, svc } = setup('codex');
  const chat = await svc.start({ provider: 'claude', cwd: '/w', prompt: 'p' });
  assert.equal(store.getChat(chat.id)!.needsReason, 'error');
  assert.equal(store.listMessages(chat.id).pop()!.text, "Claude Code isn't installed. Open Connections to install it.");
});

test('Review 3: error event for a running chat', async () => {
  const { store, adapter, events, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'error', sessionRef: 's1', message: 'process exited' });
  const got = store.getChat(chat.id)!;
  assert.deepEqual([got.column, got.needsReason], ['needs_you', 'error']);
  assert.ok(events.some((e) => e.type === 'notification' && e.kind === 'error'));
  assert.match(store.listMessages(chat.id).pop()!.text, /Codex stopped unexpectedly\. Resume to try again\./);
});

test('events emitted before startChat resolves are buffered and replayed', async () => {
  const { store, adapter, svc } = setup();
  adapter.beforeResolve = () => {
    adapter.emit({ type: 'message.completed', sessionRef: 's1', messageId: 'm1', role: 'assistant', text: 'early' });
    adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
  };
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  assert.equal(store.getChat(chat.id)!.column, 'review');
  assert.ok(store.listMessages(chat.id).some((m) => m.text === 'early'));
});

test('Review 5: recoverAfterRestart interrupts running chats only', () => {
  const { store, svc } = setup();
  const a = store.createChat({ provider: 'codex', cwd: '/w', title: 'a' });
  const b = store.createChat({ provider: 'codex', cwd: '/w', title: 'b' });
  const c = store.createChat({ provider: 'codex', cwd: '/w', title: 'c' });
  store.updateChat(c.id, { column: 'review' });
  svc.recoverAfterRestart();
  for (const id of [a.id, b.id]) {
    const g = store.getChat(id)!;
    assert.deepEqual([g.column, g.needsReason], ['needs_you', 'interrupted']);
  }
  assert.equal(store.getChat(c.id)!.column, 'review');
});

test('Review 1: continueHistory refuses a chat active in Claude Code', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-home-'));
  mkdirSync(join(home, 'projects', 'proj'), { recursive: true });
  const file = join(home, 'projects', 'proj', 'sess1.jsonl');
  writeFileSync(file, '{}\n');
  const base = new Date('2026-10-22T12:00:00Z');
  const h: HistoryChat = { provider: 'claude', sessionRef: 'sess1', title: 'Old chat', cwd: '/w', updatedAt: base.toISOString() };

  utimesSync(file, new Date(base.getTime() - 5000), new Date(base.getTime() - 5000));
  const t = setup('claude', () => base, home);
  await assert.rejects(t.svc.continueHistory(h, 'hi'), (e: Error) =>
    e instanceof ActiveElsewhereError && e.message === "This chat is active in Claude Code right now. Try again when it's idle.");
  assert.equal(t.store.listChats().length, 0);

  utimesSync(file, new Date(base.getTime() - 60000), new Date(base.getTime() - 60000));
  const chat = await t.svc.continueHistory(h, 'hi');
  assert.deepEqual(t.adapter.calls, ['resume:sess1:/w', 'send:sess1:hi']);
  const got = t.store.getChat(chat.id)!;
  assert.equal(got.column, 'running');
  assert.equal(got.title, 'Old chat');
  const again = await t.svc.continueHistory(h, 'more');
  assert.equal(again.id, chat.id);
  assert.equal(t.store.listChats().length, 1);
  assert.equal(t.adapter.calls.filter((c) => c.startsWith('resume')).length, 1);
});

test('markDone / dragOutOfDone / done chats stay done on agent events', async () => {
  const { store, adapter, svc } = setup();
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
  assert.equal(svc.markDone(chat.id).column, 'done');
  adapter.emit({ type: 'message.completed', sessionRef: 's1', messageId: 'm', role: 'assistant', text: 'x' });
  adapter.emit({ type: 'error', sessionRef: 's1', message: 'x' });
  assert.equal(store.getChat(chat.id)!.column, 'done');
  assert.equal(svc.dragOutOfDone(chat.id).column, 'review');
  assert.equal(svc.archive(chat.id).archived, true);
  assert.throws(() => svc.markDone('nope'), /Chat not found\./);
});

test('a throwing broadcast does not break state handling', async () => {
  const store = new Store(':memory:');
  const adapter = new FakeAdapter('codex');
  const svc = new ChatService({
    store, adapters: { codex: adapter }, usage: { refresh: async () => [] } as any,
    broadcast: () => { throw new Error('ws down'); }, claudeHome: '/nowhere',
  });
  const chat = await svc.start({ provider: 'codex', cwd: '/w', prompt: 'p' });
  adapter.emit({ type: 'turn.completed', sessionRef: 's1' });
  assert.equal(store.getChat(chat.id)!.column, 'review');
});
