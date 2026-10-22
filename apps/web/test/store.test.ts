import { describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/state/reducer.ts';
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
  });

  it('loadChat fills messages, requests and tool calls, and drops streaming text now completed', async () => {
    const store = createStore({ ...initialState(), streaming: { c1: { m1: 'part' } } });
    await loadChat(store, fakeApi({
      listMessages: async () => [message({ id: 'm1' })],
      listRequests: async () => [{ requestId: 'r1', kind: 'permission', summary: 's', createdAt: 'x' }],
    }), 'c1');
    const s = store.getState();
    expect(s.messages.c1).toHaveLength(1);
    expect(s.requests.c1).toHaveLength(1);
    expect(s.streaming.c1?.m1).toBeUndefined();
  });

  it('syncMissing fetches chats referenced by events once', async () => {
    const store = createStore({ ...initialState(), streaming: { ghost: { m: 'x' } } });
    const listChats = vi.fn(async () => [chat({ id: 'ghost' })]);
    await syncMissing(store, fakeApi({ listChats }));
    expect(store.getState().chats.ghost).toBeDefined();
    await syncMissing(store, fakeApi({ listChats }));
    expect(listChats).toHaveBeenCalledTimes(1);
  });
});
