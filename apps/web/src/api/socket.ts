import type { ServerEvent } from '@agent-kanban/shared';

export type SocketStatus = 'live' | 'reconnecting' | 'unauthorized';

const PROBE_MS = 5000;

/** A timeout signal for the 401 probe, where the browser has AbortSignal.timeout (else no timeout). */
function probeSignal(): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(PROBE_MS) : undefined;
  } catch {
    return undefined;
  }
}

export interface SocketOptions {
  token: string;
  onEvent: (e: ServerEvent) => void;
  onStatus: (s: SocketStatus) => void;
  onReconnected: () => void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export function connectSocket(opts: SocketOptions): { close(): void } {
  let closed = false;
  let attempt = 0;
  let hasOpened = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(opts.token)}`);
    socket = ws;
    ws.onopen = () => {
      if (closed) return;
      attempt = 0;
      opts.onStatus('live');
      if (hasOpened) opts.onReconnected();
      hasOpened = true;
    };
    ws.onmessage = (m) => {
      if (closed) return;
      try {
        opts.onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      void afterDrop();
    };
  };

  const afterDrop = async () => {
    let unauthorized = false;
    try {
      // A hung server must not stall reconnecting: give the probe 5 s, then retry as if unreachable.
      const res = await fetch('/api/chats', { headers: { authorization: `Bearer ${opts.token}` }, signal: probeSignal() });
      unauthorized = res.status === 401;
    } catch {
      // server unreachable: just retry
    }
    if (closed) return;
    if (unauthorized) {
      opts.onStatus('unauthorized');
      return;
    }
    opts.onStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) open();
    }, delay);
  };

  open();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      socket?.close();
    },
  };
}
