import { useEffect, useState } from 'react';
import { api, readToken } from './api/client.ts';
import { connectSocket } from './api/socket.ts';
import { applyEvent, type AppState } from './state/reducer.ts';
import { boardColumns } from './state/selectors.ts';
import { loadAll, refetchGaps, syncMissing, useStore, useStoreInstance } from './state/store.ts';

const UNAUTHORIZED_TEXT = 'The server restarted. Open Agent Kanban again from the link it printed.';
const COLUMN_LABELS = [
  ['running', 'Running'],
  ['needs_you', 'Needs you'],
  ['review', 'Review'],
  ['done', 'Done'],
] as const;

const statusText = (socket: AppState['socket']) =>
  socket === 'live' ? 'Live' : socket === 'reconnecting' ? 'Reconnecting…' : UNAUTHORIZED_TEXT;

export function App() {
  const store = useStoreInstance();
  const [token] = useState(() => readToken());
  const socket = useStore((s) => s.socket);
  const counts = useStore((s) => {
    const cols = boardColumns(s);
    return { running: cols.running.length, needs_you: cols.needs_you.length, review: cols.review.length, done: cols.done.length };
  });

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

  return (
    <main className="shell">
      <h1 className="shell-title">Agent Kanban</h1>
      <p className="shell-status" role="status">{statusText(socket)}</p>
      <ul className="shell-counts">
        {COLUMN_LABELS.map(([key, label]) => (
          <li key={key}>{label}: {counts[key]}</li>
        ))}
      </ul>
    </main>
  );
}
