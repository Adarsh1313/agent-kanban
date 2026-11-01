import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat, HistoryChat, Project } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Shell } from '../src/ui/shell/Shell.tsx';
import { AllChatsPage } from '../src/ui/chats/AllChatsPage.tsx';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const project = (path: string, hidden: Project['hidden'] = null): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 },
  historyOnly: 0, lastActivityAt: ago(0), hidden, folderMissing: false,
});
const hist = (over: Partial<HistoryChat>): HistoryChat => ({ provider: 'codex', sessionRef: 'h1', title: 'History', cwd: '/work/beta', updatedAt: ago(120), ...over });

const CHATS: Chat[] = [
  chat({ id: 'a', sessionRef: 'a', title: 'Fix login redirect', cwd: '/work/alpha', updatedAt: ago(5) }),
  chat({ id: 'b', sessionRef: 'b', provider: 'codex', title: 'Pricing copy', cwd: '/work/site', updatedAt: ago(60), column: 'review' }),
  chat({ id: 't', sessionRef: 't', title: 'Temp run', cwd: '/tmp/ak-claude-1', updatedAt: ago(1) }),
];
const HISTORY = [hist({ sessionRef: 'h1', title: 'Old login idea', cwd: '/work/beta', updatedAt: ago(3000) })];
const PROJECTS = [project('/work/alpha'), project('/work/site'), project('/work/beta'), project('/tmp/ak-claude-1', 'auto')];

function seeded(): Store {
  const s = applySnapshot(initialState(), { chats: CHATS, usage: [], suggested: null, connections: [], history: HISTORY, projects: PROJECTS });
  return createStore({ ...s, now: NOW });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Shell /></StoreProvider>);
const page = () => screen.getByRole('list', { name: 'All chats' });
const titles = () => [...page().querySelectorAll('.crow .t')].map((r) => r.textContent);

beforeEach(() => { location.hash = '#/chats'; });
afterEach(() => { cleanup(); location.hash = ''; });

describe('All chats', () => {
  it('lists every chat, on the board or only in history, newest first, without hidden projects', () => {
    mount(seeded());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('All chats');
    expect(titles()).toEqual(['Fix login redirect', 'Pricing copy', 'Old login idea']);
    const row = page().querySelectorAll('.crow')[1]! as HTMLElement;
    expect(within(row).getByText('site')).toBeTruthy();
    expect(within(row).getByText('1h')).toBeTruthy();
    expect(within(page()).getAllByText('On board')).toHaveLength(2);
    expect(within(page()).getByText('In history')).toBeTruthy();
  });

  it('groups rows under the five local date buckets in order', () => {
    const dates = [
      ['Today chat', new Date(2026, 9, 23, 10)],
      ['Yesterday chat', new Date(2026, 9, 22, 10)],
      ['Week chat', new Date(2026, 9, 20, 10)],
      ['Month chat', new Date(2026, 9, 10, 10)],
      ['Older chat', new Date(2026, 8, 30, 10)],
    ] as const;
    const history = dates.map(([title, at], i) => hist({ sessionRef: `g${i}`, title, updatedAt: at.toISOString() }));
    const s = applySnapshot(initialState(), { chats: [], usage: [], suggested: null, connections: [], history, projects: [] });
    render(<StoreProvider store={createStore({ ...s, now: NOW })}><AllChatsPage /></StoreProvider>);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday', 'This week', 'This month', 'Older']);
  });

  it('switches to Archived and offers the same row menu for board and history chats', () => {
    const store = seeded();
    store.setState((s) => ({
      ...s,
      chats: { ...s.chats, a: { ...s.chats.a!, archived: true } },
      history: s.history.map((h) => h.sessionRef === 'h1' ? { ...h, archived: true } : h),
    }));
    mount(store);
    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(titles()).toEqual(['Fix login redirect', 'Old login idea']);
    expect(within(page()).getAllByRole('button', { name: 'More actions' })).toHaveLength(2);
  });

  it('Trash shows days left, restores a chat, and confirms Empty trash', async () => {
    const store = seeded();
    store.setState((s) => ({ ...s, trash: [{ id: 'claude-s1', chatId: 'a', provider: 'claude', sessionRef: 's1', title: 'Deleted work', deletedAt: ago(60), daysLeft: 29 }] }));
    const fetch = vi.fn().mockResolvedValue(Response.json(store.getState().trash[0]));
    vi.stubGlobal('fetch', fetch);
    mount(store);
    fireEvent.click(screen.getByRole('tab', { name: 'Trash' }));
    expect(screen.getByRole('list', { name: 'Trash' }).textContent).toContain('29 days left');
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(store.getState().trash).toHaveLength(0));
    expect(fetch.mock.calls.some((call) => call[0] === '/api/trash/claude-s1/restore')).toBe(true);

    store.setState((s) => ({ ...s, trash: [{ id: 'codex-s2', chatId: null, provider: 'codex', sessionRef: 's2', title: 'Another', deletedAt: ago(60), daysLeft: 29 }] }));
    fireEvent.click(document.querySelector<HTMLButtonElement>('.trash-empty')!);
    expect(screen.getByRole('dialog', { name: 'Empty trash?' }).textContent).toContain('gone for good');
  });

  it('search matches the title or the project and highlights the match; nothing matching shows an empty state', () => {
    mount(seeded());
    const box = screen.getByRole('searchbox', { name: 'Search chats' });
    fireEvent.change(box, { target: { value: 'login' } });
    expect(titles()).toEqual(['Fix login redirect', 'Old login idea']);
    expect(page().querySelector('mark')!.textContent).toBe('login');
    fireEvent.change(box, { target: { value: 'site' } });
    expect(titles()).toEqual(['Pricing copy']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No chats match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(titles()).toHaveLength(3);
  });

  it('its Filter menu offers only Project and Provider, filters as chips, and leaves the board filters alone', async () => {
    const store = seeded();
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const menu = await screen.findByRole('menu', { name: 'Filter' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent?.replace(/\d+$/, ''))).toEqual(['Provider', 'Project']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Provider/ }));
    fireEvent.click(await within(menu).findByRole('menuitemcheckbox', { name: /Claude Code/ }));
    expect(titles()).toEqual(['Pricing copy', 'Old login idea']);
    expect(store.getState().ui.filters.provider).toBeNull();
    const chips = screen.getByRole('group', { name: 'Active filters' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove Provider filter' }));
    expect(titles()).toHaveLength(3);
  });

  it('renders 1 000 history chats within budget, 100 at a time', () => {
    const many = Array.from({ length: 1000 }, (_, i) => hist({ sessionRef: `m${i}`, title: `History ${i}`, cwd: `/work/p${i % 40}`, updatedAt: ago(i) }));
    const s = applySnapshot(initialState(), { chats: [], usage: [], suggested: null, connections: [], history: many, projects: [] });
    // Warm up once (the first render in a file pays for module and JIT start-up); the budget is there to catch a
    // quadratic regression, not to benchmark jsdom.
    render(<StoreProvider store={seeded()}><AllChatsPage /></StoreProvider>);
    cleanup();
    const t0 = performance.now();
    render(<StoreProvider store={createStore({ ...s, now: NOW })}><AllChatsPage /></StoreProvider>);
    expect(titles()).toHaveLength(100);
    expect(performance.now() - t0).toBeLessThan(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more' }));
    expect(titles()).toHaveLength(200);
  });

  it('a row opens the chat, or the history chat', () => {
    const store = seeded();
    mount(store);
    fireEvent.click(within(page()).getByText('Pricing copy'));
    expect(store.getState().ui.openChatId).toBe('b');
  });
});

describe('Getting to All chats', () => {
  beforeEach(() => { location.hash = '#/board'; });

  it('the nav item goes to All chats', () => {
    mount(seeded());
    fireEvent.click(screen.getByRole('button', { name: /^All chats$/ }));
    expect(location.hash).toBe('#/chats');
  });

  it('"See all results" in global search opens All chats with the query in its focused search box', async () => {
    const store = seeded();
    mount(store);
    act(() => {
      store.setState((s) => ({ ...s, ui: { ...s.ui, chatsSearchText: 'login', chatsSearchFocus: s.ui.chatsSearchFocus + 1 } }));
      location.hash = '#/chats';
    });
    const box = await screen.findByRole('searchbox', { name: 'Search chats' }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.value).toBe('login');
  });
});
