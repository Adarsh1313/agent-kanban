import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat, HistoryChat, Project } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const titles = () => within(page()).queryAllByRole('button').map((r) => r.querySelector('.t')!.textContent);

beforeEach(() => { location.hash = '#/chats'; });
afterEach(() => { cleanup(); location.hash = ''; });

describe('All chats', () => {
  it('lists every chat, on the board or only in history, newest first, without hidden projects', () => {
    mount(seeded());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('All chats');
    expect(titles()).toEqual(['Fix login redirect', 'Pricing copy', 'Old login idea']);
    const row = within(page()).getAllByRole('button')[1]!;
    expect(within(row).getByText('site')).toBeTruthy();
    expect(within(row).getByText('1h')).toBeTruthy();
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

  it("the sidebar's search icon opens All chats with the search box focused", async () => {
    mount(seeded());
    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
    expect(location.hash).toBe('#/chats');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search chats' })));
  });
});
