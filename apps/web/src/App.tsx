import { useEffect, useState } from 'react';
import { api, readToken } from './api/client.ts';
import { connectSocket } from './api/socket.ts';
import { applyEvent } from './state/reducer.ts';
import { loadAll, refetchGaps, syncMissing, useStoreInstance } from './state/store.ts';
import { Shell } from './ui/shell/Shell.tsx';

export function App() {
  const store = useStoreInstance();
  const [token] = useState(() => readToken());

  useEffect(() => {
    if (!token) {
      store.setState((s) => ({ ...s, socket: 'unauthorized' }));
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
