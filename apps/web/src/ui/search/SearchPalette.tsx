import type { Project } from '@agent-kanban/shared';
import { folderKey, projectFolder } from '@agent-kanban/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { openChatIn } from '../../state/reducer.ts';
import { searchableChats, visibleProjects, type ListedChat } from '../../state/selectors.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { openHistoryChat } from '../actions.ts';
import { freeze, unfreeze } from '../primitives/Dialog.tsx';
import { hasOpenLayer, pushLayer } from '../primitives/layers.ts';
import { Icon, ProviderLogo, StatusIcon } from '../primitives/index.ts';
import { relativeTime } from '../board/format.ts';
import { navigate } from '../shell/route.ts';

/** How many projects and chats the palette lists; "See all results" has the rest. */
export const PALETTE_PROJECTS = 6;
export const PALETTE_CHATS = 8;

export const openSearch = (store: Store) => store.setState((s) => ({ ...s, ui: { ...s.ui, searchOpen: true } }));
const closeSearch = (store: Store) => store.setState((s) => ({ ...s, ui: { ...s.ui, searchOpen: false } }));

/** The text with the first case-insensitive match of `q` marked. */
function highlight(text: string, q: string): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

const byActivity = (a: Project, b: Project) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0);

type Item = { kind: 'project'; project: Project } | { kind: 'chat'; chat: ListedChat };

/**
 * Global search (#38, prototype variant B): a wide palette over a dimmed page. Projects that match by name on the
 * left; chats that match by title on the right, or the highlighted project's chats. Arrow keys move through both
 * columns, Enter opens, Esc closes. Ctrl+K opens it from anywhere.
 */
export function SearchPalette() {
  const store = useStoreInstance();
  const open = useStore((s) => s.ui.searchOpen);

  // Ctrl+K (Cmd+K) from anywhere, unless another dialog or popover is open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k' && store.getState().loaded) {
        if (store.getState().ui.searchOpen || hasOpenLayer()) return;
        e.preventDefault();
        openSearch(store);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store]);

  if (!open) return null;
  return createPortal(<Palette onClose={() => closeSearch(store)} />, document.body);
}

function Palette({ onClose }: { onClose: () => void }) {
  const store = useStoreInstance();
  const now = useStore((s) => s.now);
  const projects = useStore(visibleProjects);
  const chats = useStore(searchableChats);
  const [query, setQuery] = useState('');
  const [sel, setSelRaw] = useState(-1);
  // The project last highlighted: its chats stay on the right while the user moves into them.
  const [projIdx, setProjIdx] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A modal layer: the page behind is inert, Esc closes, focus returns where it was.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frozen = freeze((n) => n !== el && !n.matches('.popover, .tip, .toasts, script'));
    const release = pushLayer('dialog', () => onCloseRef.current());
    inputRef.current?.focus();
    return () => {
      release();
      unfreeze(frozen);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const q = query.trim().toLowerCase();
  const matchedProjects = [...projects].sort(byActivity).filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, PALETTE_PROJECTS);
  const matchedChats = chats.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0, PALETTE_CHATS);
  const focusProject = projIdx !== null ? matchedProjects[projIdx] ?? null : null;
  const setSel = (next: number | ((i: number) => number)) => setSelRaw((cur) => {
    const i = typeof next === 'function' ? next(cur) : next;
    if (i < 0) setProjIdx(null);
    else if (i < matchedProjects.length) setProjIdx(i);
    return i;
  });
  const rightChats = focusProject
    ? chats.filter((c) => folderKey(projectFolder(c.cwd)) === folderKey(focusProject.id)).slice(0, PALETTE_CHATS)
    : matchedChats;
  const items: Item[] = [...matchedProjects.map((project) => ({ kind: 'project' as const, project })), ...rightChats.map((chat) => ({ kind: 'chat' as const, chat }))];
  const optionId = (i: number) => `${listId}-${i}`;

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'project') navigate('projects', item.project.id);
    else if (item.chat.chatId) store.setState((s) => openChatIn(s, item.chat.chatId!));
    else if (item.chat.sessionRef) openHistoryChat({ provider: item.chat.provider, sessionRef: item.chat.sessionRef, cwd: item.chat.cwd, title: item.chat.title });
  };
  const seeAll = () => {
    const text = query.trim();
    onClose();
    store.setState((s) => ({ ...s, ui: { ...s.ui, chatsSearchText: text, chatsSearchFocus: s.ui.chatsSearchFocus + 1 } }));
    navigate('chats');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(-1, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[sel]); }
    else if (e.key === 'Tab') e.preventDefault(); // the field keeps focus; arrows move through results
  };

  // The highlighted option stays in view.
  useEffect(() => { if (sel >= 0) document.getElementById(optionId(sel))?.scrollIntoView?.({ block: 'nearest' }); });

  const chatOption = (c: ListedChat, i: number, inProject: boolean) => (
    <li key={c.key} id={optionId(i)} role="option" aria-selected={sel === i} className="palette-item" onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setSel(i)} onClick={() => choose(items[i])}>
      <ProviderLogo id={c.provider} size="sm" />
      <span className="r-t">{highlight(c.title, focusProject ? '' : q)}</span>
      {c.column === 'running' && <StatusIcon state="running" />}
      {c.column === 'needs_you' && <span className="state-dot" title="Needs you" />}
      <span className="r-m">{inProject ? relativeTime(c.updatedAt, now) : c.projectName}</span>
    </li>
  );
  const nothing = q && matchedProjects.length === 0 && matchedChats.length === 0;

  return (
    <>
      <div className="scrim palette-scrim" data-state="open" onClick={onClose} />
      <div ref={ref} className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <label className="palette-in">
          <Icon name="search" />
          <input ref={inputRef} type="search" role="combobox" aria-label="Search chats and projects" aria-expanded="true" aria-controls={`${listId}-p ${listId}-c`}
            aria-activedescendant={sel >= 0 ? optionId(sel) : undefined} placeholder="Search chats and projects" autoComplete="off" spellCheck={false}
            value={query} onChange={(e) => { setQuery(e.target.value); setSelRaw(-1); setProjIdx(null); }} onKeyDown={onKeyDown} />
          <span className="kbd">Esc</span>
        </label>
        {nothing ? (
          <p className="palette-empty">Nothing matches “{query.trim()}”</p>
        ) : (
          <div className="palette-cols">
            <div>
              <div className="palette-label" id={`${listId}-pl`}>Projects</div>
              <ul id={`${listId}-p`} role="listbox" aria-label="Projects">
                {matchedProjects.map((p, i) => (
                  <li key={p.id} id={optionId(i)} role="option" aria-selected={sel === i} className="palette-item" onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSel(i)} onClick={() => choose(items[i])}>
                    <span className="folder-glyph proj-glyph" aria-hidden="true">{(p.name || '?')[0]!.toUpperCase()}</span>
                    <span className="r-t">{highlight(p.name, q)}</span>
                    <span className="r-m">{relativeTime(p.lastActivityAt, now)}</span>
                  </li>
                ))}
              </ul>
              {matchedProjects.length === 0 && <p className="palette-none">No projects match</p>}
            </div>
            <div>
              <div className="palette-label">{focusProject ? `Chats in ${focusProject.name}` : 'Chats'}</div>
              <ul id={`${listId}-c`} role="listbox" aria-label="Chats">
                {rightChats.map((c, j) => chatOption(c, matchedProjects.length + j, focusProject !== null))}
              </ul>
              {rightChats.length === 0 && <p className="palette-none">No chats match</p>}
              <button className="palette-all" type="button" onClick={seeAll}><Icon name="search" size="sm" />See all results in All chats</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
