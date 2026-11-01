import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat, HistoryChat, Project, ProjectInfo, ProviderId, Settings } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { setHistoryHandler, setNewChatHandler } from '../src/ui/actions.ts';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { ProjectsPage, resetProjectsVisit } from '../src/ui/projects/ProjectsPage.tsx';
import { chatsByFolder, folderKey, resetProjectInfoCache } from '../src/ui/projects/model.ts';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, projectInfo: vi.fn(), patchSettings: vi.fn(), projects: vi.fn(), settings: vi.fn(), setNotes: vi.fn(), notes: vi.fn(), saveNotes: vi.fn() } };
});
const mocked = api as unknown as Record<'projectInfo' | 'patchSettings' | 'projects' | 'settings' | 'setNotes' | 'notes' | 'saveNotes', ReturnType<typeof vi.fn>>;

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const project = (id: string, providers: ProviderId[], lastActivityAt = ago(60)): Project => ({
  id, name: id.split(/[\\/]/).pop()!, path: id,
  providers: providers.map((provider) => ({ provider, chats: 1, lastUsedAt: lastActivityAt, lastModel: null })),
  columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt, hidden: null, folderMissing: false,
});
const hist = (over: Partial<HistoryChat> = {}): HistoryChat => ({ provider: 'codex', sessionRef: 'h1', title: 'Old idea', cwd: '/work/beta', updatedAt: ago(3000), ...over });

const INFO: ProjectInfo = {
  stack: ['TypeScript', 'Vite'],
  git: { branch: 'feat/heatmap', lastCommit: 'Add replay timeline scrubber', lastCommitAt: ago(120) },
  instructionFiles: { claude: true, codex: false, antigravity: false },
  topFolders: ['data', 'public', 'src'],
};

function seeded(projects: Project[], chats: Chat[] = [], history: HistoryChat[] = [], projectId: string | null = null): Store {
  const s = applySnapshot(initialState(), { chats, usage: [], suggested: null, connections: [], history, projects });
  return createStore({ ...s, now: NOW, ui: { ...s.ui, view: 'projects', projectId } });
}
const mount = (store: Store) => render(<StoreProvider store={store}><ProjectsPage /><Toasts /></StoreProvider>);
const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('a.prow')];
const rowNames = () => rows().map((r) => r.querySelector('b')!.textContent);
/** jsdom has no AnimationEvent, so React listens for the prefixed name there (browsers fire animationend). */
const animationEnd = (el: Element) => fireEvent(el, new Event('webkitAnimationEnd', { bubbles: true }));
const go = (store: Store, projectId: string | null) => act(() => store.setState((s) => ({ ...s, ui: { ...s.ui, projectId } })));

const ALPHA = project('/work/alpha', ['claude'], ago(5));
const BETA = project('/work/beta', ['claude', 'codex'], ago(600));
const ZED = project('/srv/zed-tools', ['codex'], ago(30));

beforeEach(() => {
  mocked.projectInfo.mockReset();
  mocked.projectInfo.mockResolvedValue(INFO);
  resetProjectInfoCache();
  resetProjectsVisit();
});
afterEach(() => {
  cleanup();
  setNewChatHandler(null);
  setHistoryHandler(null);
});

describe('Projects list', () => {
  it('lists every project, newest activity first, as links to their page; never asks for folder info', () => {
    mount(seeded([BETA, ALPHA, ZED], [chat({ id: 'a', cwd: '/work/alpha', updatedAt: ago(5) })]));
    expect(screen.getByRole('heading', { name: /Projects/ }).textContent).toContain('3');
    expect(rowNames()).toEqual(['alpha', 'zed-tools', 'beta']);
    expect(rows()[0]!.getAttribute('href')).toBe(`#/projects/${encodeURIComponent('/work/alpha')}`);
    expect(rows()[0]!.textContent).toContain('5m ago');
    expect(mocked.projectInfo).not.toHaveBeenCalled();
  });

  it('sorts by name, and back by last activity', () => {
    mount(seeded([BETA, ALPHA, ZED]));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by project' }));
    expect(rowNames()).toEqual(['alpha', 'beta', 'zed-tools']);
    expect(screen.getByRole('button', { name: 'Sort by project' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by last activity' }));
    expect(rowNames()).toEqual(['alpha', 'zed-tools', 'beta']);
  });

  it('search matches name or path, case-insensitively; no match shows the empty state with Clear search', () => {
    mount(seeded([BETA, ALPHA, ZED]));
    const box = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.change(box, { target: { value: 'ZED' } });
    expect(rowNames()).toEqual(['zed-tools']);
    fireEvent.change(box, { target: { value: '/WORK/' } });
    expect(rowNames()).toEqual(['alpha', 'beta']);
    fireEvent.change(box, { target: { value: 'nothing-here' } });
    expect(rows()).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'No projects match “nothing-here”' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(rows()).toHaveLength(3);
  });

  it('the same folder spelled differently is one row, counted once', () => {
    const a = project('C:\\Users\\me\\app', ['claude'], ago(5));
    const b = { ...project('C:/Users/me/app/', ['codex'], ago(1)), name: 'app-dup' };
    const c = { ...project('c:\\users\\ME\\app', ['codex'], ago(2)), name: 'app-dup2' };
    mount(seeded([a, b, c, BETA], [chat({ id: 'x', cwd: 'C:/Users/me/app' })]));
    expect(rowNames()).toEqual(['app', 'beta']);
    expect(screen.getByRole('heading', { name: /Projects/ }).textContent).toContain('2');
    expect(rows()[0]!.querySelector('.legend')!.textContent).toBe('1 working');
    expect(screen.getByRole('list', { name: 'Projects' }).querySelectorAll('li')).toHaveLength(2);
  });

  it('with no projects shows the empty state', () => {
    mount(seeded([]));
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeTruthy();
  });

  it('the status bar counts working / need you / to review from the live chats; a quiet project says so', () => {
    const chats = [
      chat({ id: 'r', cwd: '/work/alpha', column: 'running' }),
      chat({ id: 'n', cwd: '/work/alpha', column: 'needs_you', needsReason: 'question', sessionRef: 's2' }),
      chat({ id: 'v', cwd: '/work/alpha', column: 'review', sessionRef: 's3' }),
      chat({ id: 'v2', cwd: '/work/alpha', column: 'review', sessionRef: 's4' }),
      chat({ id: 'x', cwd: '/work/alpha', column: 'running', archived: true, sessionRef: 's5' }),
    ];
    mount(seeded([ALPHA, BETA], chats, [hist(), hist({ sessionRef: 'h2', provider: 'claude' })]));
    const alpha = rows().find((r) => r.textContent!.includes('alpha'))!;
    const legend = alpha.querySelector('.legend')!.textContent;
    expect(legend).toContain('1 working');
    expect(legend).toContain('1 need you');
    expect(legend).toContain('2 to review');
    expect(alpha.querySelectorAll('.bar i')).toHaveLength(3);
    const beta = rows().find((r) => r.textContent!.includes('beta'))!;
    expect(beta.querySelector('.legend')!.textContent).toBe('2 chats, all quiet');
    // Who has worked there, with chat counts (history included)
    expect([...beta.querySelectorAll('.who-knows .p')].map((p) => p.textContent)).toEqual(['1', '1']);
  });

  it('77+ projects with 1 200 history chats render quickly', () => {
    const projects = Array.from({ length: 80 }, (_, i) => project(`/work/p${i}`, ['claude', 'codex'], ago(i)));
    const history = Array.from({ length: 1200 }, (_, i) => hist({ sessionRef: `h${i}`, cwd: `/work/p${i % 80}`, provider: i % 2 ? 'codex' : 'claude', updatedAt: ago(i) }));
    const store = seeded(projects, [], history);
    const t0 = performance.now();
    mount(store); // cold: the chat index is built during this mount
    const took = performance.now() - t0;
    expect(rows()).toHaveLength(80);
    // ~200 ms locally; the budget leaves room for a loaded CI machine and still catches a quadratic regression.
    expect(took).toBeLessThan(3000);
    expect(mocked.projectInfo).not.toHaveBeenCalled();
    // An unrelated change (a panel opening, a usage reading) reuses the index instead of regrouping 1 200 chats.
    const before = chatsByFolder(store.getState());
    act(() => store.setState((s) => ({ ...s, usage: {}, ui: { ...s.ui, openChatId: 'x' } })));
    expect(chatsByFolder(store.getState())).toBe(before);
  });

  it('rows rise in on the first visit only; a store update does not cut the rise short, the last row ending it does', () => {
    const store = seeded([ALPHA, BETA]);
    mount(store);
    expect(rows()[0]!.classList.contains('stagger')).toBe(true);
    act(() => store.setState((s) => ({ ...s, now: s.now + 30_000 })));
    expect(rows()[0]!.classList.contains('stagger')).toBe(true);
    // An animation inside the last row (bubbling up) is not the row's own rise.
    animationEnd(rows()[1]!.firstElementChild!);
    expect(rows()[0]!.classList.contains('stagger')).toBe(true);
    animationEnd(rows()[1]!);
    expect(rows()[0]!.classList.contains('stagger')).toBe(false);
    cleanup();
    mount(store);
    expect(rows()[0]!.classList.contains('stagger')).toBe(false);
  });
});

describe('Project detail', () => {
  it('an unknown project shows "Project not found" with a link back', () => {
    mount(seeded([ALPHA], [], [], '/work/gone'));
    expect(screen.getByRole('heading', { name: 'Project not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /All projects/ }).getAttribute('href')).toBe('#/projects');
  });

  it('a folder with a board chat but not yet in the project list still has a page (no "Project not found")', () => {
    mount(seeded([ALPHA], [chat({ id: 'n', cwd: '/work/new-one', title: 'Fresh chat' })], [], '/work/new-one'));
    expect(screen.queryByRole('heading', { name: 'Project not found' })).toBeNull();
    expect(screen.getByRole('heading', { name: /new-one/ })).toBeTruthy();
    expect(screen.getByText('Fresh chat')).toBeTruthy();
  });

  it('the chat list is a list: one item per chat', () => {
    mount(seeded([ALPHA], [chat({ id: 'a', cwd: '/work/alpha' }), chat({ id: 'b', sessionRef: 's2', cwd: '/work/alpha' })], [], '/work/alpha'));
    const list = document.querySelector('.chat-list ul')!;
    expect(list).toBeTruthy();
    expect(within(list as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
  });

  it('finds the project however the route spells its folder', () => {
    const win = project('C:\\Users\\me\\open-project', ['claude']);
    expect(folderKey('c:/Users/ME/open-project/')).toBe(folderKey(win.id));
    mount(seeded([win], [], [], 'c:\\users\\me\\open-project'));
    expect(screen.getByRole('heading', { name: /open-project/ })).toBeTruthy();
  });

  it('provider cards: dashed for providers that have not worked there; "New Codex chat" opens New chat on that folder and provider', () => {
    const newChat = vi.fn();
    setNewChatHandler(newChat);
    mount(seeded([BETA], [chat({ id: 'a', cwd: '/work/beta', model: 'opus', updatedAt: ago(10) })], [hist()], '/work/beta'));
    const cards = [...document.querySelectorAll('.know')];
    expect(cards).toHaveLength(3);
    expect(cards[2]!.classList.contains('off')).toBe(true);
    expect(cards[2]!.textContent).toContain('Hasn’t worked in this project yet.');
    expect(cards[0]!.textContent).toContain('1 chat');
    expect(cards[0]!.textContent).toContain('Last used 10m ago · opus');
    fireEvent.click(screen.getByRole('button', { name: 'New Codex chat' }));
    expect(newChat).toHaveBeenLastCalledWith({ cwd: '/work/beta', provider: 'codex' });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(newChat).toHaveBeenLastCalledWith({ cwd: '/work/beta' });
  });

  it('a project Antigravity worked in offers an enabled "New Antigravity chat"', () => {
    const newChat = vi.fn();
    setNewChatHandler(newChat);
    const GAMMA = project('/work/gamma', ['antigravity'], ago(20));
    mount(seeded([GAMMA], [], [], '/work/gamma'));
    const btn = screen.getByRole('button', { name: 'New Antigravity chat' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(newChat).toHaveBeenLastCalledWith({ cwd: '/work/gamma', provider: 'antigravity' });
  });

  it('"worked with" comes from the live chats; the server list only when the folder has none', () => {
    // The server says Codex worked here, but no Codex chat is left (archived): no "0 chats" card.
    mount(seeded([BETA], [chat({ id: 'a', cwd: '/work/beta' }), chat({ id: 'b', cwd: '/work/beta', provider: 'codex', sessionRef: 's9', archived: true })], [], '/work/beta'));
    let cards = [...document.querySelectorAll('.know')];
    expect(cards[0]!.classList.contains('off')).toBe(false);
    expect(cards[1]!.classList.contains('off')).toBe(true);
    expect(document.body.textContent).not.toContain('0 chats');
    cleanup();
    mount(seeded([BETA], [], [], '/work/beta'));
    cards = [...document.querySelectorAll('.know')];
    expect(cards.map((c) => c.classList.contains('off'))).toEqual([false, false, true]);
  });

  it('breadcrumb is a nav with the project as the current page; "Show N more" focuses the first revealed row', () => {
    const many = Array.from({ length: 55 }, (_, i) => hist({ sessionRef: `h${i}`, title: `Chat ${i}`, updatedAt: ago(i + 1) }));
    mount(seeded([BETA], [], many, '/work/beta'));
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('beta');
    expect(document.querySelectorAll('.crow')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }));
    expect(document.querySelectorAll('.crow')).toHaveLength(55);
    expect(document.activeElement).toBe(document.querySelectorAll('.crow')[50]);
    expect(document.activeElement!.textContent).toContain('Chat 50');
  });

  it('the page slide is latched: a store update keeps it, its animationend clears it', () => {
    const store = seeded([BETA]);
    mount(store);
    go(store, '/work/beta');
    const page = () => document.querySelector<HTMLElement>('.projects-page')!;
    expect(page().classList.contains('entering')).toBe(true);
    act(() => store.setState((s) => ({ ...s, now: s.now + 30_000 })));
    expect(page().classList.contains('entering')).toBe(true);
    animationEnd(page());
    expect(page().classList.contains('entering')).toBe(false);
    go(store, null);
    expect(page().className).toContain('entering from-left');
  });

  it('chats: needs-you first; a board chat opens in the panel, a history chat through openHistoryChat; the provider filter narrows the list', async () => {
    const openHistory = vi.fn();
    setHistoryHandler(openHistory);
    const store = seeded([BETA], [
      chat({ id: 'd', title: 'Finished work', cwd: '/work/beta', column: 'done', updatedAt: ago(1) }),
      chat({ id: 'n', title: 'Needs an answer', cwd: '/work/beta', column: 'needs_you', needsReason: 'question', sessionRef: 's2', updatedAt: ago(50) }),
    ], [hist()], '/work/beta');
    mount(store);
    const list = () => [...document.querySelectorAll('.crow .t')].map((t) => t.textContent);
    expect(list()).toEqual(['Needs an answer', 'Finished work', 'Old idea']);
    expect(screen.getByText('Asked you a question')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Finished work/ }));
    expect(store.getState().ui.openChatId).toBe('d');
    fireEvent.keyDown(screen.getByRole('button', { name: /Old idea/ }), { key: 'Enter' });
    expect(openHistory).toHaveBeenCalledWith({ provider: 'codex', sessionRef: 'h1', cwd: '/work/beta', title: 'Old idea' });

    const seg = screen.getByRole('group', { name: 'Show chats from' });
    expect(within(seg).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Claude Code', 'Codex']);
    fireEvent.click(within(seg).getByRole('button', { name: 'Codex' }));
    expect(within(seg).getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(list()).toEqual(['Old idea']));
  });

  it('About shows a skeleton, then the folder info; it is fetched once per path', async () => {
    const store = seeded([BETA, ALPHA], [], [], '/work/beta');
    mount(store);
    const about = () => screen.getByRole('complementary', { name: 'About this project' });
    expect(about().getAttribute('aria-busy')).toBe('true');
    expect(about().querySelectorAll('.skel').length).toBeGreaterThan(0);
    await waitFor(() => expect(within(about()).getByText('feat/heatmap')).toBeTruthy());
    expect(about().textContent).toContain('TypeScript');
    expect(about().textContent).toContain('Add replay timeline scrubber · 2h ago');
    const lines = [...about().querySelectorAll('.file-line')].map((l) => l.textContent);
    expect(lines).toEqual(['CLAUDE.mdFound', 'AGENTS.mdNot in this folder', 'GEMINI.mdNot in this folder']);
    expect(about().querySelector('.tree')!.textContent).toContain('src/');
    expect(mocked.projectInfo).toHaveBeenCalledTimes(1);
    expect(mocked.projectInfo).toHaveBeenCalledWith('/work/beta');

    go(store, null);
    go(store, '/work/beta');
    expect(within(about()).getByText('feat/heatmap')).toBeTruthy(); // cached: no skeleton
    expect(mocked.projectInfo).toHaveBeenCalledTimes(1);
  });

  it('About shows the server error inline with Retry', async () => {
    mocked.projectInfo.mockRejectedValueOnce(new ApiError('That folder doesn’t exist.', 400));
    mount(seeded([BETA], [], [], '/work/beta'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('That folder doesn’t exist.'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('feat/heatmap')).toBeTruthy());
    expect(mocked.projectInfo).toHaveBeenCalledTimes(2);
  });

  it('Copy path copies the location and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(seeded([BETA], [], [], '/work/beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/work/beta');
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    await waitFor(() => expect(screen.getByText('Couldn’t copy')).toBeTruthy());
  });
});

describe('Projects: hidden and folder missing', () => {
  const ON = { claude: true, codex: true, antigravity: true };
  const settings = (over: Partial<Settings> = {}): Settings => ({ onboarded: true, showChats: ON, suggest: ON, hiddenProjects: [], unhiddenProjects: [], suggestNextSteps: true, myProjects: null, ...over });
  const TEMP = { ...project('/tmp/ak-claude-1', ['claude'], ago(10)), hidden: 'auto' as const, tempFolder: true };
  const OLD = { ...project('/work/old', ['codex'], ago(20)), hidden: 'manual' as const };
  const withSettings = (store: Store, st: Settings) => { store.setState((s) => ({ ...s, settings: st })); return store; };
  const showHidden = () => fireEvent.click(screen.getByRole('switch', { name: 'Show hidden projects' }));

  beforeEach(() => {
    mocked.patchSettings.mockReset();
    mocked.settings.mockReset();
    mocked.projects.mockReset();
    mocked.projects.mockResolvedValue([]);
  });

  it('leaves hidden projects out until "Show hidden projects" is on, then shows them dimmed with Unhide', () => {
    mount(withSettings(seeded([ALPHA, TEMP, OLD]), settings({ hiddenProjects: ['/work/old'] })));
    expect(rowNames()).toEqual(['alpha']);
    expect(screen.getByRole('heading', { name: /Projects/ }).textContent).toBe('Projects 1');
    showHidden();
    expect(rowNames()).toEqual(['alpha', 'ak-claude-1', 'old']);
    const dimmed = rows().filter((r) => r.closest('li')!.classList.contains('hidden-project')).map((r) => r.querySelector('b')!.textContent);
    expect(dimmed).toEqual(['ak-claude-1', 'old']);
    expect(screen.getAllByRole('button', { name: /^Unhide/ })).toHaveLength(2);
  });

  it('Unhide on a hand-hidden project removes it from hiddenProjects; on an auto-hidden one adds it to unhiddenProjects', async () => {
    const store = withSettings(seeded([ALPHA, TEMP, OLD]), settings({ hiddenProjects: ['/work/old'] }));
    mount(store);
    showHidden();
    mocked.projects.mockResolvedValue([ALPHA, TEMP, { ...OLD, hidden: null }]);
    mocked.patchSettings.mockResolvedValueOnce(settings());
    fireEvent.click(screen.getByRole('button', { name: 'Unhide old' }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ hiddenProjects: [], unhiddenProjects: [] }));
    await waitFor(() => expect(store.getState().settings?.hiddenProjects).toEqual([]));
    expect(mocked.projects).toHaveBeenCalled();
    mocked.patchSettings.mockResolvedValueOnce(settings({ unhiddenProjects: ['/tmp/ak-claude-1'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Unhide ak-claude-1' }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenLastCalledWith({ hiddenProjects: [], unhiddenProjects: ['/tmp/ak-claude-1'] }));
  });

  it('Unhide on a temp-folder project the user also hid by hand shows it again (not back to auto-hidden)', async () => {
    const both = { ...TEMP, hidden: 'manual' as const };
    const store = withSettings(seeded([ALPHA, both], [], [], both.id), settings({ hiddenProjects: ['/tmp/ak-claude-1'] }));
    mount(store);
    mocked.patchSettings.mockResolvedValueOnce(settings({ unhiddenProjects: ['/tmp/ak-claude-1'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Unhide' }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ hiddenProjects: [], unhiddenProjects: ['/tmp/ak-claude-1'] }));
  });

  it('Hide project before settings have loaded reads them first, so the saved lists are kept', async () => {
    const store = seeded([ALPHA, ZED], [], [], ALPHA.id);
    mount(store);
    mocked.settings.mockResolvedValueOnce(settings({ hiddenProjects: ['/work/old'] }));
    mocked.patchSettings.mockResolvedValueOnce(settings({ hiddenProjects: ['/work/old', '/work/alpha'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide project' }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ hiddenProjects: ['/work/old', '/work/alpha'], unhiddenProjects: [] }));
  });

  it("Hide project on a project's page hides it and goes back to the list", async () => {
    const store = withSettings(seeded([ALPHA, ZED], [], [], ALPHA.id), settings({ unhiddenProjects: ['/work/alpha'] }));
    mount(store);
    mocked.patchSettings.mockResolvedValueOnce(settings({ hiddenProjects: ['/work/alpha'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide project' }));
    await waitFor(() => expect(mocked.patchSettings).toHaveBeenCalledWith({ hiddenProjects: ['/work/alpha'], unhiddenProjects: [] }));
    await waitFor(() => expect(location.hash).toBe('#/projects'));
  });

  it("a hidden project's page says it is hidden and offers Unhide instead of Hide", () => {
    mount(withSettings(seeded([ALPHA, OLD], [], [], OLD.id), settings({ hiddenProjects: ['/work/old'] })));
    expect(screen.getByText(/Hidden from the sidebar, the board and New chat/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unhide' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hide project' })).toBeNull();
  });

  it('a project whose folder is gone says "Folder missing", keeps its chats readable and can’t start a new chat', () => {
    const gone = { ...project('/work/gone', ['codex'], ago(5)), folderMissing: true };
    const store = seeded([ALPHA, gone], [], [hist({ cwd: '/work/gone', title: 'Still readable' })]);
    mount(store);
    const row = rows().find((r) => r.querySelector('b')!.textContent === 'gone')!;
    expect(within(row).getByText('Folder missing')).toBeTruthy();
    go(store, gone.id);
    expect(screen.getByText(/Folder missing/)).toBeTruthy();
    expect(screen.getByText('Still readable')).toBeTruthy();
    expect((screen.getByRole('button', { name: /New chat/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'New Codex chat' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the Claude scratch chats project lists the chats from all its scratch folders", () => {
    const root = 'C:/Users/me/AppData/Roaming/Claude/scratch-workspaces';
    const scratch = { ...project(root, ['claude'], ago(5)), name: 'Claude scratch chats' };
    const store = seeded([scratch], [], [
      hist({ provider: 'claude', sessionRef: 'a', cwd: `${root}/u1/scratch-aa`, title: 'Regex for dates' }),
      hist({ provider: 'claude', sessionRef: 'b', cwd: `${root}/u2/scratch-bb`, title: 'Explain zstd' }),
    ], root);
    mount(store);
    expect(screen.getByText('Regex for dates')).toBeTruthy();
    expect(screen.getByText('Explain zstd')).toBeTruthy();
  });
});

describe('Projects: project notes (#40)', () => {
  const ON = { claude: true, codex: true, antigravity: true };
  const st = (notesProjects: string[]): Settings => ({ onboarded: true, showChats: ON, suggest: ON, hiddenProjects: [], unhiddenProjects: [], suggestNextSteps: true, myProjects: null, notesProjects });
  it('the switch says it adds a file; on shows Open notes, which loads and saves the notes', async () => {
    mocked.projectInfo.mockResolvedValue(INFO);
    mocked.setNotes.mockResolvedValue(st(['/work/alpha']));
    mocked.notes.mockResolvedValue({ text: 'Use pnpm.' });
    mocked.saveNotes.mockResolvedValue({ text: 'x' });
    const store = seeded([ALPHA], [], [], ALPHA.id);
    store.setState((s) => ({ ...s, settings: st([]) }));
    mount(store);
    expect(screen.getByText(/Adds \.agent-kanban\/notes\.md to this folder/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open notes' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Project notes' }));
    await waitFor(() => expect(mocked.setNotes).toHaveBeenCalledWith('/work/alpha', true));
    fireEvent.click(await screen.findByRole('button', { name: 'Open notes' }));
    const box = await screen.findByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('Use pnpm.'));
    fireEvent.change(box, { target: { value: 'Use pnpm. Ship Fridays.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.saveNotes).toHaveBeenCalledWith('/work/alpha', 'Use pnpm. Ship Fridays.'));
  });
});
