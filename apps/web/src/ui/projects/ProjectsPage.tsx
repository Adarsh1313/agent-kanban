import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Column, Project, ProviderId } from '@agent-kanban/shared';
import type { AppState } from '../../state/reducer.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { openNewChat } from '../actions.ts';
import { Icon, PROVIDER_IDS, ProviderLogo, providerName, StatusIcon, Switch, Tooltip } from '../primitives/index.ts';
import { hashFor } from '../shell/route.ts';
import { ProjectDetail } from './ProjectDetail.tsx';
import { agoLabel, chatsByFolder, folderKey, plural, setProjectHidden, statsOf, uniqueProjects, workedWith, type ProjectStats } from './model.ts';
import { StarButton } from '../myprojects/StarButton.tsx';
import { hiddenFolders } from '../../state/selectors.ts';

type Sort = 'name' | 'activity';

/** Rows rise in on the first visit only; never again on sort or search (design-system §Motion). */
let visited = false;
/** Tests start as a first visit. */
export const resetProjectsVisit = () => { visited = false; };
/** Rows past this one arrive together, so a long list never takes seconds to appear. */
const STAGGER_ROWS = 12;

const BAR: [Column, string][] = [
  ['running', 'var(--color-running)'], ['needs_you', 'var(--color-needs)'], ['review', 'var(--color-review)'], ['done', 'var(--color-done)'],
];
const LEGEND: [Column, string][] = [['running', 'working'], ['needs_you', 'need you'], ['review', 'to review']];


function StatusBar({ stats }: { stats: ProjectStats }) {
  const total = stats.total || 1;
  const legend = LEGEND.filter(([k]) => stats.columns[k] > 0);
  return (
    <div className="statusbar">
      <span className="bar" aria-hidden="true">
        {BAR.map(([k, colour]) => stats.columns[k] > 0 && <i key={k} style={{ width: `${(stats.columns[k] / total) * 100}%`, background: colour }} />)}
        {stats.quiet > 0 && <i style={{ width: `${(stats.quiet / total) * 100}%`, background: 'var(--color-border-strong)' }} />}
      </span>
      <span className="legend">
        {legend.length > 0
          ? legend.map(([k, label]) => <span key={k}><StatusIcon state={k} />{stats.columns[k]} {label}</span>)
          : <span>{plural(stats.total, 'chat')}, all quiet</span>}
      </span>
    </div>
  );
}

interface Row { project: Project; stats: ProjectStats; lastAt: string; providers: ProviderId[]; hidden: boolean }

function ProjectRow({ row, now, stagger }: { row: Row; now: number; stagger: number | null }) {
  const store = useStoreInstance();
  const { project, stats } = row;
  const style: CSSProperties | undefined = stagger === null ? undefined : { animationDelay: `calc(var(--stagger) * ${Math.min(stagger, STAGGER_ROWS)})` };
  return (
    <li className={row.hidden ? 'hidden-project' : undefined}><a className={`prow${stagger === null ? '' : ' stagger'}`} style={style} href={hashFor('projects', project.id)}>
      <div className="name">
        <span className="folder-glyph big-glyph proj-glyph" aria-hidden="true">{(project.name || '?')[0]!.toUpperCase()}</span>
        <span><b>{project.name}</b><small>{project.folderMissing && <span className="missing-note">Folder missing</span>}{project.path}</small></span>
      </div>
      <div className="who-knows">
        {row.providers.map((id) => {
          const n = stats.providers[id]?.chats ?? 0;
          return (
            <Tooltip key={id} label={`${providerName(id)} has ${plural(n, 'chat')} here`}>
              <span className="p"><ProviderLogo id={id} size="sm" alt={providerName(id)} />{n}</span>
            </Tooltip>
          );
        })}
      </div>
      <StatusBar stats={stats} />
      <div className="when">{agoLabel(row.lastAt, now)}</div>
      <div className="go" aria-hidden="true"><Icon name="chevron-right" /></div>
    </a>
    {!row.hidden && <StarButton project={project} />}
    {row.hidden && (
      <Tooltip label="Unhide">
        <button className="btn icon-only ghost unhide" type="button" aria-label={`Unhide ${project.name}`} onClick={() => void setProjectHidden(store, project, false)}>
          <Icon name="eye" size="sm" />
        </button>
      </Tooltip>
    )}
    </li>
  );
}

const listState = (s: AppState) => ({ projects: uniqueProjects(s), hidden: hiddenFolders(s), index: chatsByFolder(s), now: s.now, loaded: s.loaded });

function ProjectList() {
  const { projects: all, hidden, index, now, loaded } = useStore(listState);
  const [q, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const isHidden = (p: Project) => hidden.has(folderKey(p.id));
  const projects = all.filter((p) => !isHidden(p));
  const listed = showHidden ? all : projects;
  const [sort, setSortKey] = useState<Sort>('activity');
  // Latched at mount so a store update can't cut the rise short; cleared when the last row has risen, or by a sort or search.
  const [stagger, setStagger] = useState(() => !visited);
  useEffect(() => { visited = true; }, []);
  const setQ = (v: string) => { setStagger(false); setQuery(v); };
  const setSort = (v: Sort) => { setStagger(false); setSortKey(v); };

  const needle = q.trim().toLowerCase();
  const rows: Row[] = listed
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle))
    .map((project) => {
      const stats = statsOf(index[folderKey(project.id)] ?? []);
      return { project, stats, lastAt: stats.lastAt > project.lastActivityAt ? stats.lastAt : project.lastActivityAt, providers: workedWith(project, stats, PROVIDER_IDS), hidden: isHidden(project) };
    })
    .sort(sort === 'name'
      ? (a, b) => a.project.name.localeCompare(b.project.name, undefined, { sensitivity: 'base' })
      : (a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.project.name.localeCompare(b.project.name)));
  const animate = stagger && !needle;

  const sortButton = (key: Sort, label: string) => (
    <button type="button" aria-pressed={sort === key} aria-label={`Sort by ${label.toLowerCase()}`} onClick={() => setSort(key)}>
      {label}{sort === key && <Icon name="chevron-down" size="sm" />}
    </button>
  );

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="t">
          <h2 className="page-title">Projects <span className="count">{projects.length}</span></h2>
          <p>Every folder an agent has worked in, found in your Claude Code, Codex and Antigravity history. Open one to see which providers know it and what they can read.</p>
        </div>
        <label className="search">
          <Icon name="search" size="sm" />
          <input name="project-search" type="search" autoComplete="off" spellCheck={false} placeholder="Search projects…" aria-label="Search projects"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn" type="button" onClick={() => openNewChat({ cwd: '' })}><Icon name="folder" size="sm" />Add a folder</button>
      </div>
      {all.length > projects.length && (
        <label className="show-hidden">
          <Switch checked={showHidden} label="Show hidden projects" onChange={(on) => { setStagger(false); setShowHidden(on); }} />
          Show hidden projects <span className="count">{all.length - projects.length}</span>
        </label>
      )}
      {!loaded ? null : listed.length === 0 ? (
        <div className="page-empty">
          <Icon name="projects" />
          <h3>No projects yet</h3>
          <p>Folders show up here once Claude Code, Codex or Antigravity has worked in them.</p>
          <button className="btn" type="button" onClick={() => openNewChat({ cwd: '' })}>Add a folder</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="page-empty">
          <Icon name="search" />
          <h3>No projects match “{q.trim()}”</h3>
          <p>Check the spelling, or add the folder yourself.</p>
          <button className="btn" type="button" onClick={() => setQ('')}>Clear search</button>
        </div>
      ) : (
        <div className="plist">
          <div className="plist-head">
            {sortButton('name', 'Project')}<span>Worked on with</span><span>Chats</span>{sortButton('activity', 'Last activity')}<span />
          </div>
          <ul className="plist-rows" aria-label="Projects"
            onAnimationEnd={(e) => { if (animate && e.target === e.currentTarget.lastElementChild?.firstElementChild) setStagger(false); }}>
            {rows.map((row, i) => <ProjectRow key={row.project.id} row={row} now={now} stagger={animate ? i : null} />)}
          </ul>
        </div>
      )}
    </div>
  );
}

type Slide = 'in' | 'back' | null;

/** One page (list or a project). The slide is latched at mount and cleared when it ends, so a re-render can't cut it short. */
function ProjectsView({ projectId, slide }: { projectId: string | null; slide: Slide }) {
  const [anim, setAnim] = useState<Slide>(slide);
  return (
    <div className={`view page projects-page${anim ? ` entering${anim === 'back' ? ' from-left' : ''}` : ''}`}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setAnim(null); }}>
      {projectId === null ? <ProjectList /> : <ProjectDetail projectId={projectId} />}
    </div>
  );
}

/** `#/projects` lists every project; `#/projects/<path>` shows one. Moving between them slides like a page change (back goes the other way). */
export function ProjectsPage() {
  const projectId = useStore((s) => s.ui.projectId);
  const prev = useRef(projectId);
  const changed = prev.current !== projectId;
  useEffect(() => { prev.current = projectId; });
  // A fresh view per page (keyed), so the scroll starts at the top.
  return <ProjectsView key={projectId ?? ''} projectId={projectId} slide={changed ? (projectId === null ? 'back' : 'in') : null} />;
}
