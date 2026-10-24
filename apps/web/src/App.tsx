import { useEffect, useState } from 'react';
import { api, readToken } from './api/client.ts';
import { connectSocket } from './api/socket.ts';
import { applyEvent } from './state/reducer.ts';
import { loadAll, noteChatFolder, refetchGaps, syncMissing, useStoreInstance } from './state/store.ts';
import { Shell } from './ui/shell/Shell.tsx';

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
      onEvent: (e) => {
        store.setState((s) => applyEvent(s, e));
        // Only events that name a chat can refer to one the store lacks.
        if ('chatId' in e) void syncMissing(store, api).catch(() => {});
        if (e.type === 'message.delta') void refetchGaps(store, api).catch(() => {});
        // A chat in a folder the project list does not have yet (a new folder): refetch the list.
        if (e.type === 'chat.updated') noteChatFolder(store, api, e.chat);
      },
      // Every open (the first too) loads everything, so events between the fetch and the subscribe cannot be lost.
      onStatus: (socket) => {
        store.setState((s) => ({ ...s, socket }));
        if (socket === 'live') resync();
      },
      onReconnected: () => {},
    });
    return () => conn.close();
  }, [token, store]);

  return <Shell />;
}
