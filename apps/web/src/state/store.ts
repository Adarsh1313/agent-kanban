import { createContext, createElement, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { api as realApi } from '../api/client.ts';
import { applySnapshot, missingChats, type AppState, type Snapshot } from './reducer.ts';

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

export async function fetchSnapshot(api: Api): Promise<Snapshot> {
  const [chats, usage, connections, history, projects] = await Promise.all([
    api.listChats(), api.usage(), api.connections(), api.history(), api.projects(),
  ]);
  return { chats, usage: usage.readings, suggested: usage.suggested, connections, history, projects };
}

/** Loads one chat's messages, open requests and tool calls into the store. */
export async function loadChat(store: Store, api: Api, id: string): Promise<void> {
  const [messages, requests, toolCalls] = await Promise.all([api.listMessages(id), api.listRequests(id), api.listToolCalls(id)]);
  store.setState((s) => {
    const done = new Set(messages.map((m) => m.id));
    const partial = s.streaming[id] ?? {};
    const streaming = Object.fromEntries(Object.entries(partial).filter(([mid]) => !done.has(mid)));
    return {
      ...s,
      messages: { ...s.messages, [id]: messages },
      requests: { ...s.requests, [id]: requests },
      toolCalls: { ...s.toolCalls, [id]: toolCalls },
      streaming: { ...s.streaming, [id]: streaming },
    };
  });
}

/**
 * Initial load and resync. Besides the snapshot it fetches tool calls for running chats (the card's
 * current step), open requests for chats waiting on the user, and the open chat's thread.
 */
export async function loadAll(store: Store, api: Api): Promise<Snapshot> {
  const snap = await fetchSnapshot(api);
  store.setState((s) => applySnapshot(s, snap));
  const chats = Object.values(store.getState().chats);
  const open = store.getState().ui.openChatId;
  await Promise.all([
    ...chats.filter((c) => c.column === 'running').map(async (c) => {
      const toolCalls = await api.listToolCalls(c.id);
      store.setState((s) => ({ ...s, toolCalls: { ...s.toolCalls, [c.id]: toolCalls } }));
    }),
    ...chats.filter((c) => c.column === 'needs_you').map(async (c) => {
      const requests = await api.listRequests(c.id);
      store.setState((s) => ({ ...s, requests: { ...s.requests, [c.id]: requests } }));
    }),
    ...(open && open in store.getState().chats ? [loadChat(store, api, open)] : []),
  ]);
  return snap;
}

const attempted = new WeakMap<Store, Set<string>>();

/** Fetches chats that events referred to before the store had them (each id is tried once). */
export async function syncMissing(store: Store, api: Api): Promise<void> {
  const tried = attempted.get(store) ?? new Set<string>();
  attempted.set(store, tried);
  const ids = missingChats(store.getState()).filter((id) => !tried.has(id));
  if (ids.length === 0) return;
  for (const id of ids) tried.add(id);
  const chats = await api.listChats();
  store.setState((s) => applySnapshot(s, { chats, usage: [], suggested: s.suggested, connections: [], history: s.history, projects: s.projects }));
}
