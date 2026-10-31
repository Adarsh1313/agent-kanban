import type { Chat, DesktopBridge, DesktopStatus } from '@agent-kanban/shared';
import { describe, expect, it, vi } from 'vitest';
import { initialState, type AppState } from '../src/state/reducer.ts';
import { createStore } from '../src/state/store.ts';
import { startDesktopSync, startDesktopWindow } from '../src/desktop.ts';
import { chat } from './helpers.ts';

function fakeBridge() {
  let openChat: ((id: string) => void) | null = null;
  const sent: DesktopStatus[] = [];
  const bridge: DesktopBridge = {
    status: vi.fn((s: DesktopStatus) => { sent.push(s); }),
    show: vi.fn(),
    theme: vi.fn(),
    onOpenChat: (l) => { openChat = l; return () => { openChat = null; }; },
  };
  return { bridge, sent, pickInTray: (id: string) => openChat?.(id) };
}

const withChats = (s: AppState, ...chats: Chat[]): AppState => ({ ...s, chats: Object.fromEntries(chats.map((c) => [c.id, c])) });

describe('desktop sync', () => {
  it('sends the needs-you chats and the running count straight away', () => {
    const store = createStore(withChats(initialState(),
      chat({ id: 'a', column: 'needs_you', title: 'Add a sign-up page' }),
      chat({ id: 'b', column: 'running' }),
      chat({ id: 'c', column: 'running' }),
      chat({ id: 'd', column: 'done' })));
    const { bridge, sent } = fakeBridge();
    startDesktopSync(store, bridge);
    expect(sent).toEqual([{ needsYou: [{ id: 'a', title: 'Add a sign-up page' }], running: 2 }]);
  });

  it('sends again when a chat enters or leaves Needs you, and not on unrelated changes', () => {
    const store = createStore(withChats(initialState(), chat({ id: 'a', column: 'running', title: 'Fix links' })));
    const { bridge, sent } = fakeBridge();
    startDesktopSync(store, bridge);
    store.setState((s) => ({ ...s, chats: { ...s.chats, a: { ...s.chats.a, updatedAt: '2026-10-30T10:00:00.000Z' } } }));
    expect(sent).toHaveLength(1);
    store.setState((s) => ({ ...s, chats: { ...s.chats, a: { ...s.chats.a, column: 'needs_you' } } }));
    expect(sent.at(-1)).toEqual({ needsYou: [{ id: 'a', title: 'Fix links' }], running: 0 });
    store.setState((s) => ({ ...s, chats: { ...s.chats, a: { ...s.chats.a, column: 'review' } } }));
    expect(sent.at(-1)).toEqual({ needsYou: [], running: 0 });
    expect(sent).toHaveLength(3);
  });

  it('leaves archived chats out', () => {
    const store = createStore(withChats(initialState(),
      chat({ id: 'a', column: 'needs_you', archived: true }), chat({ id: 'b', column: 'running', archived: true })));
    const { bridge, sent } = fakeBridge();
    startDesktopSync(store, bridge);
    expect(sent).toEqual([{ needsYou: [], running: 0 }]);
  });

  it('picking a chat in the tray menu opens it in the side panel', () => {
    const store = createStore(withChats(initialState(), chat({ id: 'a', column: 'needs_you' })));
    const { bridge, pickInTray } = fakeBridge();
    startDesktopSync(store, bridge);
    pickInTray('a');
    expect(store.getState().ui.openChatId).toBe('a');
  });

  it('stopping it unsubscribes from the store and the bridge', () => {
    const store = createStore(withChats(initialState(), chat({ id: 'a', column: 'running' })));
    const { bridge, sent, pickInTray } = fakeBridge();
    const stop = startDesktopSync(store, bridge);
    stop();
    store.setState((s) => ({ ...s, chats: { ...s.chats, a: { ...s.chats.a, column: 'needs_you' } } }));
    pickInTray('a');
    expect(sent).toHaveLength(1);
    expect(store.getState().ui.openChatId).not.toBe('a');
  });
});

describe('desktop window', () => {
  it('marks the page as the desktop app, so the top bar becomes the title bar', () => {
    const { bridge } = fakeBridge();
    const stop = startDesktopWindow(bridge);
    expect(document.documentElement.classList.contains('desktop')).toBe(true);
    stop();
    expect(document.documentElement.classList.contains('desktop')).toBe(false);
  });

  it('tells the app the theme now and whenever it is switched', async () => {
    delete document.documentElement.dataset.theme;
    const { bridge } = fakeBridge();
    const stop = startDesktopWindow(bridge);
    expect(bridge.theme).toHaveBeenLastCalledWith('light');
    document.documentElement.dataset.theme = 'dark';
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.theme).toHaveBeenLastCalledWith('dark');
    stop();
    document.documentElement.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.theme).toHaveBeenCalledTimes(2);
    delete document.documentElement.dataset.theme;
  });
});
