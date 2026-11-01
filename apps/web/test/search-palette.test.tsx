import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HistoryChat, Project, Settings } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';
import { SearchPalette } from '../src/ui/search/SearchPalette.tsx';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const ON = { claude: true, codex: true, antigravity: true };
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const project = (path: string, hoursAgo: number, over: Partial<Project> = {}): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 },
  historyOnly: 0, lastActivityAt: at(hoursAgo), hidden: null, folderMissing: false, ...over,
});
const settings: Settings = { onboarded: true, showChats: ON, suggest: ON, hiddenProjects: ['/work/secret'], unhiddenProjects: [], myProjects: ['/work/localflow'] };
const hist = (cwd: string, sessionRef: string, title: string, hoursAgo: number): HistoryChat => ({ provider: 'codex', sessionRef, title, cwd, updatedAt: at(hoursAgo) });

function seeded(): Store {
  const s = applySnapshot(initialState(), {
    chats: [
      chat({ id: 'v1', sessionRef: 'v1', title: 'Voice commands review', cwd: '/work/localflow', updatedAt: at(1) }),
      chat({ id: 'k1', sessionRef: 'k1', title: 'Kanban sidebar cards', cwd: '/work/kanban', updatedAt: at(2) }),
      chat({ id: 's1', sessionRef: 's1', title: 'Secret voice notes', cwd: '/work/secret', updatedAt: at(0.5) }),
    ],
    history: [hist('/work/localflow', 'h1', 'Hotkey conflicts', 3)],
    usage: [], suggested: null, connections: [], settings,
    projects: [project('/work/localflow', 1), project('/work/kanban', 2), project('/work/secret', 0.5)],
  });
  return createStore({ ...s, now: NOW });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Sidebar /><SearchPalette /></StoreProvider>);
const palette = () => screen.queryByRole('dialog', { name: 'Search' });
const input = () => within(palette()!).getByRole('combobox', { name: 'Search chats and projects' });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const options = (list: 'Projects' | 'Chats') => within(within(palette()!).getByRole('listbox', { name: list })).queryAllByRole('option').map((o) => o.querySelector('.r-t')!.textContent);

beforeEach(() => { location.hash = '#/board'; });
afterEach(cleanup);

describe('Global search', () => {
  it('the sidebar field and Ctrl+K open the palette; Esc closes it and clears the query', () => {
    mount(seeded());
    expect(palette()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Search chats and projects/ }));
    expect(palette()).toBeTruthy();
    expect(document.activeElement).toBe(input());
    type('voice');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(palette()).toBeNull();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect((input() as HTMLInputElement).value).toBe('');
  });

  it('matches projects by name and chats by title, with the match highlighted; hidden projects are left out', () => {
    mount(seeded());
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    type('voice');
    expect(options('Chats')).toEqual(['Voice commands review']);
    expect(within(palette()!).getByText('Voice', { selector: 'mark' })).toBeTruthy();
    type('flow');
    expect(options('Projects')).toEqual(['localflow']);
    type('nothing like this');
    expect(within(palette()!).getByText('Nothing matches “nothing like this”')).toBeTruthy();
  });

  it("highlighting a project shows that project's chats on the right", () => {
    mount(seeded());
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    type('localflow');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(within(palette()!).getByRole('listbox', { name: 'Chats' }).getAttribute('aria-label')).toBe('Chats');
    expect(within(palette()!).getByText('Chats in localflow')).toBeTruthy();
    expect(options('Chats')).toEqual(['Voice commands review', 'Hotkey conflicts']);
  });

  it('Enter opens the selected chat; on a project it opens the project', () => {
    const store = seeded();
    mount(store);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    type('kanban sidebar');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(store.getState().ui.openChatId).toBe('k1');
    expect(palette()).toBeNull();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    type('kanban');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(location.hash).toBe('#/projects/%2Fwork%2Fkanban');
  });

  it('"See all results" opens All chats with the query', () => {
    const store = seeded();
    mount(store);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    type('voice');
    fireEvent.click(within(palette()!).getByRole('button', { name: 'See all results in All chats' }));
    expect(location.hash).toBe('#/chats');
    expect(store.getState().ui.chatsSearchText).toBe('voice');
    expect(palette()).toBeNull();
  });

  it('the sidebar no longer has its own New chat button', () => {
    mount(seeded());
    expect(screen.queryByRole('button', { name: /^New chat/ })).toBeNull();
  });
});
