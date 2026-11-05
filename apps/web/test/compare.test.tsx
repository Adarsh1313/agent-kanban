import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Chat, Project } from '@agent-kanban/shared';
import { folderKey } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { reloadCompare } from '../src/ui/compare/model.ts';
import { COMPARE_TITLE } from '../src/ui/compare/Compare.tsx';
import { Shell } from '../src/ui/shell/Shell.tsx';
import { setNewChatHandler } from '../src/ui/actions.ts';
import { HINT_OTHER_PROJECT } from '../src/ui/board/Card.tsx';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const project = (path: string, over: Partial<Project> = {}): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0,
  lastActivityAt: '2026-10-23T10:00:00.000Z', hidden: null, folderMissing: false, ...over,
});

const PROJECTS = [project('/work/alpha'), project('/work/beta'), project('/work/gamma'), project('/work/delta')];
const CHATS: Chat[] = [
  chat({ id: 'a1', title: 'Alpha running', cwd: '/work/alpha', column: 'running', sessionRef: 'a1' }),
  chat({ id: 'a2', title: 'Alpha asks', cwd: '/work/alpha', column: 'needs_you', needsReason: 'question', sessionRef: 'a2' }),
  chat({ id: 'b1', title: 'Beta review', cwd: '/work/beta', column: 'review', provider: 'codex', sessionRef: 'b1' }),
  chat({ id: 'b2', title: 'Beta running', cwd: '/work/beta', column: 'running', provider: 'codex', sessionRef: 'b2' }),
  chat({ id: 'g1', title: 'Gamma done', cwd: '/work/gamma', column: 'done', sessionRef: 'g1' }),
];

function seeded(chats: Chat[] = CHATS, projects: Project[] = PROJECTS, extra: Partial<AppState> = {}): Store {
  const on = { claude: true, codex: true, antigravity: true };
  const settings = { onboarded: true, showChats: on, suggest: on, hiddenProjects: [], unhiddenProjects: [], suggestNextSteps: true, myProjects: ['/work/gamma'] };
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history: [], projects, settings });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Shell /></StoreProvider>);
const pane = (name: string) => screen.getByRole('region', { name });
const tile = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name},`) });

/** Opens Compare and picks these projects. */
function compare(...names: string[]) {
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  const dlg = screen.getByRole('dialog', { name: COMPARE_TITLE });
  for (const n of names) fireEvent.click(within(dlg).getByRole('checkbox', { name: new RegExp(`^${n},`) }));
  fireEvent.click(within(dlg).getByRole('button', { name: 'Show side by side' }));
}

beforeEach(() => {
  location.hash = '#/board';
  localStorage.clear();
  reloadCompare();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  reloadCompare();
});

describe('Compare (#44)', () => {
  it('the picker lists My projects first and caps the picks at 3', () => {
    mount(seeded());
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const dlg = screen.getByRole('dialog', { name: COMPARE_TITLE });
    expect(within(dlg).getAllByRole('checkbox')[0]!.getAttribute('aria-label')).toMatch(/^gamma,/);
    for (const n of ['alpha', 'beta', 'gamma']) fireEvent.click(tile(n));
    expect((tile('delta') as HTMLButtonElement).disabled).toBe(true);
    expect(within(dlg).getByText(/3 of 3 picked/)).toBeTruthy();
    fireEvent.click(tile('gamma'));
    expect((tile('delta') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows one pane per project with only its chats, in the right columns, and header counts', () => {
    mount(seeded());
    compare('alpha', 'beta');
    expect(screen.queryByRole('region', { name: 'Board' })).toBeNull();
    const alpha = pane('alpha');
    expect(within(within(alpha).getByRole('region', { name: 'Running' })).getByRole('article', { name: 'Alpha running' })).toBeTruthy();
    expect(within(within(alpha).getByRole('region', { name: 'Needs you' })).getByRole('article', { name: 'Alpha asks' })).toBeTruthy();
    expect(within(alpha).queryByRole('article', { name: 'Beta running' })).toBeNull();
    expect(within(alpha).getByText('1 running')).toBeTruthy();
    expect(within(alpha).getByText('1 needs you')).toBeTruthy();
    const beta = pane('beta');
    expect(within(within(beta).getByRole('region', { name: 'Review' })).getByRole('article', { name: 'Beta review' })).toBeTruthy();
    expect(within(beta).getByText('0 needs you')).toBeTruthy();
  });

  it('Exit compare restores the board; the panes come back after a reload', () => {
    const store = seeded();
    mount(store);
    compare('alpha', 'beta');
    expect(pane('alpha')).toBeTruthy();
    cleanup();
    reloadCompare();
    mount(store);
    expect(pane('beta')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exit compare' }));
    expect(screen.getByRole('region', { name: 'Board' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'alpha' })).toBeNull();
  });

  it('a hidden project is dropped; a folder-missing one is dimmed', () => {
    const store = seeded(CHATS, [project('/work/alpha', { hidden: 'auto' }), project('/work/beta', { folderMissing: true }), project('/work/gamma')]);
    mount(store);
    act(() => { localStorage.setItem('agent-kanban.compare', JSON.stringify({ on: true, projects: ['/work/alpha', '/work/beta', '/work/gamma'].map(folderKey), collapsed: [] })); reloadCompare(); });
    expect(screen.queryByRole('region', { name: 'alpha' })).toBeNull();
    expect(pane('beta').classList.contains('missing')).toBe(true);
    expect(pane('gamma')).toBeTruthy();
  });

  it('survives storage that throws', () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try {
      reloadCompare();
      mount(seeded());
      expect(screen.getByRole('region', { name: 'Board' })).toBeTruthy();
    } finally {
      Storage.prototype.getItem = get;
    }
  });
});

describe('Compare: collapse, pane menu, drag (#44 slice 3)', () => {
  const realFromPoint = document.elementFromPoint;
  afterEach(() => { document.elementFromPoint = realFromPoint; setNewChatHandler(null); });

  it('collapse shrinks a pane to a strip with its counts, and stays collapsed after a reload', () => {
    const store = seeded();
    mount(store);
    compare('alpha', 'beta');
    const btn = within(pane('alpha')).getByRole('button', { name: 'Collapse alpha' });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(within(pane('alpha')).queryByRole('article')).toBeNull();
    expect(within(pane('alpha')).getByLabelText('1 running')).toBeTruthy();
    expect(within(pane('alpha')).getByLabelText('1 needs you')).toBeTruthy();
    expect(within(pane('alpha')).getByRole('button', { name: 'Expand alpha' }).getAttribute('aria-expanded')).toBe('false');
    expect((screen.getByRole('region', { name: 'Compare' }) as HTMLElement).style.gridTemplateColumns).toContain('var(--pane-strip-width)');
    cleanup();
    reloadCompare();
    mount(store);
    expect(within(pane('alpha')).queryByRole('article')).toBeNull();
    fireEvent.click(within(pane('alpha')).getByRole('button', { name: 'Expand alpha' }));
    expect(within(pane('alpha')).getByRole('article', { name: 'Alpha running' })).toBeTruthy();
  });

  it('the pane menu swaps a project (open ones left out) and removes one; New chat starts in the pane’s project', () => {
    const opened = vi.fn();
    mount(seeded());
    compare('alpha', 'beta');
    setNewChatHandler(opened); // after mount: the shell's New chat dialog registers its own
    fireEvent.click(within(pane('alpha')).getByRole('button', { name: 'New chat in alpha' }));
    expect(opened).toHaveBeenCalledWith({ cwd: '/work/alpha' });
    fireEvent.click(within(pane('alpha')).getByRole('button', { name: 'alpha actions' }));
    const menu = () => screen.getByRole('menu', { name: 'alpha actions' });
    fireEvent.click(within(menu()).getByRole('menuitem', { name: /Swap project/ }));
    expect(within(menu()).queryByRole('menuitem', { name: 'beta' })).toBeNull();
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'gamma' }));
    expect(screen.queryByRole('region', { name: 'alpha' })).toBeNull();
    expect(within(pane('gamma')).getByRole('article', { name: 'Gamma done' })).toBeTruthy();
    fireEvent.click(within(pane('beta')).getByRole('button', { name: 'beta actions' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'beta actions' })).getByRole('menuitem', { name: 'Remove from compare' }));
    expect(screen.queryByRole('region', { name: 'beta' })).toBeNull();
    fireEvent.click(within(pane('gamma')).getByRole('button', { name: 'gamma actions' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'gamma actions' })).getByRole('menuitem', { name: 'Remove from compare' }));
    expect(screen.getByRole('region', { name: 'Board' })).toBeTruthy();
  });

  it('a card dropped on another pane snaps back with the hint', async () => {
    mount(seeded());
    compare('alpha', 'beta');
    const el = within(pane('beta')).getByRole('article', { name: 'Beta review' });
    document.elementFromPoint = () => within(pane('alpha')).getByRole('region', { name: 'Done' });
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 200, clientY: 40 });
    expect(await screen.findByText(HINT_OTHER_PROJECT)).toBeTruthy();
    expect(el.style.transform).toBe('');
    expect(within(within(pane('beta')).getByRole('region', { name: 'Review' })).getByRole('article', { name: 'Beta review' })).toBeTruthy();
  });
});

describe('Compare: filters, narrow windows, budget (#44 slice 4)', () => {
  it('provider focus and filters apply to every pane, counts included', () => {
    const store = seeded();
    mount(store);
    compare('alpha', 'beta');
    act(() => store.setState((s) => ({ ...s, ui: { ...s.ui, filters: { ...s.ui.filters, provider: ['codex'] } } })));
    expect(within(pane('alpha')).queryByRole('article')).toBeNull();
    expect(within(pane('alpha')).getByText('0 running')).toBeTruthy();
    expect(within(pane('beta')).getByRole('article', { name: 'Beta running' })).toBeTruthy();
    expect(within(pane('beta')).getByText('1 running')).toBeTruthy();
  });

  it('panes keep a minimum width and the row scrolls sideways instead of squashing', () => {
    mount(seeded());
    compare('alpha', 'beta', 'gamma');
    const row = screen.getByRole('region', { name: 'Compare' }) as HTMLElement;
    expect(row.style.gridTemplateColumns.split('minmax(var(--pane-min-width), 1fr)').length - 1).toBe(3);
  });

  it('renders 3 panes of 300 chats each within budget', () => {
    const many: Chat[] = ['alpha', 'beta', 'gamma'].flatMap((p) => Array.from({ length: 300 }, (_, i) => chat({
      id: `${p}${i}`, sessionRef: `${p}${i}`, title: `${p} ${i}`, cwd: `/work/${p}`,
      column: (['running', 'needs_you', 'review', 'done'] as const)[i % 4], needsReason: i % 4 === 1 ? 'question' : null,
      updatedAt: new Date(NOW - i * 60_000).toISOString(),
    })));
    // Warm up once (module and JIT start-up). jsdom speed varies with machine load, so the budget is relative: the
    // same 900 cards on the plain board, and Compare may cost at most twice that (a quadratic regression would not).
    mount(seeded());
    cleanup();
    let t0 = performance.now();
    mount(seeded(many));
    expect(screen.getAllByRole('article')).toHaveLength(900);
    const board = performance.now() - t0;
    cleanup();
    localStorage.setItem('agent-kanban.compare', JSON.stringify({ on: true, projects: ['/work/alpha', '/work/beta', '/work/gamma'].map(folderKey), collapsed: [] }));
    reloadCompare();
    t0 = performance.now();
    mount(seeded(many));
    expect(screen.getAllByRole('article')).toHaveLength(900);
    const panes = performance.now() - t0;
    expect(panes).toBeLessThan(board * 2 + 500);
    expect(within(pane('beta')).getByText('75 running')).toBeTruthy();
  }, 60_000);
});
