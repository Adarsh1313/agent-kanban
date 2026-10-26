import { useEffect, useState } from 'react';
import { api, readToken } from './api/client.ts';
import { connectSocket } from './api/socket.ts';
import { applyEvent } from './state/reducer.ts';
import type { ServerEvent } from '@agent-kanban/shared';
import { loadAll, noteChatFolder, refetchGaps, refreshHistory, refreshProjects, syncMissing, useStoreInstance, type Store } from './state/store.ts';
import { applyConnectEvent } from './ui/connections/ConnectionsPage.tsx';
import { Onboarding } from './ui/onboarding/Onboarding.tsx';
import { Shell } from './ui/shell/Shell.tsx';

/** Applies one live server event to the store and fetches what it makes stale. */
export function handleServerEvent(store: Store, e: ServerEvent): void {
  // "Show its chats" changed in another tab: history and the projects built from it are filtered by it, so refetch
  // them like the tab that made the change does.
  const showChatsChanged = e.type === 'settings.updated'
    && JSON.stringify(store.getState().settings?.showChats ?? null) !== JSON.stringify(e.settings.showChats);
  // A live connect.updated may announce a finished install / sign-in / update / sign-out.
  if (e.type === 'connect.updated') applyConnectEvent(store, e.state);
  else store.setState((s) => applyEvent(s, e));
  if (showChatsChanged) {
    void refreshHistory(store, api).catch(() => { /* the next resync fetches it */ });
    void refreshProjects(store, api).catch(() => { /* the next resync fetches them */ });
  }
  // Only events that name a chat can refer to one the store lacks.
  if ('chatId' in e) void syncMissing(store, api).catch(() => {});
  if (e.type === 'message.delta') void refetchGaps(store, api).catch(() => {});
  // A chat in a folder the project list does not have yet (a new folder): refetch the list.
  if (e.type === 'chat.updated') noteChatFolder(store, api, e.chat);
}

export function App() {
  const store = useStoreInstance();
  const [token] = useState(() => readToken());

  useEffect(() => {
    if (!token) {
      store.setState((s) => ({ ...s, socket: 'no_token' }));
      return;
    }
    const resync = () => {
      void loadAll(store, api).catch(() => {
        // Offline or restarting: the socket status already says so, and the next reconnect loads again.
      });
    };
    const conn = connectSocket({
      token,
      onEvent: (e) => handleServerEvent(store, e),
      // Every open (the first too) loads everything, so events between the fetch and the subscribe cannot be lost.
      onStatus: (socket) => {
        store.setState((s) => ({ ...s, socket }));
        if (socket === 'live') resync();
      },
      onReconnected: () => {},
    });
    return () => conn.close();
  }, [token, store]);

  return (
    <>
      <Shell />
      <Onboarding />
    </>
  );
}
