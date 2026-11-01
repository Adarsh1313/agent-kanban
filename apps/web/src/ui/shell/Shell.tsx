import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AppState } from '../../state/reducer.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { closePanelIn } from '../../state/reducer.ts';
import { openFilter, openNewChat } from '../actions.ts';
import { Board } from '../board/Board.tsx';
import { ConnectionsPage } from '../connections/ConnectionsPage.tsx';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { FilterBar } from '../filters/FilterBar.tsx';
import { NewChatDialog } from '../newchat/NewChatDialog.tsx';
import { PickProjectsDialog } from '../myprojects/PickProjects.tsx';
import { SearchPalette } from '../search/SearchPalette.tsx';
import { ProjectsPage } from '../projects/ProjectsPage.tsx';
import { AllChatsPage } from '../chats/AllChatsPage.tsx';
import { RoutineEditor, RoutinesPage } from '../routines/RoutinesPage.tsx';
import { hasOpenLayer } from '../primitives/layers.ts';
import { Toasts } from '../primitives/index.ts';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';
import { parseHash } from './route.ts';
import { applySavedTheme } from './theme.ts';

const UNAUTHORIZED_TEXT = 'The server restarted. Open Agent Kanban again from the link it printed.';
const CLOCK_MS = 30_000;

const NO_TOKEN_TEXT = 'Open Agent Kanban from the link the server printed.';

const bannerText = (socket: AppState['socket']): string | null => {
  switch (socket) {
    case 'live':
    case 'connecting': return null;
    case 'reconnecting': return 'Reconnecting…';
    case 'no_token': return NO_TOKEN_TEXT;
    case 'unauthorized': return UNAUTHORIZED_TEXT;
  }
};

/** `ui.view` / `ui.projectId` follow the address-bar hash. */
function useHashRoute(store: Store) {
  useLayoutEffect(() => {
    const sync = () => {
      const r = parseHash(location.hash);
      store.setState((s) => {
        if (s.ui.view === r.view && s.ui.projectId === r.projectId) return s;
        // Switching pages closes an open chat panel, so it never covers Connections or Projects (#8).
        const base = s.ui.view !== r.view ? closePanelIn(s) : s;
        return { ...base, ui: { ...base.ui, view: r.view, projectId: r.projectId } };
      });
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [store]);
}

/** Bumps `now` so snoozed chats come back (and "Resets 2:40 pm" style text stays fresh) without any event arriving. */
function useClock(store: Store) {
  useEffect(() => {
    const id = setInterval(() => store.setState((s) => ({ ...s, now: Date.now() })), CLOCK_MS);
    return () => clearInterval(id);
  }, [store]);
}

function useShortcuts(store: Store) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Nothing opens before the first load: onboarding may still need to come first (#5).
      if (e.ctrlKey || e.metaKey || e.altKey || hasOpenLayer() || !store.getState().loaded) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openNewChat();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        openFilter();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store]);
}

export function Shell() {
  const store = useStoreInstance();
  const view = useStore((s) => s.ui.view);
  const socket = useStore((s) => s.socket);
  const prevView = useRef(view);
  const entering = prevView.current !== view;
  useEffect(() => { prevView.current = view; });

  useHashRoute(store);
  useClock(store);
  useShortcuts(store);
  const loaded = useStore((s) => s.loaded);
  useEffect(() => applySavedTheme(), []);

  const banner = bannerText(socket);
  return (
    <>
      <a className="skip" href="#/board" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to the content</a>
      {/* Until the first load the app is hidden and inert: no empty board to click, and onboarding (if due) comes first (#5). */}
      {!loaded && <p className="app-loading" role="status">{banner ?? 'Loading your chats…'}</p>}
      <div className="app" data-loading={!loaded || undefined} inert={!loaded || undefined}>
        <Sidebar />
        <div className="main">
          <TopBar />
          {banner && <p className="conn-banner" role="status" data-state={socket}>{banner}</p>}
          <main className={`view main-view${entering ? ' entering' : ''}`} key={view} id="main" tabIndex={-1} data-view={view}>
            {view === 'board' && <><FilterBar /><Board /></>}
            {view === 'chats' && <AllChatsPage />}
            {view === 'projects' && <ProjectsPage />}
            {view === 'routines' && <RoutinesPage />}
            {view === 'connections' && <ConnectionsPage />}
          </main>
        </div>
      </div>
      <ChatPanel />
      <NewChatDialog />
      <RoutineEditor />
      <PickProjectsDialog />
      <SearchPalette />
      <Toasts />
    </>
  );
}
