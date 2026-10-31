import type { Chat } from '@agent-kanban/shared';
import { folderKey, projectFolder } from '@agent-kanban/shared';
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
  const [chats, usage, connections, history, projects, connect, settings] = await Promise.all([
    api.listChats(), api.usage(), api.connections(), api.history(), api.projects(), api.connectStates(), api.settings(),
  ]);
  return { chats, usage: usage.readings, suggested: usage.suggested, connections, history, projects, connect, settings };
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

const refetching = new WeakMap<Store, Set<string>>();

/** Fetches the thread of every chat where a delta left a gap (each chat at most once at a time). */
export async function refetchGaps(store: Store, api: Api): Promise<void> {
  const busy = refetching.get(store) ?? new Set<string>();
  refetching.set(store, busy);
  const ids = Object.keys(store.getState().refetch).filter((id) => !busy.has(id) && id in store.getState().chats);
  await Promise.all(ids.map(async (id) => {
    busy.add(id);
    try {
      await loadChat(store, api, id);
    } finally {
      busy.delete(id);
    }
  }));
}

const PROJECTS_DEBOUNCE_MS = 500;
const projectRefresh = new WeakMap<Store, { timer: ReturnType<typeof setTimeout> | null; inFlight: boolean; again: boolean }>();

/** Refetches /api/projects into the store: debounced, and at most one request at a time (a call meanwhile runs once more after it). */
export function refreshProjectsSoon(store: Store, api: Api, delayMs = PROJECTS_DEBOUNCE_MS): void {
  let st = projectRefresh.get(store);
  if (!st) projectRefresh.set(store, (st = { timer: null, inFlight: false, again: false }));
  const state = st;
  if (state.inFlight) { state.again = true; return; }
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.inFlight = true;
    api.projects().then(
      (projects) => store.setState((s) => ({ ...s, projects })),
      () => { /* offline: the next unknown folder or resync asks again */ },
    ).finally(() => {
      state.inFlight = false;
      if (state.again) { state.again = false; refreshProjectsSoon(store, api, delayMs); }
    });
  }, delayMs);
}

/** A chat event names a folder: when the store has no project for it (a new folder), the project list is refetched. */
export function noteChatFolder(store: Store, api: Api, chat: Chat): void {
  const s = store.getState();
  if (!s.loaded || chat.archived) return;
  const k = folderKey(projectFolder(chat.cwd));
  if (s.projects.some((p) => folderKey(p.id) === k || folderKey(p.path) === k)) return;
  refreshProjectsSoon(store, api);
}

/** Per store and list: the number of the latest refresh asked for, so out-of-order answers never apply a stale list. */
const refreshGen = new WeakMap<Store, { history: number; projects: number }>();
function nextGen(store: Store, list: 'history' | 'projects'): number {
  let g = refreshGen.get(store);
  if (!g) refreshGen.set(store, (g = { history: 0, projects: 0 }));
  return ++g[list];
}
const isLatest = (store: Store, list: 'history' | 'projects', gen: number) => refreshGen.get(store)?.[list] === gen;

/** Refetches the project list now (e.g. after "Show its chats" changed which chats count). */
export async function refreshProjects(store: Store, api: Api): Promise<void> {
  const gen = nextGen(store, 'projects');
  const projects = await api.projects();
  // A later refresh was asked for meanwhile: its answer (newer settings) wins, even when this one arrives last.
  if (isLatest(store, 'projects', gen)) store.setState((s) => ({ ...s, projects }));
}

/** Refetches the provider-history list (e.g. after a history-only chat was continued and is now on the board). */
export async function refreshHistory(store: Store, api: Api): Promise<void> {
  const gen = nextGen(store, 'history');
  const history = await api.history();
  if (isLatest(store, 'history', gen)) store.setState((s) => ({ ...s, history }));
}
