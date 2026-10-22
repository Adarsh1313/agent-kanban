import { describe, expect, it, vi } from 'vitest';
import type { OpenRequest } from '@agent-kanban/shared';
import { applyEvent, initialState, isChatLoaded, type AppState } from '../src/state/reducer.ts';
import { createStore, loadAll, loadChat, syncMissing } from '../src/state/store.ts';
import type { api as realApi } from '../src/api/client.ts';
import { chat, message } from './helpers.ts';

type Api = typeof realApi;
function fakeApi(over: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    listChats: async () => [], history: async () => [], projects: async () => [], connections: async () => [],
    usage: async () => ({ readings: [], suggested: null }), listMessages: async () => [], listRequests: async () => [], listToolCalls: async () => [],
    ...over,
  } as unknown as Api;
}
const req = (requestId: string): OpenRequest => ({ requestId, kind: 'permission', summary: requestId, createdAt: 'x' });
const storeWith = (patch: Partial<AppState>) => createStore({ ...initialState(), ...patch });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('store', () => {
  it('notifies subscribers and supports unsubscribe', () => {
    const store = createStore(initialState());
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.setState((s) => ({ ...s, socket: 'live' }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.setState((s) => ({ ...s, socket: 'reconnecting' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('loadAll applies the snapshot and fetches tool calls for running chats only', async () => {
    const toolCalls = vi.fn(async (id: string) => [{ id: `t-${id}`, chatId: id, name: 'Bash', summary: 'ls', status: 'running' as const, createdAt: 'x' }]);
    const store = createStore(initialState());
    await loadAll(store, fakeApi({
      listChats: async () => [chat({ id: 'r', column: 'running' }), chat({ id: 'd', column: 'done' })],
      listToolCalls: toolCalls,
    }));
    expect(toolCalls).toHaveBeenCalledTimes(1);
    expect(store.getState().toolCalls.r).toHaveLength(1);
    expect(store.getState().chats.d).toBeDefined();
    expect(store.getState().sync.inflight).toBe(0);
  });

  it('loadAll drops a chat the server no longer lists (I3)', async () => {
    const store = storeWith({ chats: { old: chat({ id: 'old' }) } });
    await loadAll(store, fakeApi({ listChats: async () => [chat({ id: 'new' })] }));
    expect(Object.keys(store.getState().chats)).toEqual(['new']);
  });

  it('loadChat fills the thread, marks it loaded and drops streaming text now stored', async () => {
    const store = storeWith({ chats: { c1: chat({ column: 'needs_you', needsReason: 'permission' }) }, streaming: { c1: { m1: 'part' } } });
    await loadChat(store, fakeApi({
      listMessages: async () => [message({ id: 'm1', text: 'part' })],
      listRequests: async () => [req('r1')],
    }), 'c1');
    const s = store.getState();
    expect(s.messages.c1).toHaveLength(1);
    expect(s.requests.c1).toHaveLength(1);
    expect(s.streaming.c1?.m1).toBeUndefined();
    expect(isChatLoaded(s, 'c1')).toBe(true);
  });

  it('an in-progress message from listMessages keeps growing with deltas, without a split or duplicate (I1)', async () => {
    const store = storeWith({ chats: { c1: chat() } });
    await loadChat(store, fakeApi({ listMessages: async () => [message({ id: 'm1', text: 'Hel' })] }), 'c1');
    store.setState((s) => applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'm1', text: 'lo' }));
    let s = store.getState();
    expect(s.messages.c1!.map((m) => m.text)).toEqual(['Hello']);
    expect(s.streaming.c1?.m1).toBeUndefined();
    store.setState((st) => applyEvent(st, { type: 'message.completed', chatId: 'c1', message: message({ id: 'm1', text: 'Hello world' }) }));
    s = store.getState();
    expect(s.messages.c1).toHaveLength(1);
    expect(s.messages.c1![0]!.text).toBe('Hello world');
  });

  it('a delta that arrives while the thread is being fetched is not lost or doubled (I1/I2)', async () => {
    const store = storeWith({ chats: { c1: chat() } });
    const gate = deferred<ReturnType<typeof message>[]>();
    const pending = loadChat(store, fakeApi({ listMessages: () => gate.promise }), 'c1');
    store.setState((s) => applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'm1', text: 'lo' }));
    gate.resolve([message({ id: 'm1', text: 'Hel' })]);
    await pending;
    expect(store.getState().messages.c1!.map((m) => m.text)).toEqual(['Hello']);
    expect(store.getState().streaming.c1?.m1).toBeUndefined();

    // the fetch already included the delta
    const store2 = storeWith({ chats: { c1: chat() } });
    const gate2 = deferred<ReturnType<typeof message>[]>();
    const pending2 = loadChat(store2, fakeApi({ listMessages: () => gate2.promise }), 'c1');
    store2.setState((s) => applyEvent(s, { type: 'message.delta', chatId: 'c1', messageId: 'm1', text: 'lo' }));
    gate2.resolve([message({ id: 'm1', text: 'Hello' })]);
    await pending2;
    expect(store2.getState().messages.c1!.map((m) => m.text)).toEqual(['Hello']);
  });

  it('a message completed during the fetch survives a fetch that lacks it (I2)', async () => {
    const store = storeWith({ chats: { c1: chat() } });
    const gate = deferred<ReturnType<typeof message>[]>();
    const pending = loadChat(store, fakeApi({ listMessages: () => gate.promise }), 'c1');
    store.setState((s) => applyEvent(s, { type: 'message.completed', chatId: 'c1', message: message({ id: 'm2', text: 'new', createdAt: '2026-10-23T10:05:00.000Z' }) }));
    gate.resolve([message({ id: 'm1', text: 'old' })]);
    await pending;
    expect(store.getState().messages.c1!.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('a tool call updated during the fetch keeps the event copy (I2)', async () => {
    const tc = { id: 't1', chatId: 'c1', name: 'Bash', summary: 'ls', status: 'running' as const, createdAt: 'x' };
    const store = storeWith({ chats: { c1: chat() } });
    const gate = deferred<(typeof tc)[]>();
    const pending = loadChat(store, fakeApi({ listToolCalls: () => gate.promise }), 'c1');
    store.setState((s) => applyEvent(s, { type: 'tool.call', chatId: 'c1', toolCall: { ...tc, status: 'done' } }));
    gate.resolve([tc]);
    await pending;
    expect(store.getState().toolCalls.c1).toEqual([{ ...tc, status: 'done' }]);
  });

  it('a request closed during the fetch is not resurrected, one opened meanwhile is kept (I2)', async () => {
    const store = storeWith({ chats: { c1: chat({ column: 'needs_you', needsReason: 'permission' }) }, requests: { c1: [req('r1'), req('r2')] } });
    const gate = deferred<OpenRequest[]>();
    const pending = loadChat(store, fakeApi({ listRequests: () => gate.promise }), 'c1');
    store.setState((s) => applyEvent(s, { type: 'request.closed', chatId: 'c1', requestId: 'r1' }));
    store.setState((s) => applyEvent(s, { type: 'request.opened', chatId: 'c1', requestId: 'r3', kind: 'question', summary: 'q' }));
    gate.resolve([req('r1'), req('r2')]);
    await pending;
    expect(store.getState().requests.c1!.map((r) => r.requestId)).toEqual(['r2', 'r3']);
  });

  it('fetched requests are not written once the chat left needs_you (I2)', async () => {
    const store = storeWith({ chats: { c1: chat({ column: 'needs_you', needsReason: 'permission' }) }, requests: { c1: [req('r1')] } });
    const gate = deferred<OpenRequest[]>();
    const pending = loadChat(store, fakeApi({ listRequests: () => gate.promise }), 'c1');
    store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: chat({ column: 'running' }) }));
    gate.resolve([req('r1')]);
    await pending;
    expect(store.getState().requests.c1).toEqual([]);
  });

  it('events during the initial snapshot fetch are not overwritten by it (I2/I3)', async () => {
    const store = createStore(initialState());
    const gate = deferred<ReturnType<typeof chat>[]>();
    const pending = loadAll(store, fakeApi({ listChats: () => gate.promise }));
    store.setState((s) => applyEvent(s, { type: 'chat.updated', chat: chat({ id: 'fresh', updatedAt: '2026-10-23T12:00:00.000Z' }) }));
    gate.resolve([]);
    await pending;
    expect(store.getState().chats.fresh).toBeDefined();
  });

  it('syncMissing fetches chats referenced by events once', async () => {
    const store = storeWith({ streaming: { ghost: { m: 'x' } } });
    const listChats = vi.fn(async () => [chat({ id: 'ghost' })]);
    await syncMissing(store, fakeApi({ listChats }));
    expect(store.getState().chats.ghost).toBeDefined();
    await syncMissing(store, fakeApi({ listChats }));
    expect(listChats).toHaveBeenCalledTimes(1);
  });

  it('syncMissing retries after a failed fetch (M4) and keeps other chats (no drops)', async () => {
    const store = storeWith({ chats: { other: chat({ id: 'other' }) }, streaming: { ghost: { m: 'x' } } });
    const listChats = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([chat({ id: 'ghost' })]);
    await expect(syncMissing(store, fakeApi({ listChats }))).rejects.toThrow('offline');
    await syncMissing(store, fakeApi({ listChats }));
    await tick();
    expect(listChats).toHaveBeenCalledTimes(2);
    expect(Object.keys(store.getState().chats).sort()).toEqual(['ghost', 'other']);
  });
});
