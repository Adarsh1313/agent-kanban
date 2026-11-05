import { folderKey } from '@agent-kanban/shared';
import { useEffect, useState } from 'react';
import { myProjects as selectMyProjects, visibleProjects } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { openNewChat } from '../actions.ts';
import { BoardColumns } from '../board/Board.tsx';
import { pickable } from '../myprojects/model.ts';
import { ProjectPicker } from '../myprojects/PickProjects.tsx';
import { Dialog, Icon, Menu, MenuItem, MenuLabel, MenuSep, Tooltip } from '../primitives/index.ts';
import {
  MAX_OPEN, closeComparePicker, comparePanes, getCompare, paneLayout, removePane, setOpen, startCompare, swapPane, useCompare, usePicking,
  type PaneProject,
} from './model.ts';

export const COMPARE_TITLE = 'Compare projects';

/** "2 running · 1 needs you": what a pane's header counts, open or minimized. */
function usePaneCounts(key: string) {
  const layout = useStore(paneLayout(key));
  return { running: layout.running.length, needsYou: layout.needs_you.length };
}

const glyph = (name: string) => <span className="folder-glyph proj-glyph" aria-hidden="true">{(name || '?')[0]!.toUpperCase()}</span>;

/** The pane's "…" menu: New chat here, Swap project (My projects first, open ones left out), Remove from compare. */
function PaneMenu({ pane, open: openKeys }: { pane: PaneProject; open: string[] }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const all = pickable(useStore(visibleProjects));
  const mine = new Set(useStore(selectMyProjects).map((p) => folderKey(p.id)));
  const others = [...all.filter((p) => mine.has(folderKey(p.id))), ...all.filter((p) => !mine.has(folderKey(p.id)))]
    .filter((p) => !openKeys.includes(folderKey(p.id)));
  const close = () => setOpen(false);
  const pick = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <Tooltip label="Pane actions">
        <button ref={setAnchor} className="btn icon-only ghost" type="button" aria-label={`${pane.name} actions`} aria-haspopup="menu" aria-expanded={open}
          onClick={() => setOpen((o) => !o)}><Icon name="more" size="sm" /></button>
      </Tooltip>
      <Menu anchor={anchor} open={open} onClose={close} align="right" label={`${pane.name} actions`} panes={{
        root: (nav) => (
          <>
            <MenuItem icon="plus" disabled={pane.missing} onSelect={pick(() => openNewChat({ cwd: pane.id }))}>New chat here</MenuItem>
            <MenuItem icon="refresh" disabled={others.length === 0} right={<Icon name="chevron-right" size="sm" />} onSelect={() => nav.go('swap')}>Swap project</MenuItem>
            <MenuSep />
            <MenuItem icon="x" onSelect={pick(() => removePane(pane.key))}>Remove from compare</MenuItem>
          </>
        ),
        swap: (nav) => (
          <>
            <MenuLabel>
              <Tooltip label="Back">
                <button className="btn icon-only ghost menu-back" type="button" aria-label="Back" onClick={nav.back}><Icon name="back" size="sm" /></button>
              </Tooltip>
              Swap {pane.name} for
            </MenuLabel>
            {others.map((p) => <MenuItem key={p.id} onSelect={pick(() => swapPane(pane.key, p.id))}>{p.name || p.path}</MenuItem>)}
          </>
        ),
      }} />
    </>
  );
}

function PaneHeader({ pane, open, inCompare, shown }: { pane: PaneProject; open: boolean; inCompare: string[]; shown: string[] }) {
  const { running, needsYou } = usePaneCounts(pane.key);
  return (
    <header className="pane-head">
      <Tooltip label={open ? 'Minimize' : 'Open'}>
        <button className="btn icon-only ghost pane-toggle" type="button" aria-label={`${open ? 'Minimize' : 'Open'} ${pane.name}`} aria-expanded={open}
          onClick={() => setOpen(pane.key, !open, shown)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
        </button>
      </Tooltip>
      {glyph(pane.name)}
      <h2 className="pane-name" title={pane.id}>{pane.name}</h2>
      <span className="pane-counts tnum">
        <span>{running} running</span><span className="sep">·</span><span className={needsYou > 0 ? 'needs' : undefined}>{needsYou} needs you</span>
      </span>
      <Tooltip label="New chat here">
        <button className="btn icon-only ghost" type="button" aria-label={`New chat in ${pane.name}`} disabled={pane.missing} onClick={() => openNewChat({ cwd: pane.id })}>
          <Icon name="plus" size="sm" />
        </button>
      </Tooltip>
      <PaneMenu pane={pane} open={inCompare} />
    </header>
  );
}

function Pane({ pane, open, inCompare, shown }: { pane: PaneProject; open: boolean; inCompare: string[]; shown: string[] }) {
  return (
    <section className={`pane${pane.missing ? ' missing' : ''}${open ? ' open' : ' minimized'}`} aria-label={pane.name} data-key={pane.key}>
      <PaneHeader pane={pane} open={open} inCompare={inCompare} shown={shown} />
      {open && <BoardColumns select={paneLayout(pane.key)} compact newChatCwd={pane.missing ? undefined : pane.id} />}
    </section>
  );
}

/**
 * The board as project panes stacked one below another (#44): at most 3 open, sharing the height; the rest minimized
 * to their header with its counts. Filters and provider focus apply to every pane.
 */
export function Compare() {
  const { projects, open } = useCompare();
  const panes = useStore((s) => comparePanes(s, projects));
  const shown = panes.map((p) => p.key);
  return (
    <div className="compare" role="region" aria-label="Compare">
      {panes.map((p) => <Pane key={p.key} pane={p} open={open.includes(p.key)} inCompare={projects} shown={shown} />)}
      {panes.length === 0 && <p className="empty-note compare-empty">These projects are hidden or gone. Pick others with Compare.</p>}
    </div>
  );
}

/** Picks the projects for Compare: My projects first, then the rest. Starts ticked with the last picks. */
export function ComparePicker() {
  const open = usePicking();
  const mine = useStore(selectMyProjects);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(getCompare().projects));
    setSeed((n) => n + 1);
  }, [open]);
  const first = new Set(mine.map((p) => folderKey(p.id)));
  return (
    <Dialog open={open} onClose={closeComparePicker} title={COMPARE_TITLE} footer={<>
      <span className="grow pick-count">{picked.size} picked · {MAX_OPEN} open at a time</span>
      <button className="btn ghost" type="button" onClick={closeComparePicker}>Cancel</button>
      <button className="btn primary" type="button" disabled={picked.size === 0} onClick={() => startCompare([...picked])}>Show projects</button>
    </>}>
      {open && seed > 0 && <ProjectPicker key={seed} picked={picked} onChange={setPicked} first={first} />}
    </Dialog>
  );
}
