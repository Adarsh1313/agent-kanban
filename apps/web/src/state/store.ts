import { createContext, createElement, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { api as realApi } from '../api/client.ts';
import { applySnapshot, beginSync, endSync, mergeChats, mergeFetched, missingChats, type AppState, type FetchedThread, type Snapshot } from './reducer.ts';

type Api = typeof realApi;

export interface Store {
  getState(): AppState;
  setState(fn: (s: AppState) => AppState): void;
  subscribe(fn: () => void): () => void;
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(fn) {
      const next = fn(state);
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ store, children }: { store: Store; children: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useStoreInstance(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore needs a <StoreProvider>.');
  return store;
}

/** Structural equality, a few levels deep, so selectors may build fresh arrays/objects without re-rendering. */
function same(a: unknown, b: unknown, depth = 4): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1));
}

export function useStore<T>(selector: (s: AppState) => T): T {
  const store = useStoreInstance();
  const last = useRef<{ value: T } | null>(null);
  const getSnapshot = () => {
    const next = selector(store.getState());
    if (last.current && same(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Runs a fetch while events are being remembered, so its result can be merged with them (see mergeFetched). */
async function tracked<T>(store: Store, run: (since: number) => Promise<T>): Promise<T> {
  let since = 0;
  store.setState((s) => {
    const b = beginSync(s);
    since = b.since;
    return b.state;
  });
  try {
    return await run(since);
  } finally {
    store.setState(endSync);
  }
}

export async function fetchSnapshot(api: Api): Promise<Snapshot> {
  const [chats, usage, connections, history, projects] = await Promise.all([
    api.listChats(), api.usage(), api.connections(), api.history(), api.projects(),
  ]);
  return { chats, usage: usage.readings, suggested: usage.suggested, connections, history, projects };
}

const apply = (store: Store, chatId: string, part: FetchedThread, since: number) =>
  store.setState((s) => mergeFetched(s, chatId, part, since));

/** Loads one chat's messages, open requests and tool calls into the store. */
export async function loadChat(store: Store, api: Api, id: string): Promise<void> {
  await tracked(store, async (since) => {
    const [messages, requests, toolCalls] = await Promise.all([api.listMessages(id), api.listRequests(id), api.listToolCalls(id)]);
    apply(store, id, { messages, requests, toolCalls }, since);
  });
}

/**
 * Initial load and resync. Besides the snapshot it fetches tool calls for running chats (the card's
 * current step), open requests for chats waiting on the user, and the open chat's thread.
 */
export async function loadAll(store: Store, api: Api): Promise<Snapshot> {
  const snap = await tracked(store, async (since) => {
    const fetched = await fetchSnapshot(api);
    store.setState((s) => applySnapshot(s, fetched, since));
    return fetched;
  });
  const chats = Object.values(store.getState().chats);
  const open = store.getState().ui.openChatId;
  await Promise.all([
    ...chats.filter((c) => c.column === 'running').map((c) =>
      tracked(store, async (since) => apply(store, c.id, { toolCalls: await api.listToolCalls(c.id) }, since))),
    ...chats.filter((c) => c.column === 'needs_you').map((c) =>
      tracked(store, async (since) => apply(store, c.id, { requests: await api.listRequests(c.id) }, since))),
    ...(open && open in store.getState().chats ? [loadChat(store, api, open)] : []),
  ]);
  return snap;
}

const attempted = new WeakMap<Store, Set<string>>();

/** Fetches chats that events referred to before the store had them (each id is tried until a fetch succeeds). */
export async function syncMissing(store: Store, api: Api): Promise<void> {
  const tried = attempted.get(store) ?? new Set<string>();
  attempted.set(store, tried);
  const ids = missingChats(store.getState()).filter((id) => !tried.has(id));
  if (ids.length === 0) return;
  for (const id of ids) tried.add(id);
  try {
    const chats = await api.listChats();
    store.setState((s) => mergeChats(s, chats));
  } catch (err) {
    for (const id of ids) tried.delete(id);
    throw err;
  }
}
