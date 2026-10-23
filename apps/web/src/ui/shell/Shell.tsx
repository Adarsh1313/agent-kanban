import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AppState } from '../../state/reducer.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { openNewChat } from '../actions.ts';
import { Board } from '../board/Board.tsx';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { hasOpenLayer } from '../primitives/layers.ts';
import { Toasts } from '../primitives/index.ts';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';
import { parseHash } from './route.ts';
import { applySavedTheme } from './theme.ts';

const UNAUTHORIZED_TEXT = 'The server restarted. Open Agent Kanban again from the link it printed.';
const CLOCK_MS = 30_000;

const bannerText = (socket: AppState['socket']) =>
  socket === 'live' ? null : socket === 'reconnecting' ? 'Reconnecting…' : UNAUTHORIZED_TEXT;

/** `ui.view` / `ui.projectId` follow the address-bar hash. */
function useHashRoute(store: Store) {
  useLayoutEffect(() => {
    const sync = () => {
      const r = parseHash(location.hash);
      store.setState((s) => (s.ui.view === r.view && s.ui.projectId === r.projectId ? s : { ...s, ui: { ...s.ui, view: r.view, projectId: r.projectId } }));
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

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || hasOpenLayer()) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openNewChat();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

const Placeholder = ({ title }: { title: string }) => (
  <div className="placeholder"><h2>{title}</h2><p>This page is on its way.</p></div>
);

export function Shell() {
  const store = useStoreInstance();
  const view = useStore((s) => s.ui.view);
  const socket = useStore((s) => s.socket);
  const prevView = useRef(view);
  const entering = prevView.current !== view;
  useEffect(() => { prevView.current = view; });

  useHashRoute(store);
  useClock(store);
  useShortcuts();
  useEffect(() => applySavedTheme(), []);

  const banner = bannerText(socket);
  return (
    <>
      <a className="skip" href="#/board" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to the content</a>
      <div className="app">
        <Sidebar />
        <div className="main">
          <TopBar />
          {banner && <p className="conn-banner" role="status" data-state={socket}>{banner}</p>}
          <main className={`view main-view${entering ? ' entering' : ''}`} key={view} id="main" tabIndex={-1} data-view={view}>
            {view === 'board' && <Board />}
            {view === 'projects' && <Placeholder title="Projects" />}
            {view === 'connections' && <Placeholder title="Connections" />}
          </main>
        </div>
      </div>
      <ChatPanel />
      <Toasts />
    </>
  );
}
