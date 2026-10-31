import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Project, ProjectInfo, ProviderId } from '@agent-kanban/shared';
import { openChatIn, type AppState } from '../../state/reducer.ts';
import { baseName } from '../../state/selectors.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { openHistoryChat, openNewChat } from '../actions.ts';
import { ReasonBadge, errorText } from '../board/Card.tsx';
import { copyText } from '../chat/ChatActionsMenu.tsx';
import { Icon, PROVIDER_IDS, ProviderLogo, providerName, StatusIcon } from '../primitives/index.ts';
import { cssMs, reducedMotion } from '../primitives/motion.ts';
import { navigate } from '../shell/route.ts';
import {
  agoLabel, cachedProjectInfo, chatsByFolder, findByFolder, folderKey, INSTRUCTION_FILE, isProjectHidden, loadProjectInfo, plural, setProjectHidden, statsOf, workedWith,
  type ProjectChat, type ProjectStats,
} from './model.ts';

/** Chats listed before "Show N more" (a folder can hold hundreds of history chats). */
const CHATS_SHOWN = 50;
/** Top folders listed in About before "… N more". */
const FOLDERS_SHOWN = 8;

const ORDER: Record<string, number> = { needs_you: 0, running: 1, review: 2, done: 3 };
const rank = (c: ProjectChat) => (c.column && !c.snoozed ? ORDER[c.column]! : 4);
const byState = (a: ProjectChat, b: ProjectChat) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

function onActivate(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      fn();
    }
  };
}

type Filter = 'all' | ProviderId;

/** Segmented control: the thumb slides to the pressed option; the content swaps after 60% of the move (design-system §Motion). */
function Segmented({ options, value, onChange }: { options: { v: Filter; label: string; logo?: ProviderId }[]; value: Filter; onChange: (v: Filter) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const [pressed, setPressed] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setPressed(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    const btn = ref.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    const t = thumb.current;
    if (!btn || !t) return;
    const instant = !placed.current;
    if (instant) t.style.transition = 'none';
    t.style.width = `${btn.offsetWidth}px`;
    t.style.transform = `translateX(${btn.offsetLeft - 2}px)`;
    if (instant) {
      void t.offsetWidth;
      t.style.transition = '';
      placed.current = true;
    }
  });
  const pick = (v: Filter) => {
    if (v === pressed) return;
    setPressed(v);
    clearTimeout(timer.current);
    if (reducedMotion()) onChange(v);
    else timer.current = setTimeout(() => onChange(v), cssMs('--duration-move', 260) * 0.6);
  };
  return (
    <span className="seg" ref={ref} role="group" aria-label="Show chats from">
      <span className="thumb" ref={thumb} />
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={pressed === o.v} onClick={() => pick(o.v)}>
          {o.logo && <ProviderLogo id={o.logo} size="sm" />}{o.label}
        </button>
      ))}
    </span>
  );
}

function ChatRow({ c, now, index, swapped }: { c: ProjectChat; now: number; index: number; swapped: boolean }) {
  const store = useStoreInstance();
  const open = () => {
    if (c.chatId) store.setState((s) => openChatIn(s, c.chatId!));
    else if (c.sessionRef) openHistoryChat({ provider: c.provider, sessionRef: c.sessionRef, cwd: c.cwd, title: c.title });
  };
  const onBoard = c.column !== null && !c.snoozed;
  return (
    <div className="crow" role="button" tabIndex={0} title={c.title} onClick={open} onKeyDown={onActivate(open)}
      style={swapped ? { animationDelay: `calc(var(--stagger) * ${Math.min(index, 10)})` } : undefined}>
      {onBoard ? <StatusIcon state={c.column!} /> : <span className="nostate" title={c.column ? 'Snoozed' : `In ${providerName(c.provider)} history`} />}
      <ProviderLogo id={c.provider} size="sm" alt={providerName(c.provider)} />
      <span className="t">{c.title}</span>
      {c.chat && c.column === 'needs_you' && !c.snoozed && <ReasonBadge chat={c.chat} />}
      {c.snoozed && <span className="badge quiet"><Icon name="snooze" size="sm" />Snoozed</span>}
      <span className="m">{c.model && <>{c.model}<span>·</span></>}{agoLabel(c.updatedAt, now)}</span>
    </div>
  );
}

function ProviderCards({ project, stats, worked, now }: { project: Project; stats: ProjectStats; worked: ProviderId[]; now: number }) {
  return (
    <div className="know-grid">
      {PROVIDER_IDS.map((id) => {
        if (!worked.includes(id)) {
          return (
            <div className="know off" key={id}>
              <div className="h"><ProviderLogo id={id} />{providerName(id)}</div>
              <p>Hasn’t worked in this project yet.</p>
            </div>
          );
        }
        const mine = stats.providers[id];
        const server = project.providers.find((p) => p.provider === id);
        const lastAt = mine?.lastAt || server?.lastUsedAt || '';
        const model = mine?.lastModel ?? server?.lastModel ?? null;
        return (
          <div className="know" key={id}>
            <div className="h"><ProviderLogo id={id} />{providerName(id)}<span className="r">{plural(mine?.chats ?? 0, 'chat')}</span></div>
            <p>Last used {agoLabel(lastAt, now)}{model ? ` · ${model}` : ''}</p>
            <button className="btn" type="button" disabled={project.folderMissing}
              onClick={() => openNewChat({ cwd: project.path, provider: id })}>
              <Icon name="plus" size="sm" />New {providerName(id)} chat
            </button>
          </div>
        );
      })}
    </div>
  );
}

type InfoState = { status: 'loading' } | { status: 'ok'; info: ProjectInfo } | { status: 'error'; message: string };

function useProjectInfo(path: string): [InfoState, () => void] {
  const [state, setState] = useState<InfoState>(() => {
    const hit = cachedProjectInfo(path);
    return hit ? { status: 'ok', info: hit } : { status: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const hit = attempt === 0 ? cachedProjectInfo(path) : undefined;
    setState(hit ? { status: 'ok', info: hit } : { status: 'loading' });
    loadProjectInfo(path, attempt > 0).then(
      (info) => { if (live) setState({ status: 'ok', info }); },
      (e: unknown) => { if (live) setState({ status: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [path, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

function Skeleton({ lines = 1 }: { lines?: number }) {
  return <>{Array.from({ length: lines }, (_, i) => <span key={i} className="skel" />)}</>;
}

function About({ project, now }: { project: Project; now: number }) {
  const [state, retry] = useProjectInfo(project.path);
  const info = state.status === 'ok' ? state.info : null;
  const loading = state.status === 'loading';
  const folders = info?.topFolders ?? [];
  const shown = folders.slice(0, FOLDERS_SHOWN);
  return (
    <aside className="about" aria-label="About this project" aria-busy={loading || undefined}>
      <div className="blk">
        <span className="k">LOCATION</span>
        <span className="path">{project.path}</span>
        <button className="link-btn copy-path" type="button" onClick={() => void copyText(project.path)}><Icon name="copy" size="sm" />Copy path</button>
      </div>
      {state.status === 'error' ? (
        <div className="blk" role="alert">
          <span className="about-error">{state.message}</span>
          <button className="btn about-retry" type="button" onClick={retry}><Icon name="refresh" size="sm" />Retry</button>
        </div>
      ) : (
        <>
          <div className="blk">
            <span className="k">BUILT WITH</span>
            {loading ? <Skeleton /> : (
              <span className="v">{info!.stack.length > 0 ? info!.stack.map((s) => <span key={s} className="tagchip">{s}</span>) : <span className="faint">Nothing we recognise</span>}</span>
            )}
          </div>
          <div className="blk">
            <span className="k">GIT</span>
            {loading ? <Skeleton lines={2} /> : info!.git ? (
              <>
                <span className="v"><Icon name="branch" size="sm" /><span className="mono">{info!.git.branch}</span></span>
                {info!.git.lastCommit && <span className="v muted">{info!.git.lastCommit} · {agoLabel(info!.git.lastCommitAt, now)}</span>}
              </>
            ) : <span className="v faint">Not a Git repository</span>}
          </div>
          <div className="blk">
            <span className="k">INSTRUCTIONS EACH PROVIDER READS</span>
            {loading ? <Skeleton lines={3} /> : PROVIDER_IDS.map((id) => {
              const found = info!.instructionFiles[id];
              return (
                <div className="file-line" key={id}>
                  {found ? <span className="ok"><Icon name="check" size="sm" /></span> : <span className="no"><Icon name="x" size="sm" /></span>}
                  <span className="mono">{INSTRUCTION_FILE[id]}</span>
                  <small><ProviderLogo id={id} size="sm" alt={providerName(id)} />{found ? 'Found' : 'Not in this folder'}</small>
                </div>
              );
            })}
          </div>
          <div className="blk">
            <span className="k">TOP FOLDERS</span>
            {loading ? <Skeleton lines={3} /> : folders.length === 0 ? <span className="v faint">No folders</span> : (
              <div className="tree">
                {shown.map((f, i) => (
                  <div key={f}><span>{i === shown.length - 1 && folders.length <= FOLDERS_SHOWN ? '└─' : '├─'}</span> {f}/</div>
                ))}
                {folders.length > FOLDERS_SHOWN && <div><span>└─</span> … {folders.length - FOLDERS_SHOWN} more</div>}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * A folder whose chats are on the board before /api/projects lists it (a chat just started there) still gets a page,
 * built from those chats, until the refetched list arrives.
 */
function fromChats(chats: ProjectChat[]): Project | undefined {
  const first = chats[0];
  if (!first) return undefined;
  return {
    id: first.cwd, name: baseName(first.cwd), path: first.cwd, providers: [],
    columns: { running: 0, needs_you: 0, review: 0, done: 0 }, historyOnly: 0, lastActivityAt: chats.reduce((a, c) => (c.updatedAt > a ? c.updatedAt : a), ''),
    hidden: null, folderMissing: false,
  };
}

const detailState = (id: string) => (s: AppState) => {
  const found = findByFolder(s.projects, id);
  const chats = chatsByFolder(s)[folderKey(found?.id ?? id)] ?? [];
  const project = found ?? fromChats(chats);
  return { project, chats, now: s.now, loaded: s.loaded, hidden: project ? isProjectHidden(s, project) : false };
};

export function ProjectDetail({ projectId }: { projectId: string }) {
  const store = useStoreInstance();
  const { project, chats, now, loaded, hidden } = useStore(detailState(projectId));
  const [filter, setFilter] = useState<Filter>('all');
  const [swapped, setSwapped] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  /** "Show N more" moves focus to the first row it revealed (the button itself goes away). */
  const focusRevealed = useRef(false);
  useEffect(() => {
    if (!showAll || !focusRevealed.current) return;
    focusRevealed.current = false;
    listRef.current?.querySelectorAll<HTMLElement>('.crow')[CHATS_SHOWN]?.focus();
  }, [showAll]);

  if (!project) {
    if (!loaded) return null;
    return (
      <div className="page-inner">
        <div className="page-empty">
          <Icon name="projects" />
          <h3>Project not found</h3>
          <p>This folder isn’t in your Claude Code, Codex or Antigravity history.</p>
          <a className="btn" href="#/projects"><Icon name="back" size="sm" />All projects</a>
        </div>
      </div>
    );
  }

  const stats = statsOf(chats);
  const worked = workedWith(project, stats, PROVIDER_IDS);
  const withChats = PROVIDER_IDS.filter((id) => stats.providers[id]);
  const active: Filter = filter !== 'all' && withChats.includes(filter) ? filter : 'all';
  const list = chats.filter((c) => active === 'all' || c.provider === active).sort(byState);
  const visible = showAll ? list : list.slice(0, CHATS_SHOWN);

  return (
    <div className="page-inner">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" onClick={() => navigate('projects')}><Icon name="back" size="sm" />Projects</button>
        <span aria-hidden="true">/</span><span aria-current="page">{project.name}</span>
      </nav>
      <div className="page-head">
        <div className="t">
          <h2 className="page-title"><span className="folder-glyph big-glyph proj-glyph" aria-hidden="true">{(project.name || '?')[0]!.toUpperCase()}</span>{project.name}</h2>
          <p className="mono path-line">{project.path}</p>
        </div>
        {hidden
          ? <button className="btn" type="button" onClick={() => void setProjectHidden(store, project, false)}>Unhide</button>
          : <button className="btn ghost" type="button" onClick={() => { void setProjectHidden(store, project, true).then((ok) => { if (ok) navigate('projects'); }); }}>Hide project</button>}
        <button className="btn primary" type="button" disabled={project.folderMissing} onClick={() => openNewChat({ cwd: project.path })}><Icon name="plus" size="sm" />New chat</button>
      </div>
      {project.folderMissing && <p className="project-note">Folder missing: it was moved or deleted. Its chats can still be read, but no new chat can start here.</p>}
      {hidden && <p className="project-note">Hidden from the sidebar, the board and New chat. Its chats are kept.</p>}
      <div className="detail">
        <div>
          <h3 className="section-title">Providers that know this project</h3>
          <ProviderCards project={project} stats={stats} worked={worked} now={now} />
          <h3 className="section-title">
            Chats
            {withChats.length > 0 && (
              <span className="r">
                <Segmented value={active}
                  options={[{ v: 'all', label: 'All' }, ...withChats.map((id) => ({ v: id, label: providerName(id), logo: id }))]}
                  onChange={(v) => { setFilter(v); setShowAll(false); setSwapped((n) => n + 1); }} />
              </span>
            )}
          </h3>
          <div className={`chat-list${swapped > 0 ? ' swapped' : ''}`} key={swapped} ref={listRef}>
            {visible.length === 0
              ? <div className="page-empty chats-empty">{chats.length === 0 ? 'No chats in this project yet.' : 'No chats from this provider yet.'}</div>
              : <ul className="chat-rows" aria-label="Chats">{visible.map((c, i) => <li key={c.key}><ChatRow c={c} now={now} index={i} swapped={swapped > 0} /></li>)}</ul>}
            {list.length > visible.length && (
              <button className="chats-more" type="button" onClick={() => { focusRevealed.current = true; setShowAll(true); }}>Show {list.length - visible.length} more</button>
            )}
          </div>
        </div>
        <About project={project} now={now} />
      </div>
    </div>
  );
}
