import type { ProviderId } from '@agent-kanban/shared';
import { folderKey } from '@agent-kanban/shared';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { focusedProvider, hiddenFolders, isArchived, isSnoozed, pinned as pinnedChats, providerCounts } from '../../state/selectors.ts';
import type { AppState } from '../../state/reducer.ts';
import { uniqueProjects } from '../projects/model.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Icon, Menu, MenuItem, PROVIDER_IDS, ProviderLogo, providerName } from '../primitives/index.ts';
import { replayOnboarding } from '../onboarding/Onboarding.tsx';
import { MyProjects } from '../myprojects/MyProjects.tsx';
import { ChatRow } from './ChatRow.tsx';
import { navigate, hashFor } from './route.ts';
import { openSearch } from '../search/SearchPalette.tsx';
import { toggleTheme } from './theme.ts';

const NAV = [
  ['board', 'board', 'Board'],
  ['chats', 'inbox', 'All chats'],
  ['projects', 'projects', 'Projects'],
  ['connections', 'plug', 'Connections'],
] as const;


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

function Providers() {
  const store = useStoreInstance();
  const counts = useStore(providerCounts);
  const focus = useStore(focusedProvider);
  const toggle = (id: ProviderId) =>
    store.setState((s) => {
      // Focusing a provider here is the Filter's "Provider is <p>": it shows as a chip and the Filter menu edits it.
      const clearing = focusedProvider(s) === id;
      return { ...s, ui: { ...s.ui, filters: { ...s.ui.filters, provider: clearing ? null : [id] } } };
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

function Pinned() {
  const list = useStore((s) => pinnedChats(s, s.now));
  const openChatId = useStore((s) => s.ui.openChatId);
  if (list.length === 0) return null;
  return (
    <SideSection title="Pinned">
      {list.map((c) => <ChatRow key={c.id} chat={{ key: c.id, chatId: c.id, provider: c.provider, sessionRef: c.sessionRef, title: c.title, cwd: c.cwd, updatedAt: c.updatedAt, column: c.column }} current={c.id === openChatId} />)}
    </SideSection>
  );
}

const counts = (s: AppState) => {
  const now = s.now;
  const board = Object.values(s.chats).filter(
    (c) => c.column !== null && c.column !== 'done' && !isArchived(s, c) && !isSnoozed(c, now),
  ).length;
  const connected = Object.values(s.connections).filter((c) => c?.status === 'connected' || c?.status === 'update_available').length;
  const hidden = hiddenFolders(s);
  return { board, projects: uniqueProjects(s).filter((p) => !hidden.has(folderKey(p.id))).length, connections: connected };
};

export function Sidebar() {
  const store = useStoreInstance();
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
        <button className="gsearch" type="button" onClick={() => openSearch(store)}>
          <Icon name="search" size="sm" /><span className="gs-t">Search chats and projects</span><span className="kbd" aria-hidden="true">Ctrl K</span>
        </button>
      </div>
      <nav className="navlist" aria-label="Main" ref={navRef}>
        <span className="cap" ref={capRef} />
        {NAV.map(([id, icon, label]) => (
          <button key={id} className="navitem" type="button" aria-current={view === id ? 'page' : undefined} onClick={() => { if (location.hash !== hashFor(id)) navigate(id); }}>
            <Icon name={icon} />{label} {id !== 'chats' && <span className="count">{n[id]}</span>}
          </button>
        ))}
      </nav>

      <div className="scroll">
        <Providers />
        <Pinned />
        <MyProjects />
      </div>

      <div className="side-foot">
        <button className="navitem" type="button" onClick={() => toggleTheme()}><Icon name="moon" />Light / dark</button>
        <button className="navitem" type="button" ref={setSettings} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
          <Icon name="settings" />Settings
        </button>
        <Menu anchor={settings} open={menuOpen} onClose={() => setMenuOpen(false)} label="Settings" panes={{
          root: () => <MenuItem icon="play" onSelect={() => { setMenuOpen(false); replayOnboarding(store); }}>Replay onboarding</MenuItem>,
        }} />
      </div>
    </aside>
  );
}
