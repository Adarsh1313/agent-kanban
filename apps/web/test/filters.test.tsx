import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Chat, HistoryChat } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot, initialState, type AppState, type Filters } from '../src/state/reducer.ts';
import { recentChats } from '../src/state/selectors.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Board } from '../src/ui/board/Board.tsx';
import { FilterBar } from '../src/ui/filters/FilterBar.tsx';
import { filterOptions } from '../src/ui/filters/model.ts';
import { Shell } from '../src/ui/shell/Shell.tsx';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';
import { TopBar } from '../src/ui/shell/TopBar.tsx';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

const CHATS: Chat[] = [
  chat({ id: 'a', title: 'Fix login', provider: 'claude', sessionRef: 'sa', cwd: '/work/alpha', model: 'sonnet', column: 'running' }),
  chat({ id: 'b', title: 'Add tests', provider: 'codex', sessionRef: 'sb', cwd: '/work/beta', model: 'gpt-5', column: 'needs_you', needsReason: 'permission' }),
  chat({ id: 'c', title: 'Write docs', provider: 'antigravity', sessionRef: 'sc', cwd: '/work/gamma', model: 'gemini', column: 'review' }),
];
const HISTORY: HistoryChat[] = [{ provider: 'claude', sessionRef: 'h1', title: 'Old idea', cwd: '/work/delta', updatedAt: '2026-10-23T11:00:00.000Z' }];

function seeded(filters: Partial<Filters> = {}, chats = CHATS, history = HISTORY): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history, projects: [] });
  return createStore({ ...s, now: NOW, ui: { ...s.ui, filters: { ...s.ui.filters, ...filters } } });
}
const mount = (store: Store, ui = <><TopBar /><FilterBar /><Board /></>) => render(<StoreProvider store={store}>{ui}</StoreProvider>);

const menu = () => screen.getByRole('menu', { name: 'Filter' });
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
const item = (name: string | RegExp) => within(menu()).getByRole('menuitem', { name });
const check = (name: string | RegExp) => within(menu()).getByRole('menuitemcheckbox', { name });
const bar = () => screen.queryByRole('group', { name: 'Active filters' });

beforeEach(() => { location.hash = ''; });
afterEach(() => cleanup());

describe('Filter menu', () => {
  it('opens on the Filter button with the seven categories', () => {
    mount(seeded());
    openMenu();
    expect(menu().getAttribute('data-state')).toBe('open');
    const names = within(menu()).getAllByRole('menuitem').map((b) => b.textContent);
    expect(names).toEqual(['Provider', 'Project', 'Status', 'Model', 'Waiting on you for', 'Last activity', 'Started in']);
    expect(document.activeElement).toBe(within(menu()).getByRole('searchbox', { name: 'Search filters' }));
  });

  it('None selects nothing: the board shows the no-results state; Clear filters brings everything back', () => {
    const store = seeded();
    mount(store);
    openMenu();
    fireEvent.click(item('Provider'));
    expect(check('Claude Code').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(menu()).getByRole('button', { name: 'None' }));
    expect(store.getState().ui.filters.provider).toEqual([]);
    expect(check('Claude Code').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('No chats match these filters')).toBeTruthy();
    expect(bar()!.textContent).toContain('Provideris' + 'none selected');
    // One no-results UI: the board's, not a second one from the bar.
    expect(screen.getAllByText('No chats match these filters')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(store.getState().ui.filters).toEqual(initialState().ui.filters);
    expect(screen.queryByText('No chats match these filters')).toBeNull();
    expect(bar()).toBeNull();
  });

  it('Select all goes back to no filter; unticking one from "all" keeps the rest', () => {
    const store = seeded();
    mount(store);
    openMenu();
    fireEvent.click(item('Status'));
    fireEvent.click(check('Done'));
    expect(store.getState().ui.filters.status).toEqual(['running', 'needs_you', 'review']);
    fireEvent.click(within(menu()).getByRole('button', { name: 'Select all' }));
    expect(store.getState().ui.filters.status).toBeNull();
    fireEvent.click(within(menu()).getByRole('button', { name: 'Back' }));
    expect(item('Provider')).toBeTruthy();
  });

  it('Last activity takes one value and has no Select all / None', () => {
    const store = seeded();
    mount(store);
    openMenu();
    fireEvent.click(item('Last activity'));
    expect(within(menu()).queryByRole('button', { name: 'None' })).toBeNull();
    fireEvent.click(check('Today'));
    fireEvent.click(check('This week'));
    expect(store.getState().ui.filters.activity).toBe('week');
    expect(check('Today').getAttribute('aria-checked')).toBe('false');
  });

  it('options come from the data: providers and projects with chats, models seen on chats', () => {
    const store = seeded({}, [CHATS[0]!, CHATS[1]!], []);
    const s = store.getState();
    expect(filterOptions(s, 'provider').map((o) => o.label)).toEqual(['Claude Code', 'Codex']);
    expect(filterOptions(s, 'project').map((o) => o.label)).toEqual(['alpha', 'beta']);
    expect(filterOptions(s, 'model').map((o) => o.v)).toEqual(['gpt-5', 'sonnet']);
    expect(filterOptions(s, 'source').map((o) => o.label)).toEqual(['Agent Kanban', 'The provider’s own app']);
  });

  it('search finds values across categories and jumps to that category with the value chosen', () => {
    const store = seeded();
    mount(store);
    openMenu();
    fireEvent.change(within(menu()).getByRole('searchbox'), { target: { value: 'codex' } });
    const hit = item(/Codex/);
    expect(hit.textContent).toContain('Provider');
    fireEvent.click(hit);
    expect(store.getState().ui.filters.provider).toEqual(['codex']);
    expect(check('Codex').getAttribute('aria-checked')).toBe('true');
    expect(check('Claude Code').getAttribute('aria-checked')).toBe('false');
    expect(within(menu()).getByText('Provider')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Fix login' })).toBeNull();
  });

  it('search: Enter picks the first match; no match says so', () => {
    const store = seeded();
    mount(store);
    openMenu();
    const search = within(menu()).getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(within(menu()).getByText('No matches')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'review' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(store.getState().ui.filters.status).toEqual(['review']);
  });

  it('arrow keys move between the search field and the items', () => {
    mount(seeded());
    openMenu();
    const search = within(menu()).getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Provider'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Project'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(item('Started in'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(search);
    // Opening a pane puts focus on its first option.
    fireEvent.click(item('Status'));
    expect(document.activeElement).toBe(check('Running'));
  });
});

describe('Filter chips', () => {
  it('words chips like the design and × removes only that category', () => {
    const store = seeded({ provider: ['claude', 'codex'], status: ['running'], project: ['/work/alpha', '/work/beta', '/work/gamma'] });
    mount(store);
    const chips = [...bar()!.querySelectorAll('.fchip')].map((c) => c.textContent);
    expect(chips).toEqual(['Provideris any ofClaude Code, Codex', 'Projectis any of3 projects', 'StatusisRunning']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Provider filter' }));
    expect(store.getState().ui.filters.provider).toBeNull();
    expect(store.getState().ui.filters.status).toEqual(['running']);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Clear all' }));
    expect(store.getState().ui.filters).toEqual(initialState().ui.filters);
    expect(bar()).toBeNull();
  });

  it('the category row shows how many values are chosen', () => {
    mount(seeded({ model: ['sonnet', 'gemini'] }));
    openMenu();
    expect(item(/^Model/).textContent).toBe('Model2');
  });
});

describe('Shell: F key and the sidebar', () => {
  it('F opens the Filter menu, Esc closes it; F while typing does nothing', () => {
    mount(seeded(), <Shell />);
    fireEvent.keyDown(document.body, { key: 'f' });
    expect(menu().getAttribute('data-state')).toBe('open');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu().getAttribute('data-state')).toBe('closed');
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'f' });
    expect(menu().getAttribute('data-state')).toBe('closed');
    input.remove();
  });

  it('a sidebar provider row is the provider filter: it shows as a chip and the menu edits it', () => {
    const store = seeded();
    mount(store, <Shell />);
    fireEvent.click([...document.querySelectorAll<HTMLElement>('.navitem.prov')].find((b) => b.textContent?.startsWith('Codex'))!);
    expect(bar()!.textContent).toContain('ProviderisCodex');
    expect(screen.queryByRole('article', { name: 'Fix login' })).toBeNull();
    openMenu();
    fireEvent.click(item(/^Provider/));
    expect(check('Codex').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(check('Claude Code'));
    expect(store.getState().ui.filters.provider).toEqual(['codex', 'claude']);
  });

  it('the sidebar\'s recent chats follow the filters (history-only chats are "the provider\'s own app")', () => {
    const s = seeded().getState();
    const titles = (st: AppState) => recentChats(st, NOW).map((c) => c.title).sort();
    const w = (f: Partial<Filters>): AppState => ({ ...s, ui: { ...s.ui, filters: { ...s.ui.filters, ...f } } });
    expect(titles(s)).toEqual(['Add tests', 'Fix login', 'Old idea', 'Write docs']);
    expect(titles(w({ source: ['native'] }))).toEqual(['Old idea']);
    expect(titles(w({ source: ['here'] }))).toEqual(['Add tests', 'Fix login', 'Write docs']);
    expect(titles(w({ status: ['needs_you'] }))).toEqual(['Add tests']);
    expect(titles(w({ provider: ['claude'] }))).toEqual(['Fix login', 'Old idea']);
    // History rows count as column null: no status, no model, no reason, so those filters leave them out.
    expect(titles(w({ status: ['running', 'needs_you', 'review'] }))).toEqual(['Add tests', 'Fix login', 'Write docs']);
    expect(titles(w({ model: ['sonnet'] }))).toEqual(['Fix login']);
    expect(titles(w({ reason: ['permission'] }))).toEqual(['Add tests']);
    expect(titles(w({ provider: ['claude'], source: ['native'] }))).toEqual(['Old idea']);
    mount(createStore(w({ provider: [] })), <Sidebar />);
    expect(screen.queryByText('Fix login')).toBeNull();
  });

  it('the sidebar says so when filters leave no recent chats, and says nothing without filters', () => {
    const s = seeded().getState();
    mount(createStore({ ...s, ui: { ...s.ui, filters: { ...s.ui.filters, provider: [] } } }), <Sidebar />);
    expect(screen.getByText('No matching chats')).toBeTruthy();
    cleanup();
    mount(seeded({}, [], []), <Sidebar />);
    expect(screen.queryByText('No matching chats')).toBeNull();
  });
});

describe('Filter menu: Project', () => {
  const ROOT = 'C:/Users/me/AppData/Roaming/Claude/scratch-workspaces';
  const chats: Chat[] = [
    chat({ id: 'a', sessionRef: 'sa', cwd: '/work/alpha', updatedAt: '2026-10-23T11:00:00.000Z' }),
    chat({ id: 't', sessionRef: 'st', cwd: '/tmp/ak-claude-1', updatedAt: '2026-10-23T11:00:00.000Z' }),
  ];
  const history: HistoryChat[] = [
    { provider: 'claude', sessionRef: 'h1', title: 'Regex', cwd: `${ROOT}/u1/scratch-aa`, updatedAt: '2026-10-22T11:00:00.000Z' },
    { provider: 'claude', sessionRef: 'h2', title: 'Zstd', cwd: `${ROOT}/u2/scratch-bb`, updatedAt: '2026-10-21T11:00:00.000Z' },
    { provider: 'codex', sessionRef: 'h3', title: 'Thesis outline', cwd: '/work/thesis', updatedAt: '2026-08-01T11:00:00.000Z' },
  ];
  const hiddenTemp = { id: '/tmp/ak-claude-1', name: 'ak-claude-1', path: '/tmp/ak-claude-1', providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt: '', hidden: 'auto' as const, folderMissing: false };

  it('offers one option per project (Claude scratch chats as one), leaves hidden ones out, and puts older ones under their own label', () => {
    const base = seeded({}, chats, history);
    const store = createStore({ ...base.getState(), projects: [hiddenTemp] });
    mount(store);
    openMenu();
    fireEvent.click(item('Project'));
    const rows = [...menu().querySelectorAll('.menu-item[role="menuitemcheckbox"], .menu-label')].map((e) => e.textContent?.trim());
    expect(rows.slice(1)).toEqual(['alpha', 'Claude scratch chats', 'Older · no activity in 30 days', 'thesis']);
  });

  it('choosing Claude scratch chats keeps every scratch chat', () => {
    const base = seeded({ project: [ROOT] }, chats, history);
    expect(recentChats(base.getState(), NOW).map((c) => c.title).sort()).toEqual(['Regex', 'Zstd']);
  });
});
