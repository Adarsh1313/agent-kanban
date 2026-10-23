import type { ProviderId } from '@agent-kanban/shared';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { focusedProvider, isArchived, isSnoozed, memoState, pinned as pinnedChats, providerCounts, recentChatsByProject, type SidebarChat } from '../../state/selectors.ts';
import { openChatIn, type AppState } from '../../state/reducer.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { openHistoryChat, openNewChat, openRowMenu } from '../actions.ts';
import { Icon, Menu, MenuItem, PROVIDER_IDS, ProviderLogo, StatusIcon, Tooltip, providerName } from '../primitives/index.ts';
import { navigate, hashFor } from './route.ts';
import { toggleTheme } from './theme.ts';

const NAV = [
  ['board', 'board', 'Board'],
  ['projects', 'projects', 'Projects'],
  ['connections', 'plug', 'Connections'],
] as const;

const PROJECTS_SHOWN = 4;
const CHATS_SHOWN = 3;

function onActivate(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      fn();
    }
  };
}

function SideSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="side-section">
      <button className="side-title" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron-down" size="sm" />{title}
      </button>
      <div className={`collapsible${open ? '' : ' closed'}`} inert={!open}><div>{children}</div></div>
    </div>
  );
}

interface RowChat { key: string; chatId: string | null; provider: ProviderId; sessionRef: string | null; title: string; cwd: string; column: SidebarChat['column'] }

function ChatRow({ chat, current }: { chat: RowChat; current: boolean }) {
  const store = useStoreInstance();
  const open = () => {
    if (chat.chatId) store.setState((s) => openChatIn(s, chat.chatId!));
    else if (chat.sessionRef) openHistoryChat({ provider: chat.provider, sessionRef: chat.sessionRef, cwd: chat.cwd, title: chat.title });
  };
  const more = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    openRowMenu(
      { chatId: chat.chatId, history: chat.sessionRef ? { provider: chat.provider, sessionRef: chat.sessionRef, cwd: chat.cwd, title: chat.title } : null },
      e.currentTarget,
    );
  };
  return (
    <div className="chat-row" role="button" tabIndex={0} title={chat.title} aria-current={current ? 'true' : undefined} onClick={open} onKeyDown={onActivate(open)}>
      <ProviderLogo id={chat.provider} size="sm" />
      <span className="t">{chat.title}</span>
      {chat.column === 'running' && <StatusIcon state="running" />}
      {chat.column === 'needs_you' && <span className="state-dot" title="Needs you" />}
      <Tooltip label="More actions">
        <button className="row-more" type="button" aria-label={`More actions for ${chat.title}`} aria-haspopup="menu" onClick={more}>
          <Icon name="more" size="sm" />
        </button>
      </Tooltip>
    </div>
  );
}

function Providers() {
  const store = useStoreInstance();
  const counts = useStore(providerCounts);
  const focus = useStore(focusedProvider);
  const toggle = (id: ProviderId) =>
    store.setState((s) => {
      const clearing = focusedProvider(s) === id;
      const filters = { ...s.ui.filters };
      // The sidebar focus and the Filter's single-provider choice are one thing to the user: setting one replaces the other.
      if (!clearing || (filters.provider?.length === 1 && filters.provider[0] === id)) filters.provider = null;
      return { ...s, ui: { ...s.ui, focusProvider: clearing ? null : id, filters } };
    });
  return (
    <SideSection title="Providers">
      {PROVIDER_IDS.map((id) => (
        <button key={id} className="navitem prov" type="button" aria-pressed={focus === id} onClick={() => toggle(id)}>
          <ProviderLogo id={id} />{providerName(id)}<span className="meta-r">{counts[id]}</span>
        </button>
      ))}
    </SideSection>
  );
}

function Recent() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // One more project than shown tells us whether "All projects" is needed.
  // Memoized on the parts it reads, so streaming deltas do not re-sort every history chat.
  const select = useMemo(
    () => memoState(
      (s) => [s.chats, s.history, s.projects, s.ui.focusProvider, s.ui.filters.provider, s.ui.archiving, s.now],
      (s) => recentChatsByProject(s, s.now, { projects: PROJECTS_SHOWN + 1, chats: CHATS_SHOWN }, expanded),
    ),
    [expanded],
  );
  const groups = useStore(select);
  const openChatId = useStore((s) => s.ui.openChatId);
  const openHistory = useStore((s) => s.ui.openHistory);
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <SideSection title="Recent chats">
      {groups.slice(0, PROJECTS_SHOWN).map((g) => {
        const open = expanded.has(g.projectId);
        const goProject = () => navigate('projects', g.projectId);
        return (
          <div className="proj" key={g.projectId}>
            <div className="proj-row" role="button" tabIndex={0} title={`Open ${g.name}`} onClick={goProject} onKeyDown={onActivate(goProject)}>
              <span className="name">{g.name}</span>
              <Tooltip label={`New chat in ${g.name}`}>
                <button className="add" type="button" aria-label={`New chat in ${g.name}`} onClick={(e) => { e.stopPropagation(); openNewChat({ cwd: g.projectId }); }}>
                  <Icon name="plus" size="sm" />
                </button>
              </Tooltip>
            </div>
            {g.chats.map((c) => (
              <ChatRow key={c.key} chat={c}
                current={c.chatId !== null ? c.chatId === openChatId : openHistory !== null && openHistory.provider === c.provider && openHistory.sessionRef === c.sessionRef} />
            ))}
            {g.total > CHATS_SHOWN && (
              <button className="show-more-row" type="button" onClick={() => toggle(g.projectId)}>
                {open ? 'Show less' : `${g.total - CHATS_SHOWN} more`}
              </button>
            )}
          </div>
        );
      })}
      {groups.length > PROJECTS_SHOWN && (
        <button className="show-more-row all-projects" type="button" onClick={() => navigate('projects')}>
          All projects<Icon name="chevron-right" size="sm" />
        </button>
      )}
    </SideSection>
  );
}

function Pinned() {
  const list = useStore((s) => pinnedChats(s, s.now));
  const openChatId = useStore((s) => s.ui.openChatId);
  if (list.length === 0) return null;
  return (
    <SideSection title="Pinned">
      {list.map((c) => <ChatRow key={c.id} chat={{ key: c.id, chatId: c.id, provider: c.provider, sessionRef: c.sessionRef, title: c.title, cwd: c.cwd, column: c.column }} current={c.id === openChatId} />)}
    </SideSection>
  );
}

const counts = (s: AppState) => {
  const now = s.now;
  const board = Object.values(s.chats).filter(
    (c) => c.column !== null && c.column !== 'done' && !isArchived(s, c) && !isSnoozed(c, now),
  ).length;
  const connected = Object.values(s.connections).filter((c) => c?.status === 'connected' || c?.status === 'update_available').length;
  return { board, projects: s.projects.length, connections: connected };
};

export function Sidebar() {
  const view = useStore((s) => s.ui.view);
  const n = useStore(counts);
  const navRef = useRef<HTMLElement>(null);
  const capRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // The capsule slides to the active item (--duration-move); the first placement does not animate.
  const place = (instant: boolean) => {
    const cap = capRef.current;
    const item = navRef.current?.querySelector<HTMLElement>('.navitem[aria-current]');
    if (!cap || !item) return;
    const jump = instant || !placed.current || item.offsetParent === null;
    if (jump) cap.style.transition = 'none';
    cap.style.transform = `translateY(${item.offsetTop}px)`;
    if (jump) {
      void cap.offsetWidth;
      cap.style.transition = '';
    }
    placed.current = item.offsetParent !== null;
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // A view change slides the capsule (animated); the first placement does not animate.
  useLayoutEffect(() => { placeRef.current(false); }, [view]);

  // Once: when the nav's size really changes (window resize, sidebar shown again) measure again without animating.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    let size = `${nav.offsetWidth}x${nav.offsetHeight}`;
    const remeasure = () => {
      const now = `${nav.offsetWidth}x${nav.offsetHeight}`;
      if (now === size) return;
      size = now;
      placeRef.current(true);
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(remeasure) : null;
    ro?.observe(nav);
    const onResize = () => placeRef.current(true);
    window.addEventListener('resize', onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <button className="workspace" type="button">
        <span className="mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg></span>
        Agent Kanban <span className="chev"><Icon name="updown" /></span>
      </button>
      <div className="side-actions">
        <button className="btn new" type="button" onClick={() => openNewChat()}><Icon name="plus" />New chat <span className="kbd">N</span></button>
        <Tooltip label="Search chats"><button className="btn icon-only ghost" type="button" aria-label="Search chats"><Icon name="search" /></button></Tooltip>
      </div>
      <nav className="navlist" aria-label="Main" ref={navRef}>
        <span className="cap" ref={capRef} />
        {NAV.map(([id, icon, label]) => (
          <button key={id} className="navitem" type="button" aria-current={view === id ? 'page' : undefined} onClick={() => { if (location.hash !== hashFor(id)) navigate(id); }}>
            <Icon name={icon} />{label} <span className="count">{n[id === 'board' ? 'board' : id]}</span>
          </button>
        ))}
      </nav>

      <div className="scroll">
        <Providers />
        <Pinned />
        <Recent />
      </div>

      <div className="side-foot">
        <button className="navitem" type="button" onClick={() => toggleTheme()}><Icon name="moon" />Light / dark</button>
        <button className="navitem" type="button" ref={setSettings} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
          <Icon name="settings" />Settings
        </button>
        <Menu anchor={settings} open={menuOpen} onClose={() => setMenuOpen(false)} label="Settings" panes={{
          root: () => <MenuItem icon="resume" disabled>Replay onboarding</MenuItem>,
        }} />
      </div>
    </aside>
  );
}
