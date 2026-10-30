import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HistoryChat } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recentChatsByProject } from '../src/state/selectors.ts';
import { applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Shell } from '../src/ui/shell/Shell.tsx';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';
import { setNewChatHandler } from '../src/ui/actions.ts';
import { chat } from './helpers.ts';

vi.mock('../src/state/selectors.ts', async (orig) => {
  const m = await orig<typeof import('../src/state/selectors.ts')>();
  return { ...m, recentChatsByProject: vi.fn(m.recentChatsByProject) };
});

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function seeded(chats = [chat()], history: HistoryChat[] = [], extra: Partial<AppState> = {}): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history, projects: [] });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store, ui = <Sidebar />) => render(<StoreProvider store={store}>{ui}</StoreProvider>);

beforeEach(() => { location.hash = ''; });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

const hist = (n: number): HistoryChat[] =>
  Array.from({ length: n }, (_, i) => ({
    provider: (['claude', 'codex', 'antigravity'] as const)[i % 3]!,
    sessionRef: `s${i}`,
    title: `History chat ${i}`,
    cwd: `/work/p${i % 40}`,
    updatedAt: new Date(NOW - i * 60_000).toISOString(),
  }));

describe('Sidebar: providers', () => {
  it('rows set the provider filter to that one provider, one at a time, and a second click clears it', () => {
    const store = seeded([chat({ id: 'a', provider: 'claude' }), chat({ id: 'b', provider: 'codex', sessionRef: 's2' })]);
    mount(store);
    const claude = screen.getByRole('button', { name: /Claude Code/ });
    const codex = screen.getByRole('button', { name: /Codex/ });
    fireEvent.click(claude);
    expect(store.getState().ui.filters.provider).toEqual(['claude']);
    expect(claude.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(codex);
    expect(store.getState().ui.filters.provider).toEqual(['codex']);
    expect(claude.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(codex);
    expect(store.getState().ui.filters.provider).toBeNull();
  });

  it('a row replaces a multi-provider filter', () => {
    const base = seeded([chat({ id: 'a', provider: 'claude' })]);
    const store = createStore({ ...base.getState(), ui: { ...base.getState().ui, filters: { ...base.getState().ui.filters, provider: ['claude', 'codex'] } } });
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: /Antigravity/ }));
    expect(store.getState().ui.filters.provider).toEqual(['antigravity']);
  });

  it('shows the number of chats each provider has', () => {
    const store = seeded([chat({ id: 'a', provider: 'claude' }), chat({ id: 'b', provider: 'claude', sessionRef: 's2' })], [
      { provider: 'claude', sessionRef: 'h1', title: 'Old', cwd: '/x', updatedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    mount(store);
    expect(within(screen.getByRole('button', { name: /Claude Code/ })).getByText('3')).toBeTruthy();
  });
});

describe('Sidebar: pinned and recent', () => {
  it('hides Pinned when nothing is pinned and shows it otherwise', () => {
    const { unmount } = mount(seeded([chat()]));
    expect(screen.queryByText('Pinned')).toBeNull();
    unmount();
    mount(seeded([chat({ id: 'p', title: 'Keep me', pinned: true })]));
    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(screen.getByText('Keep me')).toBeTruthy();
  });

  it('shows the 4 most recent projects with 3 chats each, "N more" and "All projects"', () => {
    const chats = Array.from({ length: 6 }, (_, p) => Array.from({ length: 5 }, (_, i) =>
      chat({ id: `c${p}-${i}`, sessionRef: `r${p}-${i}`, cwd: `/work/proj${p}`, title: `Chat ${p}-${i}`, updatedAt: new Date(NOW - (p * 100 + i) * 60_000).toISOString() }))).flat();
    mount(seeded(chats));
    expect(document.querySelectorAll('.proj').length).toBe(4);
    expect(document.querySelectorAll('.proj .chat-row').length).toBe(12);
    expect(screen.getAllByRole('button', { name: '2 more' }).length).toBe(4);
    expect(screen.getByRole('button', { name: /All projects/ })).toBeTruthy();
    expect(screen.queryByText('proj4')).toBeNull();
  });

  it('hovering a chat (board or history-only) shows its title, provider and when it was last active (#23)', () => {
    const at = (iso: string) => new Date(iso).toISOString();
    const board = chat({ id: 'b1', provider: 'claude', title: 'Board chat', cwd: '/work/a', updatedAt: at('2026-10-23T09:05:00') });
    const old: HistoryChat = { provider: 'codex', sessionRef: 'h1', title: 'Old codex chat', cwd: '/work/a', updatedAt: at('2026-10-20T15:30:00') };
    mount(seeded([board], [old]));
    const row = (name: string) => [...document.querySelectorAll('.chat-row')].find((r) => r.textContent?.includes(name))!;
    expect(row('Board chat').getAttribute('title')).toBe('Board chat\nClaude Code · Today, 9:05 am');
    expect(row('Board chat').getAttribute('aria-description')).toBe('Claude Code · Today, 9:05 am');
    expect(row('Old codex chat').getAttribute('title')).toBe('Old codex chat\nCodex · Oct 20, 3:30 pm');
  });

  it('"N more" expands inside that project and "Show less" collapses it', () => {
    const chats = Array.from({ length: 5 }, (_, i) => chat({ id: `c${i}`, sessionRef: `r${i}`, title: `Chat ${i}`, updatedAt: new Date(NOW - i * 60_000).toISOString() }));
    mount(seeded(chats));
    expect(document.querySelectorAll('.proj .chat-row').length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(document.querySelectorAll('.proj .chat-row').length).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(document.querySelectorAll('.proj .chat-row').length).toBe(3);
  });

  it('All projects goes to the Projects page', () => {
    const chats = Array.from({ length: 5 }, (_, p) => chat({ id: `c${p}`, sessionRef: `r${p}`, cwd: `/work/proj${p}`, updatedAt: new Date(NOW - p * 60_000).toISOString() }));
    mount(seeded(chats));
    fireEvent.click(screen.getByRole('button', { name: /All projects/ }));
    expect(location.hash).toBe('#/projects');
  });

  it('a project label opens that project; a chat row opens the chat', () => {
    const store = seeded([chat({ id: 'c9', cwd: '/work/alpha', title: 'Fix login' })]);
    mount(store);
    fireEvent.click(screen.getByText('Fix login'));
    expect(store.getState().ui.openChatId).toBe('c9');
    fireEvent.click(screen.getByText('alpha'));
    expect(location.hash).toBe(`#/projects/${encodeURIComponent('/work/alpha')}`);
  });

  it('respects the provider focus', () => {
    const store = seeded([chat({ id: 'a', title: 'Claude one' }), chat({ id: 'b', provider: 'codex', sessionRef: 's2', title: 'Codex one' })]);
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: /^Codex\s*\d+$/ }));
    expect(screen.queryByText('Claude one')).toBeNull();
    expect(screen.getByText('Codex one')).toBeTruthy();
  });

  it('rows also activate with Space', () => {
    const store = seeded([chat({ id: 'c9', title: 'Fix login' })]);
    mount(store);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Fix login' }), { key: ' ' });
    expect(store.getState().ui.openChatId).toBe('c9');
  });

  it('streaming deltas do not recompute the recent list; a chat change does', () => {
    const store = seeded([chat({ id: 'c1', updatedAt: new Date(NOW + 60_000).toISOString() })], hist(300));
    mount(store);
    const spy = vi.mocked(recentChatsByProject);
    spy.mockClear();
    act(() => { store.setState((s) => ({ ...s, streaming: { ...s.streaming, c1: { m1: 'x' } } })); });
    expect(spy).not.toHaveBeenCalled();
    act(() => { store.setState((s) => ({ ...s, chats: { ...s.chats, c1: { ...s.chats.c1!, title: 'Renamed' } } })); });
    expect(spy).toHaveBeenCalled();
    expect(screen.getByText('Renamed')).toBeTruthy();
  });

  it('a view change keeps the capsule slide (never writes transition: none after the first placement)', () => {
    class RO {
      constructor(private cb: () => void) {}
      observe() { this.cb(); }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    // jsdom has no layout: pretend the nav items are rendered so the capsule counts as placed.
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });
    const store = seeded();
    mount(store);
    const cap = document.querySelector<HTMLElement>('.cap')!;
    const writes: string[] = [];
    Object.defineProperty(cap.style, 'transition', { configurable: true, get: () => '', set: (v: string) => { writes.push(v); } });
    act(() => { store.setState((s) => ({ ...s, ui: { ...s.ui, view: 'projects' } })); });
    act(() => { store.setState((s) => ({ ...s, ui: { ...s.ui, view: 'connections' } })); });
    expect(writes).not.toContain('none');
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
  });

  it('the + on a group with no folder opens New chat without one', () => {
    const handler = vi.fn();
    setNewChatHandler(handler);
    mount(seeded([chat({ cwd: '' })]));
    fireEvent.click(screen.getByRole('button', { name: /^New chat in/ }));
    expect(handler).toHaveBeenCalledWith(undefined);
    setNewChatHandler(null);
  });

  it('the + on a project row opens New chat for that project', () => {
    const handler = vi.fn();
    setNewChatHandler(handler);
    mount(seeded([chat({ cwd: '/work/alpha' })]));
    fireEvent.click(screen.getByRole('button', { name: 'New chat in alpha' }));
    expect(handler).toHaveBeenCalledWith({ cwd: '/work/alpha' });
    expect(location.hash).toBe('');
    setNewChatHandler(null);
  });

  it('snoozed chats return on the next clock tick without any user action', () => {
    vi.useFakeTimers({ now: NOW });
    const store = seeded([chat({ id: 'z', title: 'Sleepy', snoozedUntil: new Date(NOW + 20_000).toISOString() })]);
    mount(store, <Shell />);
    expect(screen.queryByText('Sleepy')).toBeNull();
    act(() => { vi.advanceTimersByTime(31_000); });
    // Back in the sidebar and on the board.
    expect(screen.getAllByText('Sleepy').length).toBe(2);
    expect(screen.getByRole('article', { name: 'Sleepy' })).toBeTruthy();
  });

  it('renders 1 000 history chats on a cold mount within budget', () => {
    const store = seeded([], hist(1000));
    // One cold mount, with a budget that leaves room for a loaded CI machine (it takes ~30-60 ms locally).
    // It is here to catch a quadratic regression, not to benchmark: the structure checks below are the real test.
    const t0 = performance.now();
    mount(store);
    const took = performance.now() - t0;
    expect(document.querySelectorAll('.proj').length).toBe(4);
    expect(document.querySelectorAll('.proj .chat-row').length).toBe(12);
    expect(took).toBeLessThan(1000);
  });
});

describe('Shell: connection banner', () => {
  const banner = () => document.querySelector('.conn-banner')?.textContent ?? null;
  it('connecting (before the first open) shows no banner', () => {
    expect(initialState().socket).toBe('connecting');
    mount(seeded([chat()], [], { socket: 'connecting' }), <Shell />);
    expect(banner()).toBeNull();
  });
  it('a page opened without a token says to use the printed link; a 401 after connecting says the server restarted', () => {
    const store = seeded([chat()], [], { socket: 'no_token' });
    mount(store, <Shell />);
    expect(banner()).toBe('Open Agent Kanban from the link the server printed.');
    act(() => store.setState((s) => ({ ...s, socket: 'unauthorized' })));
    expect(banner()).toBe('The server restarted. Open Agent Kanban again from the link it printed.');
    act(() => store.setState((s) => ({ ...s, socket: 'reconnecting' })));
    expect(banner()).toBe('Reconnecting…');
  });
});

describe('Shell: routes', () => {
  it('defaults to the board', () => {
    mount(seeded(), <Shell />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Board');
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
  });

  it('#/projects shows Projects, hides Filter, and the store follows', async () => {
    const store = seeded();
    mount(store, <Shell />);
    act(() => { location.hash = '#/projects'; });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Projects'));
    expect(store.getState().ui.view).toBe('projects');
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
    expect(screen.getByRole('button', { name: /Projects/, current: 'page' })).toBeTruthy();
  });

  it('#/projects/<path>: the top bar says just "Projects"; the page\'s own breadcrumb and title name the project', async () => {
    const path = 'C:\\Users\\me\\open-project';
    const base = seeded().getState();
    const store = createStore({ ...base, projects: [{ id: path, name: 'open-project', path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt: '' }] });
    mount(store, <Shell />);
    act(() => { location.hash = `#/projects/${encodeURIComponent(path)}`; });
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'open-project' }).textContent).toContain('open-project'));
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Projects');
    expect(h1.querySelector('.crumb')).toBeNull();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.querySelector('[aria-current="page"]')!.textContent).toBe('open-project');
    expect(store.getState().ui.view).toBe('projects');
    expect(store.getState().ui.projectId).toBe('C:\\Users\\me\\open-project');
  });

  it('#/connections shows Connections', async () => {
    mount(seeded(), <Shell />);
    act(() => { location.hash = '#/connections'; });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Connections'));
  });

  it('clicking a nav item changes the hash', () => {
    mount(seeded(), <Shell />);
    fireEvent.click(screen.getByRole('button', { name: /Connections/ }));
    expect(location.hash).toBe('#/connections');
  });

  it('the board crumb names the focused provider', () => {
    mount(seeded(), <Shell />);
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Codex');
  });

  it('New chat buttons and the N key call the New chat action', () => {
    const handler = vi.fn();
    mount(seeded(), <Shell />);
    // Replaces the handler the shell's New chat dialog registered (newchat.test.tsx covers the dialog itself).
    setNewChatHandler(handler);
    // Sidebar, top bar and the board's Running column "+".
    for (const b of screen.getAllByRole('button', { name: /^New chat( N)?$/ })) fireEvent.click(b);
    expect(handler).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(handler).toHaveBeenCalledTimes(4);
    setNewChatHandler(null);
  });
});

describe('Shell: theme and settings', () => {
  it('toggles data-theme on <html> and remembers it', () => {
    mount(seeded(), <Shell />);
    fireEvent.click(screen.getByRole('button', { name: /Light \/ dark/ }));
    const first = document.documentElement.dataset.theme;
    expect(['light', 'dark']).toContain(first);
    expect(localStorage.getItem('agent-kanban.theme')).toBe(first);
    fireEvent.click(screen.getByRole('button', { name: /Light \/ dark/ }));
    expect(document.documentElement.dataset.theme).not.toBe(first);
  });

  it('applies the remembered theme on load', () => {
    localStorage.setItem('agent-kanban.theme', 'dark');
    mount(seeded(), <Shell />);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('Settings opens a menu with Replay onboarding', () => {
    mount(seeded(), <Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const item = screen.getByRole('menuitem', { name: 'Replay onboarding' });
    expect(item.getAttribute('aria-disabled')).toBeNull();
  });
});
