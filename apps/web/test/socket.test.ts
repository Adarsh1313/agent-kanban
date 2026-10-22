import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectSocket } from '../src/api/socket.ts';

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

function setup(chatsStatus = 500) {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: chatsStatus }));
  vi.stubGlobal('fetch', fetchMock);
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  const onReconnected = vi.fn();
  const conn = connectSocket({ token: 'tok', onEvent, onStatus, onReconnected });
  return { conn, onEvent, onStatus, onReconnected, fetchMock };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connectSocket', () => {
  it('connects with the token on the query string and reports live', () => {
    const { onStatus, onReconnected } = setup();
    expect(last().url).toMatch(/^ws:\/\/.+\/ws\?token=tok$/);
    last().open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('forwards parsed server events and ignores malformed frames', () => {
    const { onEvent } = setup();
    last().open();
    last().onmessage?.({ data: JSON.stringify({ type: 'notification', chatId: 'c', kind: 'finished' }) });
    last().onmessage?.({ data: 'not json' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'notification', chatId: 'c', kind: 'finished' });
  });

  it('backs off 1, 2, 4, 8, 16, 30, 30 s and reports reconnecting', async () => {
    const { onStatus } = setup();
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    for (const secs of [1, 2, 4, 8, 16, 30, 30]) {
      const n = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(secs * 1000 - 1);
      expect(FakeSocket.all.length).toBe(n);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all.length).toBe(n + 1);
      last().drop();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('fires onReconnected after a reconnect and resets the backoff', async () => {
    const { onStatus, onReconnected } = setup();
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().drop();
    await vi.advanceTimersByTimeAsync(2000);
    last().open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
    expect(onReconnected).toHaveBeenCalledTimes(1);
    last().drop();
    await vi.advanceTimersByTimeAsync(0);
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all.length).toBe(n + 1);
  });

  it('reports unauthorized on 401 and stops retrying', async () => {
    const { onStatus, fetchMock } = setup(401);
    last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith('unauthorized');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/chats');
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('authorization')).toBe('Bearer tok');
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all.length).toBe(n);
  });

  it('keeps retrying when the probe itself fails (server down)', async () => {
    const { onStatus, fetchMock } = setup();
    fetchMock.mockRejectedValue(new TypeError('network'));
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    expect(FakeSocket.all.length).toBe(2);
  });

  it('close() stops everything', async () => {
    const { conn } = setup();
    last().open();
    const s = last();
    conn.close();
    expect(s.closed).toBe(true);
    s.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBe(1);
  });
});
