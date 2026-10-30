// Inside the desktop app (docs/specs/desktop-app.md) the preload script puts a bridge on the window. In
// browser mode there is none and nothing here runs.
import type { DesktopBridge, DesktopStatus } from '@agent-kanban/shared';
import { openChatIn, type AppState } from './state/reducer.ts';
import type { Store } from './state/store.ts';

declare global {
  interface Window { agentKanbanDesktop?: DesktopBridge }
}

/** The desktop bridge, or null in browser mode. */
export function desktopBridge(): DesktopBridge | null {
  return typeof window !== 'undefined' && typeof window.agentKanbanDesktop?.status === 'function' ? window.agentKanbanDesktop : null;
}

/** What the tray shows: chats waiting on the user (by title) and how many are working (Quit asks first). */
export function desktopStatus(s: AppState): DesktopStatus {
  const live = Object.values(s.chats).filter((c) => !c.archived);
  return {
    needsYou: live.filter((c) => c.column === 'needs_you').map((c) => ({ id: c.id, title: c.title })),
    running: live.filter((c) => c.column === 'running').length,
  };
}

/** Keeps the desktop app's tray current and opens chats it picks. Returns a stop function. */
export function startDesktopSync(store: Store, bridge: DesktopBridge): () => void {
  let last = '';
  const send = () => {
    const status = desktopStatus(store.getState());
    const key = JSON.stringify(status);
    if (key === last) return;
    last = key;
    bridge.status(status);
  };
  send();
  const unsubscribe = store.subscribe(send);
  const offOpen = bridge.onOpenChat((id) => store.setState((s) => openChatIn(s, id)));
  return () => { unsubscribe(); offOpen(); };
}

/** The theme the page shows: the user's choice, else the system's. */
function effectiveTheme(): 'light' | 'dark' {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Makes the top bar the window's title bar (the `desktop` class; see app.css) and keeps the app told of
 * the theme, so Windows' caption buttons match it. Returns a stop function.
 */
export function startDesktopWindow(bridge: DesktopBridge): () => void {
  const root = document.documentElement;
  root.classList.add('desktop');
  let last: string | null = null;
  const send = () => {
    const theme = effectiveTheme();
    if (theme === last) return;
    last = theme;
    bridge.theme(theme);
  };
  send();
  const observer = new MutationObserver(send);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener('change', send);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', send);
    root.classList.remove('desktop');
  };
}
