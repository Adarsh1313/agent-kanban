import type { Project } from '@agent-kanban/shared';
import { folderKey } from '@agent-kanban/shared';
import { useState } from 'react';
import { myProjects, projectCard } from '../../state/selectors.ts';
import type { AppState } from '../../state/reducer.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { Icon, StatusIcon } from '../primitives/index.ts';
import { relativeTime } from '../board/format.ts';
import { navigate } from '../shell/route.ts';
import { ChatRow } from '../shell/ChatRow.tsx';

/** Opens the My projects picker (the sidebar's pick card, Edit and empty state all use it). */
export const openProjectPicker = (store: Store) => store.setState((s) => ({ ...s, ui: { ...s.ui, pickProjects: true } }));

/* ───────── Collapsed cards: remembered per project on this device ───────── */

const COLLAPSED_KEY = 'agent-kanban.collapsedProjects';

function readCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function writeCollapsed(set: Set<string>) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* storage blocked: kept for this page only */ }
}

/** "1 running · 2 need you · 3h": what the card's chats are doing and when the project was last active. */
function summary(running: number, needsYou: number, lastActive: string, now: number): string[] {
  return [
    running ? `${running} running` : '',
    needsYou ? `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : '',
    relativeTime(lastActive, now),
  ].filter(Boolean);
}

function ProjectCardView({ project, open, onToggle }: { project: Project; open: boolean; onToggle: () => void }) {
  const store = useStoreInstance();
  const now = useStore((s) => s.now);
  const card = useStore((s) => projectCard(s, project.id));
  const openChatId = useStore((s) => s.ui.openChatId);
  const openHistory = useStore((s) => s.ui.openHistory);
  const parts = summary(card.running, card.needsYou, project.lastActivityAt, now);
  const showMore = () => {
    store.setState((s: AppState) => ({ ...s, ui: { ...s.ui, chatsFilters: { ...s.ui.chatsFilters, project: [project.id] } } }));
    navigate('chats');
  };
  const bodyId = `pc-${folderKey(project.id).replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <div className={`project-card${project.folderMissing ? ' missing' : ''}`} role="group" aria-label={project.name}>
      <button className="pc-head" type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
        aria-label={`${project.name}, ${project.folderMissing ? 'Folder missing' : parts.join(', ')}`}>
        <span className="folder-glyph proj-glyph" aria-hidden="true">{(project.name || '?')[0]!.toUpperCase()}</span>
        <span className="pc-two">
          <span className="pc-name">{project.name}</span>
          <span className="pc-sum" aria-hidden="true">
            {project.folderMissing ? <span>Folder missing</span> : parts.map((p, i) => (
              <span key={p} className={i < parts.length - 1 ? 'on' : undefined}>
                {i === 0 && card.running > 0 && <StatusIcon state="running" />}{p}
              </span>
            ))}
          </span>
        </span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
      </button>
      {open && (
        <div className="pc-body" id={bodyId}>
          {card.chats.map((c) => (
            <ChatRow key={c.key} chat={c} project={project.name} hideProject
              current={c.chatId !== null ? c.chatId === openChatId : openHistory !== null && openHistory.provider === c.provider && openHistory.sessionRef === c.sessionRef} />
          ))}
          {card.more > 0 && <button className="show-more-row" type="button" onClick={showMore}>{card.more} more in All chats</button>}
        </div>
      )}
    </div>
  );
}

/** The sidebar's My projects: a card per project the user works on, the pick card until they have picked. */
export function MyProjects() {
  const store = useStoreInstance();
  const list = useStore(myProjects);
  const picked = useStore((s) => s.settings?.myProjects ?? null);
  const loaded = useStore((s) => s.settings !== undefined && s.settings !== null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (id: string) => {
    const k = folderKey(id);
    const next = new Set(collapsed);
    if (next.has(k)) next.delete(k); else next.add(k);
    writeCollapsed(next);
    setCollapsed(next);
  };
  return (
    <>
      {loaded && picked === null && (
        <div className="pick-card">
          <b>Pick your projects</b>
          <span>Choose the projects you work on, and the sidebar shows just those.</span>
          <button className="btn primary" type="button" onClick={() => openProjectPicker(store)}>Pick projects</button>
        </div>
      )}
      <div className="side-section my-projects">
        <div className="side-title static">
          My projects
          <button className="side-act" type="button" onClick={() => openProjectPicker(store)}>Edit</button>
        </div>
        {list.length === 0 && picked !== null && (
          <div className="side-empty my-empty">
            <span>Pick the projects you work on.</span>
            <button className="btn" type="button" onClick={() => openProjectPicker(store)}>Pick</button>
          </div>
        )}
        {list.map((p) => <ProjectCardView key={p.id} project={p} open={!collapsed.has(folderKey(p.id))} onToggle={() => toggle(p.id)} />)}
      </div>
    </>
  );
}
