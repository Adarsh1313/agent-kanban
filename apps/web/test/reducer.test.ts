import { describe, expect, it } from 'vitest';
import type { ConnectionHealth, UsageReading } from '@agent-kanban/shared';
import { applyEvent, applySnapshot, beginSync, endSync, initialState, isChatLoaded, mergeFetched, missingChats } from '../src/state/reducer.ts';
import { chat, message } from './helpers.ts';

const withChat = (over = {}) => applyEvent(initialState(), { type: 'chat.updated', chat: chat(over) });

describe('applyEvent', () => {
  it('chat.updated inserts then updates', () => {
    let s = withChat();
    expect(s.chats.c1!.title).toBe('A chat');
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ title: 'Renamed' }) });
    expect(Object.keys(s.chats)).toEqual(['c1']);
    expect(s.chats.c1!.title).toBe('Renamed');
  });

  it('message.delta appends to streaming and message.completed replaces it without duplicates', () => {
    let s = withChat();
    s = applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'm1', text: 'Hel' });
    s = applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'm1', text: 'lo' });
    expect(s.streaming.c1!.m1).toBe('Hello');
    s = applyEvent(s, { type: 'message.completed', chatId: 'c1', message: message({ text: 'Hello there' }) });
    expect(s.streaming.c1?.m1).toBeUndefined();
    expect(s.messages.c1).toHaveLength(1);
    s = applyEvent(s, { type: 'message.completed', chatId: 'c1', message: message({ text: 'Hello there' }) });
    expect(s.messages.c1).toHaveLength(1);
    expect(s.messages.c1![0]!.text).toBe('Hello there');
  });

  it('keeps a delta for an unknown chat and reports the chat as missing (Review Focus 2)', () => {
    let s = applyEvent(initialState(), { type: 'message.delta', chatId: 'ghost', messageId: 'm1', text: 'hi' });
    expect(s.streaming.ghost!.m1).toBe('hi');
    expect(missingChats(s)).toEqual(['ghost']);
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'ghost' }) });
    expect(missingChats(s)).toEqual([]);
    expect(s.streaming.ghost!.m1).toBe('hi');
  });

  it('request.opened adds once; chat.updated leaving needs_you clears the requests (Review Focus 5)', () => {
    let s = withChat({ column: 'needs_you', needsReason: 'permission' });
    const opened = { type: 'request.opened', chatId: 'c1', requestId: 'r1', kind: 'permission', summary: 'Run ls' } as const;
    s = applyEvent(s, opened);
    s = applyEvent(s, opened);
    expect(s.requests.c1).toHaveLength(1);
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ column: 'needs_you', needsReason: 'permission' }) });
    expect(s.requests.c1).toHaveLength(1);
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ column: 'running' }) });
    expect(s.requests.c1 ?? []).toEqual([]);
  });

  it('tool.call upserts by id', () => {
    let s = withChat();
    const tc = { id: 't1', chatId: 'c1', name: 'Bash', summary: 'ls', status: 'running' as const, createdAt: 'x' };
    s = applyEvent(s, { type: 'tool.call', chatId: 'c1', toolCall: tc });
    s = applyEvent(s, { type: 'tool.call', chatId: 'c1', toolCall: { ...tc, status: 'done' } });
    expect(s.toolCalls.c1).toHaveLength(1);
    expect(s.toolCalls.c1![0]!.status).toBe('done');
  });

  it('notification adds an unread item', () => {
    const s = applyEvent(withChat(), { type: 'notification', chatId: 'c1', kind: 'finished' }, new Date('2026-10-23T11:00:00.000Z'));
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]).toMatchObject({ chatId: 'c1', kind: 'finished', unread: true, at: '2026-10-23T11:00:00.000Z' });
  });

  it('usage.updated and connection.updated replace per provider', () => {
    const reading = (leftPct: number): UsageReading => ({ provider: 'claude', status: 'ok', windows: [{ kind: 'five_hour', label: '5h', leftPct, resetsAt: null }], readAt: 'x' });
    let s = applyEvent(initialState(), { type: 'usage.updated', reading: reading(80) });
    s = applyEvent(s, { type: 'usage.updated', reading: reading(40) });
    expect(s.usage.claude!.windows[0]!.leftPct).toBe(40);
    const health = (message: string): ConnectionHealth => ({ provider: 'codex', installed: true, path: null, version: null, latestVersion: null, updateAvailable: false, signedIn: true, processOk: true, status: 'connected', message, checkedAt: 'x' });
    s = applyEvent(s, { type: 'connection.updated', health: health('a') });
    s = applyEvent(s, { type: 'connection.updated', health: health('b') });
    expect(s.connections.codex!.message).toBe('b');
  });
});

describe('applySnapshot', () => {
  const snap = (chats = [chat()]) => ({ chats, usage: [], suggested: null, connections: [], history: [], projects: [] });

  it('after a reconnect keeps streaming for chats still running and drops stale requests', () => {
    let s = withChat({ id: 'a' });
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'b', column: 'needs_you', needsReason: 'permission' }) });
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'c', column: 'needs_you', needsReason: 'question' }) });
    s = applyEvent(s, { type: 'message.delta', chatId: 'a', messageId: 'm', text: 'partial' });
    s = applyEvent(s, { type: 'message.delta', chatId: 'b', messageId: 'm', text: 'old' });
    s = applyEvent(s, { type: 'request.opened', chatId: 'b', requestId: 'r1', kind: 'permission', summary: 's' });
    s = applyEvent(s, { type: 'request.opened', chatId: 'c', requestId: 'r2', kind: 'question', summary: 's' });
    const next = applySnapshot(s, snap([
      chat({ id: 'a', updatedAt: '2026-10-23T10:05:00.000Z' }),
      chat({ id: 'b', column: 'review', updatedAt: '2026-10-23T10:05:00.000Z' }),
      chat({ id: 'c', column: 'needs_you', needsReason: 'question', updatedAt: '2026-10-23T10:05:00.000Z' }),
    ]));
    expect(next.streaming.a!.m).toBe('partial');
    expect(next.streaming.b?.m).toBeUndefined();
    expect(next.requests.b ?? []).toEqual([]);
    expect(next.requests.c).toHaveLength(1);
  });

  it('does not overwrite a chat an event updated during the fetch, nor drop one an event created (I3)', () => {
    let s = withChat({ id: 'a', title: 'older', updatedAt: '2026-10-23T11:00:00.000Z' });
    const b = beginSync(s);
    s = applyEvent(b.state, { type: 'chat.updated', chat: chat({ id: 'a', title: 'newer', updatedAt: '2026-10-23T12:00:00.000Z' }) });
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'b' }) });
    const next = applySnapshot(s, snap([chat({ id: 'a', title: 'older', updatedAt: '2026-10-23T11:00:00.000Z' })]), b.since);
    expect(next.chats.a!.title).toBe('newer');
    expect(next.chats.b).toBeDefined();
  });

  it('drops chats a full snapshot lacks (archived or removed elsewhere) with their cached data (I3)', () => {
    let s = withChat({ id: 'gone' });
    s = applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'kept' }) });
    s = applyEvent(s, { type: 'message.completed', chatId: 'gone', message: message({ chatId: 'gone' }) });
    const next = applySnapshot(s, snap([chat({ id: 'kept' })]));
    expect(Object.keys(next.chats)).toEqual(['kept']);
    expect(next.messages.gone).toBeUndefined();
  });

  it('keeps streaming buffered for chats the snapshot does not know yet', () => {
    const s = applyEvent(initialState(), { type: 'message.delta', chatId: 'ghost', messageId: 'm', text: 'x' });
    expect(applySnapshot(s, snap()).streaming.ghost!.m).toBe('x');
  });

  it('stores usage, connections, history, projects and the suggestion', () => {
    const next = applySnapshot(initialState(), {
      chats: [], suggested: 'codex',
      usage: [{ provider: 'codex', status: 'ok', windows: [], readAt: 'x' }],
      connections: [], history: [{ provider: 'claude', sessionRef: 'h', title: 't', cwd: '/x', updatedAt: 'x' }], projects: [],
    });
    expect(next.suggested).toBe('codex');
    expect(next.usage.codex).toBeDefined();
    expect(next.history).toHaveLength(1);
  });
  it('a delta for a message already in messages extends it instead of splitting it (I1)', () => {
    let s = withChat();
    s = applyEvent(s, { type: 'message.completed', chatId: 'c1', message: message({ text: 'Hel' }) });
    s = applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'm1', text: 'lo' });
    expect(s.messages.c1![0]!.text).toBe('Hello');
    expect(s.streaming.c1?.m1).toBeUndefined();
  });
});

describe('request.closed, notifications, loaded chats', () => {
  it('request.closed removes just that request, so an answer in one tab clears the other', () => {
    let s = withChat({ column: 'needs_you', needsReason: 'permission' });
    s = applyEvent(s, { type: 'request.opened', chatId: 'c1', requestId: 'r1', kind: 'permission', summary: 'a' });
    s = applyEvent(s, { type: 'request.opened', chatId: 'c1', requestId: 'r2', kind: 'question', summary: 'b' });
    s = applyEvent(s, { type: 'request.closed', chatId: 'c1', requestId: 'r1' });
    expect(s.requests.c1!.map((r) => r.requestId)).toEqual(['r2']);
  });

  it('notification ids are unique and monotonic (M7)', () => {
    let s = withChat();
    const at = new Date('2026-10-23T11:00:00.000Z');
    s = applyEvent(s, { type: 'notification', chatId: 'c1', kind: 'finished' }, at);
    s = applyEvent(s, { type: 'notification', chatId: 'c1', kind: 'finished' }, at);
    expect(new Set(s.notifications.map((n) => n.id)).size).toBe(2);
  });

  it('isChatLoaded is true only after a thread was merged, and reset by a full snapshot (M8)', () => {
    let s = withChat();
    expect(isChatLoaded(s, 'c1')).toBe(false);
    s = mergeFetched(s, 'c1', { messages: [message()] }, 0);
    expect(isChatLoaded(s, 'c1')).toBe(true);
    s = applySnapshot(s, { chats: [chat()], usage: [], suggested: null, connections: [], history: [], projects: [] });
    expect(isChatLoaded(s, 'c1')).toBe(false);
  });

  it('endSync forgets touched items once no fetch is in flight', () => {
    const b = beginSync(withChat());
    const s = endSync(applyEvent(b.state, { type: 'chat.updated', chat: chat() }));
    expect(s.sync.touched).toEqual({});
  });
});
