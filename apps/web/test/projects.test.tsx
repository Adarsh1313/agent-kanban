import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Chat, HistoryChat, Project, ProjectInfo, ProviderId } from '@agent-kanban/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.ts';
import { applySnapshot, initialState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { setHistoryHandler, setNewChatHandler } from '../src/ui/actions.ts';
import { Toasts } from '../src/ui/primitives/toast.tsx';
import { ProjectsPage, resetProjectsVisit } from '../src/ui/projects/ProjectsPage.tsx';
import { folderKey, resetProjectInfoCache } from '../src/ui/projects/model.ts';
import { chat } from './helpers.ts';

vi.mock('../src/api/client.ts', async (orig) => {
  const m = await orig<typeof import('../src/api/client.ts')>();
  return { ...m, api: { ...m.api, projectInfo: vi.fn() } };
});
const mocked = api as unknown as { projectInfo: ReturnType<typeof vi.fn> };

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const project = (id: string, providers: ProviderId[], lastActivityAt = ago(60)): Project => ({
  id, name: id.split(/[\\/]/).pop()!, path: id,
  providers: providers.map((provider) => ({ provider, chats: 1, lastUsedAt: lastActivityAt, lastModel: null })),
  columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt,
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
    let took = Infinity;
    for (let i = 0; i < 3; i++) {
      cleanup();
      const t0 = performance.now();
      mount(store);
      took = Math.min(took, performance.now() - t0);
    }
    expect(rows()).toHaveLength(80);
    // ~175 ms alone in jsdom; the bound leaves room for a loaded machine running every suite at once.
    expect(took).toBeLessThan(1000);
    expect(mocked.projectInfo).not.toHaveBeenCalled();
  });

  it('rows rise in on the first visit only', () => {
    const store = seeded([ALPHA, BETA]);
    mount(store);
    expect(rows()[0]!.classList.contains('stagger')).toBe(true);
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
