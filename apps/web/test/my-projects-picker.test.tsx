import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Settings } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.ts';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';
import { PickProjectsDialog } from '../src/ui/myprojects/PickProjects.tsx';
import { addAfterStart, defaultPicks } from '../src/ui/myprojects/model.ts';
import { StarButton } from '../src/ui/myprojects/StarButton.tsx';
import type { HistoryChat } from '@agent-kanban/shared';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, patchSettings: vi.fn() } };
});
const patchSettings = api.patchSettings as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const ON = { claude: true, codex: true, antigravity: true };
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const project = (path: string, days: number, over: Partial<Project> = {}): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [{ provider: 'claude', chats: 2, lastUsedAt: daysAgo(days), lastModel: null }],
  columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 2, lastActivityAt: daysAgo(days), hidden: null, folderMissing: false, ...over,
});
const settings = (myProjects: string[] | null): Settings => ({ onboarded: true, showChats: ON, suggest: ON, hiddenProjects: [], unhiddenProjects: [], myProjects });

// Seven recent projects (only five get pre-ticked), one at 20 days (not pre-ticked), two older than 30 days, one hidden.
const PROJECTS = [
  ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => project(`/work/${n}`, i * 0.5)),
  project('/work/twenty', 20), project('/work/old1', 40), project('/work/old2', 90), project('/tmp/ak-1', 1, { hidden: 'auto' }),
];

function seeded(mine: string[] | null, history: HistoryChat[] = []): Store {
  const s = applySnapshot(initialState(), { chats: [], usage: [], suggested: null, connections: [], history, projects: PROJECTS, settings: settings(mine) });
  return createStore({ ...s, now: NOW });
}
const mount = (store: Store) => render(<StoreProvider store={store}><Sidebar /><PickProjectsDialog /></StoreProvider>);
const dialog = () => screen.getByRole('dialog', { name: 'Which projects do you work on?' });
const tile = (name: string) => within(dialog()).getByRole('checkbox', { name: new RegExp(`^${name}\\b`) });
const ticked = () => within(dialog()).queryAllByRole('checkbox').filter((t) => t.getAttribute('aria-checked') === 'true').map((t) => t.getAttribute('aria-label')!.split(',')[0]);

beforeEach(() => { patchSettings.mockReset(); patchSettings.mockImplementation(async (p: Partial<Settings>) => ({ ...settings(null), ...p })); });
afterEach(cleanup);

describe('Picking My projects', () => {
  it('pre-ticks at most 5 projects active in the last 14 days, newest first; hidden ones are never offered', () => {
    expect(defaultPicks(PROJECTS, NOW)).toEqual(['/work/a', '/work/b', '/work/c', '/work/d', '/work/e']);
  });

  it('the pick card opens the picker with recent projects as tiles and older ones folded away', () => {
    mount(seeded(null));
    fireEvent.click(screen.getByRole('button', { name: 'Pick projects' }));
    expect(ticked()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(within(dialog()).queryByRole('checkbox', { name: /^old1/ })).toBeNull();
    expect(within(dialog()).queryByRole('checkbox', { name: /^ak-1/ })).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Older · no activity in 30 days (2)' }));
    expect(tile('old1')).toBeTruthy();
  });

  it('search filters projects by name and looks in the older ones too', () => {
    mount(seeded(null));
    fireEvent.click(screen.getByRole('button', { name: 'Pick projects' }));
    fireEvent.change(within(dialog()).getByRole('searchbox'), { target: { value: 'old2' } });
    expect(within(dialog()).getAllByRole('checkbox').map((t) => t.getAttribute('aria-label')!.split(',')[0])).toEqual(['old2']);
  });

  it('Save writes the ticked folders to My projects', async () => {
    const store = seeded(null);
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Pick projects' }));
    fireEvent.click(tile('a'));
    fireEvent.click(tile('twenty'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ myProjects: ['/work/b', '/work/c', '/work/d', '/work/e', '/work/twenty'] }));
    await waitFor(() => expect(store.getState().ui.pickProjects).toBe(false));
    expect(store.getState().settings?.myProjects).toEqual(['/work/b', '/work/c', '/work/d', '/work/e', '/work/twenty']);
  });

  it('Edit opens the picker with the current My projects ticked', () => {
    mount(seeded(['/work/f', '/work/old1']));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(ticked()).toEqual(['f', 'old1']);
  });

  it('Cancel changes nothing', () => {
    const store = seeded(['/work/f']);
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(tile('a'));
    act(() => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' })); });
    expect(patchSettings).not.toHaveBeenCalled();
    expect(store.getState().ui.pickProjects).toBe(false);
  });
});

describe('Managing My projects', () => {
  const hist = (cwd: string, hoursAgo: number): HistoryChat => ({ provider: 'claude', sessionRef: `h-${cwd}`, title: 'Outside chat', cwd, updatedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString() });

  it("a card's Remove takes the project out of My projects", async () => {
    mount(seeded(['/work/a', '/work/b']));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a from My projects' }));
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ myProjects: ['/work/b'] }));
  });

  it('outside activity in a project not in My projects shows "New activity · Add"; Add adds it, Dismiss hides it', async () => {
    const view = mount(seeded(['/work/a'], [hist('/work/c', 2), hist('/work/old1', 3), hist('/work/d', 30)]));
    // c (2h ago) and old1 (3h ago) had outside activity in the last day; d's is too old. The newest shows.
    expect(screen.getByText(/New activity in/).textContent).toBe('New activity in c');
    fireEvent.click(screen.getByRole('button', { name: 'Add c to My projects' }));
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ myProjects: ['/work/a', '/work/c'] }));
    view.unmount();
    mount(seeded(['/work/a'], [hist('/work/c', 2)]));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss new activity in c' }));
    expect(screen.queryByText(/New activity in/)).toBeNull();
  });

  it('no hint before the user has picked (the pick card asks instead)', () => {
    mount(seeded(null, [hist('/work/c', 2)]));
    expect(screen.queryByText(/New activity in/)).toBeNull();
  });

  it('the star adds a project to My projects and takes it out again', async () => {
    const store = seeded(['/work/a']);
    render(<StoreProvider store={store}><StarButton project={PROJECTS[1]!} /><StarButton project={PROJECTS[0]!} /></StoreProvider>);
    const add = screen.getByRole('button', { name: 'Add b to My projects' });
    expect(add.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(add);
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ myProjects: ['/work/a', '/work/b'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a from My projects' }));
    await waitFor(() => expect(patchSettings).toHaveBeenLastCalledWith({ myProjects: ['/work/b'] }));
  });

  it('starting a chat adds its project, unless the user has never picked or it is there already', async () => {
    addAfterStart(seeded(['/work/a']), '/work/g');
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ myProjects: ['/work/a', '/work/g'] }));
    patchSettings.mockClear();
    addAfterStart(seeded(['/work/a']), '/work/a/');
    addAfterStart(seeded(null), '/work/g');
    await new Promise((r) => setTimeout(r, 10));
    expect(patchSettings).not.toHaveBeenCalled();
  });
});
