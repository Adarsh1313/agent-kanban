import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Chat, HistoryChat, Project, Settings } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot, applySettings, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const ON = { claude: true, codex: true, antigravity: true };
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

const project = (path: string, hoursAgo: number, over: Partial<Project> = {}): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 },
  historyOnly: 0, lastActivityAt: at(hoursAgo), hidden: null, folderMissing: false, ...over,
});
const settings = (myProjects: string[] | null, over: Partial<Settings> = {}): Settings =>
  ({ onboarded: true, showChats: ON, suggest: ON, hiddenProjects: [], unhiddenProjects: [], suggestNextSteps: true, myProjects, ...over });
const hist = (cwd: string, sessionRef: string, title: string, hoursAgo: number): HistoryChat => ({ provider: 'codex', sessionRef, title, cwd, updatedAt: at(hoursAgo) });

const PROJECTS = [project('/work/alpha', 1), project('/work/beta', 0.5), project('/work/gamma', 3), project('/work/old', 900)];
const CHATS: Chat[] = [
  chat({ id: 'a1', sessionRef: 'a1', title: 'Alpha newest', cwd: '/work/alpha', column: 'review', updatedAt: at(1) }),
  chat({ id: 'a2', sessionRef: 'a2', title: 'Alpha second', cwd: '/work/alpha', column: 'done', updatedAt: at(2) }),
  chat({ id: 'a3', sessionRef: 'a3', title: 'Alpha third', cwd: '/work/alpha', column: 'done', updatedAt: at(3) }),
  chat({ id: 'a4', sessionRef: 'a4', title: 'Alpha old but running', cwd: '/work/alpha', column: 'running', updatedAt: at(10) }),
  chat({ id: 'a5', sessionRef: 'a5', title: 'Alpha old and done', cwd: '/work/alpha', column: 'done', updatedAt: at(11) }),
  chat({ id: 'a6', sessionRef: 'a6', title: 'Alpha pinned', cwd: '/work/alpha', column: 'done', pinned: true, updatedAt: at(0.1) }),
  chat({ id: 'b1', sessionRef: 'b1', title: 'Beta waiting', cwd: '/work/beta', column: 'needs_you', updatedAt: at(0.5) }),
  chat({ id: 'g1', sessionRef: 'g1', title: 'Gamma chat', cwd: '/work/gamma', column: 'done', updatedAt: at(3) }),
];

function seeded(mine: string[] | null, projects = PROJECTS, over: Partial<Settings> = {}): Store {
  const s = applySnapshot(initialState(), {
    chats: CHATS, usage: [], suggested: null, connections: [], projects, settings: settings(mine, over),
    history: [hist('/work/alpha', 'h1', 'Alpha history', 5), hist('/work/old', 'h2', 'Old history', 900)],
  });
  return createStore({ ...s, now: NOW });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Sidebar /></StoreProvider>);
const card = (name: string) => screen.getByRole('group', { name });
const cardNames = () => screen.queryAllByRole('group').map((g) => g.getAttribute('aria-label'));

beforeEach(() => { try { localStorage.clear(); } catch { /* storage blocked */ } });
afterEach(cleanup);

describe('My projects in the sidebar', () => {
  it('shows one card per project in My projects, most recently active first, and no Recent chats', () => {
    mount(seeded(['/work/alpha', '/work/beta']));
    expect(cardNames()).toEqual(['beta', 'alpha']);
    expect(screen.queryByText('Recent chats')).toBeNull();
    expect(screen.queryByText('Gamma chat')).toBeNull();
  });

  it("a card's summary says what is running and what needs you", () => {
    mount(seeded(['/work/alpha', '/work/beta']));
    expect(within(card('alpha')).getByText(/1 running/)).toBeTruthy();
    expect(within(card('alpha')).getByText(/1 needs you/)).toBeTruthy();
    expect(within(card('beta')).getByText(/1 needs you/)).toBeTruthy();
  });

  it('a card lists the 3 newest chats, plus a running one beyond them, then how many more there are', () => {
    mount(seeded(['/work/alpha']));
    const rows = [...card('alpha').querySelectorAll('.chat-row .t')].map((t) => t.textContent);
    expect(rows).toEqual(['Alpha newest', 'Alpha second', 'Alpha third', 'Alpha old but running']);
    // Left out: the pinned chat (it is under Pinned) and the older ones, counted in "more".
    expect(within(card('alpha')).getByRole('button', { name: '2 more in All chats' })).toBeTruthy();
  });

  it('"N more" opens All chats filtered to that project', () => {
    const store = seeded(['/work/alpha']);
    mount(store);
    fireEvent.click(within(card('alpha')).getByRole('button', { name: '2 more in All chats' }));
    expect(location.hash).toBe('#/chats');
    expect(store.getState().ui.chatsFilters.project).toEqual(['/work/alpha']);
  });

  it('a card collapses to its header, and stays collapsed after a reload', () => {
    const store = seeded(['/work/alpha']);
    const view = mount(store);
    const head = within(card('alpha')).getByRole('button', { name: /^alpha/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    view.unmount();
    mount(seeded(['/work/alpha']));
    expect(within(card('alpha')).getByRole('button', { name: /^alpha/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('never picked: a "Pick your projects" card; picked none: the empty state', () => {
    const view = mount(seeded(null));
    expect(screen.getByRole('button', { name: 'Pick projects' })).toBeTruthy();
    expect(cardNames()).toEqual([]);
    view.unmount();
    mount(seeded([]));
    expect(screen.queryByRole('button', { name: 'Pick projects' })).toBeNull();
    expect(screen.getByText('Pick the projects you work on.')).toBeTruthy();
  });

  it('a hidden project leaves the sidebar even in My projects, and comes back when unhidden', () => {
    const store = seeded(['/work/alpha', '/work/beta'], PROJECTS, { hiddenProjects: ['/work/beta'] });
    mount(store);
    expect(cardNames()).toEqual(['alpha']);
    act(() => store.setState((s) => applySettings(s, settings(['/work/alpha', '/work/beta']))));
    expect(cardNames()).toEqual(['beta', 'alpha']);
  });

  it('a project whose folder is missing stays, dimmed, saying so', () => {
    mount(seeded(['/work/gamma'], [project('/work/gamma', 3, { folderMissing: true })]));
    expect(card('gamma').className).toContain('missing');
    expect(within(card('gamma')).getByText('Folder missing')).toBeTruthy();
    expect(within(card('gamma')).getByText('Gamma chat')).toBeTruthy();
  });

  it('My projects matches folders however they are spelled', () => {
    mount(seeded(['/work/alpha/']));
    expect(cardNames()).toEqual(['alpha']);
  });
});
