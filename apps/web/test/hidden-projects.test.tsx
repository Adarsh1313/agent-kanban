import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HistoryChat, Project, Settings } from '@agent-kanban/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { applySnapshot, initialState, type AppState } from '../src/state/reducer.ts';
import { createStore, StoreProvider, type Store } from '../src/state/store.ts';
import { Sidebar } from '../src/ui/shell/Sidebar.tsx';
import { Board } from '../src/ui/board/Board.tsx';
import { NewChatDialog } from '../src/ui/newchat/NewChatDialog.tsx';
import { openNewChat } from '../src/ui/actions.ts';
import { applySettings } from '../src/state/reducer.ts';
import { chat } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ON = { claude: true, codex: true, antigravity: true };

const project = (path: string, hidden: Project['hidden'] = null): Project => ({
  id: path, name: path.split('/').pop()!, path, providers: [], columns: { running: 0, needs_you: 0, review: 0, done: 0 },
  historyOnly: 0, lastActivityAt: '2026-10-23T10:00:00.000Z', hidden, folderMissing: false,
});
const settings = (hiddenProjects: string[] = []): Settings => ({ onboarded: true, showChats: ON, suggest: ON, hiddenProjects, unhiddenProjects: [], suggestNextSteps: true });
const hist = (cwd: string, sessionRef: string, title: string): HistoryChat => ({ provider: 'codex', sessionRef, title, cwd, updatedAt: '2026-10-23T11:00:00.000Z' });

function seeded(projects: Project[], extra: Partial<AppState> = {}): Store {
  const s = applySnapshot(initialState(), {
    chats: [chat({ id: 'a', title: 'Visible chat', cwd: '/work/alpha' }), chat({ id: 't', sessionRef: 's2', title: 'Temp chat', cwd: '/tmp/ak-claude-1' })],
    usage: [], suggested: null, connections: [], projects, settings: settings(),
    history: [hist('/work/old', 'h1', 'Old history chat')],
  });
  return createStore({ ...s, now: NOW, ...extra });
}
const mount = (store: Store, ui = <Sidebar />) => render(<StoreProvider store={store}>{ui}</StoreProvider>);
const PROJECTS = [project('/work/alpha'), project('/tmp/ak-claude-1', 'auto'), project('/work/old')];

afterEach(cleanup);

describe('Hidden projects', () => {
  it('the sidebar leaves out chats of a hidden project', () => {
    mount(seeded(PROJECTS));
    expect(screen.queryByText('Visible chat')).toBeTruthy();
    expect(screen.queryByText('Old history chat')).toBeTruthy();
    expect(screen.queryByText('Temp chat')).toBeNull();
  });

  it('the board leaves out cards of a hidden project', () => {
    mount(seeded(PROJECTS), <Board />);
    expect(screen.queryByRole('article', { name: 'Visible chat' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Temp chat' })).toBeNull();
  });

  it('hiding a project by hand takes effect at once, from the setting, and Unhide brings it back', () => {
    const store = seeded(PROJECTS);
    mount(store);
    expect(screen.queryByText('Old history chat')).toBeTruthy();
    act(() => store.setState((s) => applySettings(s, settings(['/work/old/']))));
    expect(screen.queryByText('Old history chat')).toBeNull();
    // The server marked it 'manual' meanwhile; the setting (now empty) still wins.
    act(() => store.setState((s) => applySettings({ ...s, projects: [project('/work/alpha'), project('/tmp/ak-claude-1', 'auto'), project('/work/old', 'manual')] }, settings([]))));
    expect(screen.queryByText('Old history chat')).toBeTruthy();
  });

  it('the Projects count in the sidebar leaves out hidden projects', () => {
    mount(seeded(PROJECTS));
    expect(screen.getByRole('button', { name: /^Projects/ }).textContent).toBe('Projects 2');
  });

  it("provider counts leave out a hidden project's chats", () => {
    mount(seeded(PROJECTS));
    // Claude: only "Visible chat" (Temp chat is hidden); Codex: the history chat.
    expect(screen.getByRole('button', { name: /Claude Code/ }).textContent).toContain('1');
  });

  it('New chat does not offer a hidden project', () => {
    mount(seeded(PROJECTS), <NewChatDialog />);
    act(() => openNewChat());
    fireEvent.click(screen.getByRole('button', { name: /^Project:/ }));
    const list = screen.getByRole('listbox', { name: 'Project' });
    expect(within(list).queryByRole('option', { name: /alpha/ })).toBeTruthy();
    expect(within(list).queryByRole('option', { name: /ak-claude-1/ })).toBeNull();
  });
});
