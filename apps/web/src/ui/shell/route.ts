import type { UiState } from '../../state/reducer.ts';

export interface Route { view: UiState['view']; projectId: string | null }

/** `#/board` (default), `#/chats`, `#/projects`, `#/projects/<encodeURIComponent(path)>`, `#/connections`. Anything else is the board. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'connections') return { view: 'connections', projectId: null };
  if (path === 'chats') return { view: 'chats', projectId: null };
  if (path === 'projects' || path === 'projects/') return { view: 'projects', projectId: null };
  if (path.startsWith('projects/')) {
    try {
      return { view: 'projects', projectId: decodeURIComponent(path.slice('projects/'.length)) };
    } catch {
      return { view: 'projects', projectId: null };
    }
  }
  return { view: 'board', projectId: null };
}

export function hashFor(view: UiState['view'], projectId?: string | null): string {
  return view === 'projects' && projectId ? `#/projects/${encodeURIComponent(projectId)}` : `#/${view}`;
}

export function navigate(view: UiState['view'], projectId?: string | null): void {
  location.hash = hashFor(view, projectId);
}
