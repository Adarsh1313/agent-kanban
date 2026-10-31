import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ServerEvent } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, applySnapshot, initialState, markAllNotificationsRead, markChatNotificationsRead, markNotificationRead, type AppNotification, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Bell } from '../src/ui/notify/Bell.tsx';
import { markAllRead, notificationText, onRing, openNotification, reloadPrefs, resetAudioForTests, RING_GAP_MS, startNotifier } from '../src/ui/notify/notifier.ts';
import { chat } from './helpers.ts';

/* ───────── Browser API fakes ───────── */

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(public title: string, public options: NotificationOptions) {
    FakeNotification.instances.push(this);
  }
}

const tones: number[] = [];
class FakeAudioContext {
  static created = 0;
  static last: FakeAudioContext | null = null;
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => { this.state = 'running'; });
  constructor() {
    FakeAudioContext.created++;
    FakeAudioContext.last = this;
  }
  createOscillator() {
    const o = { type: '', frequency: { value: 0 }, connect: (g: unknown) => g, start: () => tones.push(o.frequency.value), stop: () => {} };
    return o;
  }
  createGain() {
    const g = { gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: (d: unknown) => d };
    return g;
  }
}

/** Delivers to every other open channel of the same name, never to the sender (as browsers do). */
class FakeBroadcastChannel {
  static open: FakeBroadcastChannel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  constructor(public name: string) {
    FakeBroadcastChannel.open.push(this);
  }
  postMessage(data: unknown) {
    this.sent.push(data);
    for (const c of FakeBroadcastChannel.open) if (c !== this && c.name === this.name) c.onmessage?.({ data: structuredClone(data) });
  }
  close() {
    FakeBroadcastChannel.open = FakeBroadcastChannel.open.filter((c) => c !== this);
  }
}

let visibility: DocumentVisibilityState = 'visible';
let reduced = false;

beforeEach(() => {
  localStorage.clear();
  reloadPrefs();
  resetAudioForTests();
  tones.length = 0;
  FakeAudioContext.created = 0;
  FakeNotification.permission = 'default';
  FakeNotification.instances = [];
  FakeNotification.requestPermission.mockClear();
  visibility = 'visible';
  reduced = false;
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  FakeBroadcastChannel.open = [];
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ───────── Helpers ───────── */

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function seeded(extra: Partial<AppState> = {}): Store {
  const s = applySnapshot(initialState(), {
    chats: [chat({ id: 'c1', title: 'Fix the login bug', provider: 'claude' }), chat({ id: 'c2', title: 'Write docs', provider: 'codex' })],
    usage: [], suggested: null, connections: [], history: [], projects: [],
  });
  return createStore({ ...s, now: NOW, ...extra });
}

function start(store: Store) {
  const stop = startNotifier(store);
  stops.push(stop);
  return stop;
}

const mount = (store: Store) => render(<StoreProvider store={store}><Bell /></StoreProvider>);
const bell = () => document.querySelector<HTMLButtonElement>('.bell')!;
const pop = () => document.querySelector<HTMLElement>('.popover.notif-pop')!;
const sw = (name: string) => within(pop()).getByRole('switch', { name });

const send = (store: Store, kind: AppNotification['kind'], chatId = 'c1') =>
  act(() => store.setState((s) => applyEvent(s, { type: 'notification', chatId, kind } as ServerEvent)));

const note = (over: Partial<AppNotification>): AppNotification => ({ id: 'n1', chatId: 'c1', kind: 'permission', at: new Date(NOW).toISOString(), unread: true, ...over });

/* ───────── Reducer ───────── */

describe('read state', () => {
  it('markNotificationRead marks one; markAllNotificationsRead marks every one; both leave state alone when nothing changes', () => {
    const s = { ...initialState(), notifications: [note({ id: 'a' }), note({ id: 'b' }), note({ id: 'c', unread: false })] };
    const one = markNotificationRead(s, 'b');
    expect(one.notifications.map((n) => n.unread)).toEqual([true, false, false]);
    expect(s.notifications[1]!.unread).toBe(true);
    expect(markNotificationRead(one, 'b')).toBe(one);
    expect(markNotificationRead(one, 'missing')).toBe(one);
    const all = markAllNotificationsRead(one);
    expect(all.notifications.every((n) => !n.unread)).toBe(true);
    expect(markAllNotificationsRead(all)).toBe(all);
  });
});

/* ───────── Notifier ───────── */

describe('notifier', () => {
  it('a new notification rings the bell and plays the two-note chime when Sound is on', () => {
    const store = seeded();
    start(store);
    mount(store);
    send(store, 'permission');
    expect(bell().classList.contains('ring')).toBe(true);
    expect(tones).toEqual([880, 1320]);
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(bell().querySelector('.dot')!.textContent).toBe('1');
  });

  it('a finished chat chimes softer (880 then 1100 Hz); Sound off plays nothing', () => {
    const store = seeded();
    start(store);
    send(store, 'finished');
    expect(tones).toEqual([880, 1100]);
    tones.length = 0;
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: false, sound: false }));
    reloadPrefs();
    vi.useFakeTimers({ now: Date.now() + RING_GAP_MS + 1, toFake: ['Date'] });
    send(store, 'question');
    expect(tones).toEqual([]);
  });

  it('shares one AudioContext and resumes it when suspended', () => {
    const store = seeded();
    start(store);
    send(store, 'permission');
    vi.useFakeTimers({ now: Date.now() + RING_GAP_MS + 1, toFake: ['Date'] });
    expect(FakeAudioContext.last!.resume).toHaveBeenCalledTimes(1);
    FakeAudioContext.last!.state = 'suspended';
    send(store, 'question');
    expect(FakeAudioContext.created).toBe(1);
    expect(FakeAudioContext.last!.resume).toHaveBeenCalledTimes(2);
  });

  it('a burst rings once (at most one ring per 600 ms)', () => {
    const store = seeded();
    start(store);
    const rings = vi.fn();
    stops.push(onRing(rings));
    send(store, 'permission');
    send(store, 'question', 'c2');
    send(store, 'finished');
    expect(rings).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ now: Date.now() + RING_GAP_MS + 1, toFake: ['Date'] });
    send(store, 'limit');
    expect(rings).toHaveBeenCalledTimes(2);
  });

  it('notifications already in the store when it starts never fire', () => {
    const store = seeded({ notifications: [note({ id: 'old1' }), note({ id: 'old2', kind: 'finished' })] });
    FakeNotification.permission = 'granted';
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: true, sound: true }));
    reloadPrefs();
    visibility = 'hidden';
    const rings = vi.fn();
    stops.push(onRing(rings));
    start(store);
    // Unrelated state changes (a resync snapshot, the clock) do not replay them either.
    act(() => store.setState((s) => ({ ...s, now: s.now + 1000, notifications: [...s.notifications] })));
    act(() => store.setState((s) => applySnapshot(s, { chats: Object.values(s.chats), usage: [], suggested: null, connections: [], history: [], projects: [] })));
    expect(rings).not.toHaveBeenCalled();
    expect(tones).toEqual([]);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('starting twice for the same store is a no-op (one chime, one ring)', () => {
    const store = seeded();
    start(store);
    start(store);
    const rings = vi.fn();
    stops.push(onRing(rings));
    send(store, 'permission');
    expect(rings).toHaveBeenCalledTimes(1);
    expect(tones).toEqual([880, 1320]);
  });

  it('under prefers-reduced-motion the bell does not ring (the chime still plays)', () => {
    reduced = true;
    const store = seeded();
    start(store);
    mount(store);
    send(store, 'permission');
    expect(bell().classList.contains('ring')).toBe(false);
    expect(tones).toEqual([880, 1320]);
  });

  it('no desktop notification while the tab is visible', () => {
    FakeNotification.permission = 'granted';
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: true, sound: true }));
    reloadPrefs();
    const store = seeded();
    start(store);
    send(store, 'permission');
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('no desktop notification when Desktop is off, even when hidden and granted', () => {
    FakeNotification.permission = 'granted';
    visibility = 'hidden';
    const store = seeded();
    start(store);
    send(store, 'permission');
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('hidden + granted + Desktop on: shows one (title, body, tag); clicking focuses, opens the chat and marks it read', () => {
    FakeNotification.permission = 'granted';
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: true, sound: true }));
    reloadPrefs();
    visibility = 'hidden';
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const store = seeded();
    start(store);
    send(store, 'question');
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0]!;
    expect(n.title).toBe('Fix the login bug');
    expect(n.options).toEqual({ body: 'Claude Code asked you a question', tag: 'c1' });
    act(() => n.onclick!());
    expect(focus).toHaveBeenCalled();
    expect(store.getState().ui.openChatId).toBe('c1');
    expect(store.getState().notifications[0]!.unread).toBe(false);
    expect(n.close).toHaveBeenCalled();
  });

  it('a chat the store has not loaded yet reads "A chat" / "An agent"', () => {
    FakeNotification.permission = 'granted';
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: true, sound: false }));
    reloadPrefs();
    visibility = 'hidden';
    const store = seeded();
    start(store);
    send(store, 'error', 'nope');
    expect(FakeNotification.instances[0]!.title).toBe('A chat');
    expect(FakeNotification.instances[0]!.options.body).toBe('An agent stopped with an error');
  });
});

describe('inside the desktop app', () => {
  // A window hidden to the tray still reports "visible"; what counts there is whether it has focus.
  let focused = true;
  const show = vi.fn();
  beforeEach(() => {
    focused = true;
    show.mockClear();
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    (window as { agentKanbanDesktop?: unknown }).agentKanbanDesktop = { status: () => {}, show, theme: () => {}, onOpenChat: () => () => {} };
    FakeNotification.permission = 'granted';
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: true, sound: false }));
    reloadPrefs();
  });
  afterEach(() => { delete (window as { agentKanbanDesktop?: unknown }).agentKanbanDesktop; vi.restoreAllMocks(); });

  it('shows a notification when the window is not focused, even though it reports visible', () => {
    focused = false;
    const store = seeded();
    start(store);
    send(store, 'permission');
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('shows none while the window is focused', () => {
    const store = seeded();
    start(store);
    send(store, 'permission');
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('clicking it brings the window back (from the tray too) and opens the chat', () => {
    focused = false;
    const store = seeded();
    start(store);
    send(store, 'question');
    act(() => FakeNotification.instances[0]!.onclick!());
    expect(show).toHaveBeenCalled();
    expect(store.getState().ui.openChatId).toBe('c1');
  });
});

/* ───────── Popover ───────── */

describe('permission copy says what it is for', () => {
  it('a reducer notification keeps the action; edit / tool / command (and unknown) read accordingly', () => {
    let s = seeded().getState();
    s = applyEvent(s, { type: 'notification', chatId: 'c1', kind: 'permission', action: 'edit' });
    expect(s.notifications[0]!.action).toBe('edit');
    const text = (action?: 'edit' | 'command' | 'tool') => notificationText(s, note({ ...(action ? { action } : {}) }));
    expect(text('edit')).toBe('Claude Code wants to edit a file');
    expect(text('tool')).toBe('Claude Code wants to use a tool');
    expect(text('command')).toBe('Claude Code wants to run a command');
    expect(text()).toBe('Claude Code wants to run a command');
    expect(notificationText(s, note({ kind: 'finished', action: 'edit' }))).toBe('Claude Code finished. Ready for review');
  });
});

describe('notifications popover', () => {
  it('lists newest first with the design copy, unread styling and relative time', () => {
    const store = seeded({
      notifications: [
        note({ id: 'n3', chatId: 'c2', kind: 'finished', at: new Date(NOW - 6 * 60_000).toISOString() }),
        note({ id: 'n2', chatId: 'c1', kind: 'limit', at: new Date(NOW - 2 * 3_600_000).toISOString(), unread: false }),
        note({ id: 'n1', chatId: 'c1', kind: 'permission', at: new Date(NOW - 30_000).toISOString() }),
      ],
    });
    mount(store);
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread');
    fireEvent.click(bell());
    expect(pop().dataset.state).toBe('open');
    const rows = [...pop().querySelectorAll<HTMLElement>('.notif')];
    expect(rows.map((r) => r.querySelector('small')!.textContent)).toEqual([
      'Codex finished. Ready for review',
      'Claude Code is out of usage',
      'Claude Code wants to run a command',
    ]);
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Write docs', 'Fix the login bug', 'Fix the login bug']);
    expect(rows.map((r) => r.classList.contains('unread'))).toEqual([true, false, true]);
    expect(rows.map((r) => r.querySelector('.when')!.textContent)).toEqual(['Unread, 6m', '2h', 'Unread, now']);
  });

  it('shows the empty state', () => {
    mount(seeded());
    fireEvent.click(bell());
    expect(within(pop()).getByText("You're all caught up.")).toBeTruthy();
    expect(bell().getAttribute('aria-label')).toBe('Notifications');
  });

  it('clicking a row opens the chat, marks it read and closes the popover', () => {
    const store = seeded({ notifications: [note({ id: 'n2', chatId: 'c2' }), note({ id: 'n1', chatId: 'c1' })] });
    mount(store);
    fireEvent.click(bell());
    fireEvent.click(pop().querySelector('[data-id="n1"]')!);
    expect(store.getState().ui.openChatId).toBe('c1');
    expect(store.getState().notifications.map((n) => n.unread)).toEqual([true, false]);
    expect(pop().dataset.state).toBe('closed');
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread');
  });

  it('Mark all read clears the count', () => {
    const store = seeded({ notifications: [note({ id: 'n2' }), note({ id: 'n1' })] });
    mount(store);
    fireEvent.click(bell());
    fireEvent.click(within(pop()).getByRole('button', { name: 'Mark all read' }));
    expect(store.getState().notifications.every((n) => !n.unread)).toBe(true);
    expect(bell().getAttribute('aria-label')).toBe('Notifications');
    expect(bell().querySelector('.dot')!.getAttribute('data-n')).toBe('0');
  });

  it('defaults: Desktop off, Sound on', () => {
    mount(seeded());
    fireEvent.click(bell());
    expect(sw('Desktop notifications').getAttribute('aria-checked')).toBe('false');
    expect(sw('Sound').getAttribute('aria-checked')).toBe('true');
  });

  it('enabling Desktop asks for permission; granted turns it on and persists', async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    mount(seeded());
    fireEvent.click(bell());
    await act(async () => { fireEvent.click(sw('Desktop notifications')); });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(sw('Desktop notifications').getAttribute('aria-checked')).toBe('true');
    expect(JSON.parse(localStorage.getItem('agent-kanban.notify')!)).toEqual({ desktop: true, sound: true });
  });

  it('permission denied keeps the switch off and says why', async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'denied';
      return 'denied';
    });
    mount(seeded());
    fireEvent.click(bell());
    await act(async () => { fireEvent.click(sw('Desktop notifications')); });
    expect(sw('Desktop notifications').getAttribute('aria-checked')).toBe('false');
    expect(within(pop()).getByText('Notifications are blocked in your browser settings.')).toBeTruthy();
    expect(sw('Desktop notifications').getAttribute('aria-describedby')).toBeTruthy();
    expect(localStorage.getItem('agent-kanban.notify')).toBeNull();
  });

  it('without the Notification API the switch is disabled with "Not supported in this browser."', () => {
    vi.stubGlobal('Notification', undefined);
    mount(seeded());
    fireEvent.click(bell());
    expect((sw('Desktop notifications') as HTMLButtonElement).disabled).toBe(true);
    expect(within(pop()).getByText('Not supported in this browser.')).toBeTruthy();
  });

  it('Sound persists; turning it on plays the soft preview; both off shows bell-off', () => {
    mount(seeded());
    fireEvent.click(bell());
    fireEvent.click(sw('Sound'));
    expect(JSON.parse(localStorage.getItem('agent-kanban.notify')!)).toEqual({ desktop: false, sound: false });
    expect(sw('Sound').getAttribute('aria-checked')).toBe('false');
    expect(tones).toEqual([]);
    fireEvent.click(sw('Sound'));
    expect(tones).toEqual([880, 1100]);
    expect(JSON.parse(localStorage.getItem('agent-kanban.notify')!)).toEqual({ desktop: false, sound: true });
    // A fresh page reads the saved choice.
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: false, sound: false }));
    act(() => reloadPrefs());
    expect(sw('Sound').getAttribute('aria-checked')).toBe('false');
    expect(bell().querySelector('svg')!.innerHTML).toContain('M4 4l16 16');
  });

  it('broken storage falls back to the defaults', () => {
    localStorage.setItem('agent-kanban.notify', '{not json');
    reloadPrefs();
    mount(seeded());
    fireEvent.click(bell());
    expect(sw('Sound').getAttribute('aria-checked')).toBe('true');
    expect(sw('Desktop notifications').getAttribute('aria-checked')).toBe('false');
  });
});

it('the screen reader name keeps the existing format', () => {
  mount(seeded({ notifications: [note({})] }));
  expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBe(bell());
});

/* ───────── Fix round 1 ───────── */

describe('relayed reads (matched by chat and time, since each tab numbers its own)', () => {
  it('markChatNotificationsRead / markAllNotificationsRead(until) only touch what arrived by then', () => {
    const s = { ...initialState(), notifications: [
      note({ id: 'a', chatId: 'c1', at: new Date(NOW + 10_000).toISOString() }),
      note({ id: 'b', chatId: 'c2', at: new Date(NOW).toISOString() }),
      note({ id: 'c', chatId: 'c1', at: new Date(NOW).toISOString() }),
    ] };
    expect(markChatNotificationsRead(s, 'c1', NOW + 1).notifications.map((n) => n.unread)).toEqual([true, true, false]);
    expect(markChatNotificationsRead(s, 'zz', NOW + 1)).toBe(s);
    expect(markAllNotificationsRead(s, NOW + 1).notifications.map((n) => n.unread)).toEqual([true, false, false]);
  });
});

describe('two tabs', () => {
  const otherTab = () => new FakeBroadcastChannel('agent-kanban.notify');

  it('reading a row relays chat id + time only (no id, no content); Mark all read relays too', () => {
    const store = seeded({ notifications: [note({ id: 'n2', chatId: 'c2' }), note({ id: 'n1', chatId: 'c1' })] });
    start(store);
    const got: unknown[] = [];
    otherTab().onmessage = (e) => got.push(e.data);
    mount(store);
    fireEvent.click(bell());
    fireEvent.click(pop().querySelector('[data-id="n1"]')!);
    expect(got).toEqual([{ type: 'read', chatId: 'c1', until: NOW + 2000 }]);
    fireEvent.click(bell());
    fireEvent.click(within(pop()).getByRole('button', { name: 'Mark all read' }));
    expect(got[1]).toMatchObject({ type: 'all' });
    expect(Object.keys(got[1] as object).sort()).toEqual(['type', 'until']);
  });

  it('a read from another tab applies here and is never posted on again', () => {
    const store = seeded({ notifications: [note({ id: 'x2', chatId: 'c2' }), note({ id: 'x1', chatId: 'c1', at: new Date(NOW + 500).toISOString() })] });
    start(store);
    const mine = FakeBroadcastChannel.open[0]!;
    const other = otherTab();
    act(() => other.postMessage({ type: 'read', chatId: 'c1', until: NOW + 2000 }));
    expect(store.getState().notifications.map((n) => n.unread)).toEqual([true, false]);
    act(() => other.postMessage({ type: 'read', chatId: 42, until: 1 }));
    act(() => other.postMessage('junk'));
    expect(store.getState().notifications.map((n) => n.unread)).toEqual([true, false]);
    act(() => other.postMessage({ type: 'all', until: NOW + 2000 }));
    expect(store.getState().notifications.every((n) => !n.unread)).toBe(true);
    expect(mine.sent).toEqual([]);
  });

  it('Mark all read relays a finite cut-off even when a notification time is unreadable', () => {
    const store = seeded({ notifications: [note({ id: 'n1', at: 'not a date' }), note({ id: 'n2', chatId: 'c2' })] });
    start(store);
    const got: Array<{ until: number }> = [];
    otherTab().onmessage = (e) => got.push(e.data as { until: number });
    act(() => markAllRead(store));
    expect(got).toHaveLength(1);
    expect(Number.isFinite(got[0]!.until)).toBe(true);
  });

  it('opening one notification also relays a finite cut-off when its time is unreadable (#19)', () => {
    const n = note({ id: 'n1', at: 'not a date' });
    const store = seeded({ notifications: [n] });
    start(store);
    const got: Array<{ until: number }> = [];
    otherTab().onmessage = (e) => got.push(e.data as { until: number });
    act(() => openNotification(store, n));
    expect(got).toHaveLength(1);
    expect(Number.isFinite(got[0]!.until)).toBe(true);
  });

  it('works without BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const store = seeded({ notifications: [note({ id: 'n1' })] });
    start(store);
    act(() => markAllRead(store));
    expect(store.getState().notifications[0]!.unread).toBe(false);
  });

  it('stopping the notifier closes its channel', () => {
    const stop = start(seeded());
    expect(FakeBroadcastChannel.open).toHaveLength(1);
    stop();
    expect(FakeBroadcastChannel.open).toHaveLength(0);
  });
});

describe('desktop notifications close once read in the app', () => {
  it('reading one closes its notification; Mark all read closes the rest; a read from another tab closes too', () => {
    FakeNotification.permission = 'granted';
    localStorage.setItem('agent-kanban.notify', JSON.stringify({ desktop: true, sound: false }));
    reloadPrefs();
    visibility = 'hidden';
    const store = seeded();
    start(store);
    send(store, 'permission', 'c1');
    send(store, 'question', 'c2');
    const [first, second] = FakeNotification.instances;
    const n1 = store.getState().notifications[1]!;
    act(() => openNotification(store, n1));
    expect(first!.close).toHaveBeenCalled();
    expect(second!.close).not.toHaveBeenCalled();
    act(() => markAllRead(store));
    expect(second!.close).toHaveBeenCalled();

    send(store, 'finished', 'c1');
    const third = FakeNotification.instances[2]!;
    act(() => new FakeBroadcastChannel('agent-kanban.notify').postMessage({ type: 'read', chatId: 'c1', until: Date.now() + 2000 }));
    expect(third.close).toHaveBeenCalled();
  });
});

describe('popover polish', () => {
  it('the rows have list semantics; the empty state does not', () => {
    mount(seeded({ notifications: [note({ id: 'n2' }), note({ id: 'n1' })] }));
    fireEvent.click(bell());
    expect(within(within(pop()).getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    cleanup();
    mount(seeded());
    fireEvent.click(bell());
    expect(within(pop()).queryByRole('list')).toBeNull();
  });

  it('aria-expanded follows the popover', () => {
    mount(seeded());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(bell());
    expect(bell().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(bell());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
  });

  it('re-reads the permission each time it opens', () => {
    FakeNotification.permission = 'denied';
    mount(seeded());
    fireEvent.click(bell());
    expect(within(pop()).getByText('Notifications are blocked in your browser settings.')).toBeTruthy();
    fireEvent.click(bell());
    FakeNotification.permission = 'default';
    fireEvent.click(bell());
    expect(within(pop()).queryByText('Notifications are blocked in your browser settings.')).toBeNull();
  });

  it('the new row slides in once: enter is cleared on animationend and on close', () => {
    const store = seeded();
    start(store);
    mount(store);
    send(store, 'permission');
    fireEvent.click(bell());
    const row = () => pop().querySelector<HTMLElement>('.notif')!;
    expect(row().classList.contains('enter')).toBe(true);
    // jsdom has no AnimationEvent, so React listens for the prefixed name there; send both.
    for (const type of ['animationend', 'webkitAnimationEnd']) act(() => { row().dispatchEvent(new Event(type, { bubbles: true })); });
    expect(row().classList.contains('enter')).toBe(false);
    fireEvent.click(bell());
    vi.useFakeTimers({ now: Date.now() + RING_GAP_MS + 1, toFake: ['Date'] });
    send(store, 'question');
    fireEvent.click(bell());
    expect(row().classList.contains('enter')).toBe(true);
    fireEvent.click(bell());
    expect(row().classList.contains('enter')).toBe(false);
  });
});
