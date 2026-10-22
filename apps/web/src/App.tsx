import { useEffect, useState } from 'react';
import { readToken } from './api/client.ts';
import { connectSocket, type SocketStatus } from './api/socket.ts';

const UNAUTHORIZED_TEXT = 'The server restarted. Open Agent Kanban again from the link it printed.';

export function App() {
  const [token] = useState(() => readToken());
  const [status, setStatus] = useState<SocketStatus>(token ? 'reconnecting' : 'unauthorized');

  useEffect(() => {
    if (!token) return;
    const conn = connectSocket({ token, onEvent: () => {}, onStatus: setStatus, onReconnected: () => {} });
    return () => conn.close();
  }, [token]);

  return (
    <main className="shell">
      <h1 className="shell-title">Agent Kanban</h1>
      <p className="shell-status" role="status">
        {status === 'live' ? 'Live' : status === 'reconnecting' ? 'Reconnecting…' : UNAUTHORIZED_TEXT}
      </p>
    </main>
  );
}
