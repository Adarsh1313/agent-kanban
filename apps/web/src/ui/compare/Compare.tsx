import { folderKey } from '@agent-kanban/shared';
import { useEffect, useState } from 'react';
import { myProjects as selectMyProjects } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { BoardColumns } from '../board/Board.tsx';
import { ProjectPicker } from '../myprojects/PickProjects.tsx';
import { Dialog } from '../primitives/index.ts';
import { MAX_PANES, closeComparePicker, comparePanes, getCompare, paneLayout, startCompare, useCompare, usePicking, type PaneProject } from './model.ts';

export const COMPARE_TITLE = 'Compare projects';

/** "2 running · 1 needs you": what a pane's header (and its collapsed strip) counts. */
function usePaneCounts(key: string) {
  const layout = useStore(paneLayout(key));
  return { running: layout.running.length, needsYou: layout.needs_you.length };
}

function PaneHeader({ pane }: { pane: PaneProject }) {
  const { running, needsYou } = usePaneCounts(pane.key);
  return (
    <header className="pane-head">
      <span className="folder-glyph proj-glyph" aria-hidden="true">{(pane.name || '?')[0]!.toUpperCase()}</span>
      <h2 className="pane-name" title={pane.id}>{pane.name}</h2>
      <span className="pane-counts tnum">
        <span>{running} running</span><span className="sep">·</span><span className={needsYou > 0 ? 'needs' : undefined}>{needsYou} needs you</span>
      </span>
    </header>
  );
}

function Pane({ pane }: { pane: PaneProject }) {
  return (
    <section className={`pane${pane.missing ? ' missing' : ''}`} aria-label={pane.name} data-key={pane.key}>
      <PaneHeader pane={pane} />
      <BoardColumns select={paneLayout(pane.key)} compact newChatCwd={pane.missing ? undefined : pane.id} />
    </section>
  );
}

/** The board as side-by-side project panes (#44). Filters and provider focus apply to every pane. */
export function Compare() {
  const { projects } = useCompare();
  const panes = useStore((s) => comparePanes(s, projects));
  return (
    <div className="compare" role="region" aria-label="Compare"
      style={{ gridTemplateColumns: panes.map(() => 'minmax(var(--pane-min-width), 1fr)').join(' ') }}>
      {panes.map((p) => <Pane key={p.key} pane={p} />)}
      {panes.length === 0 && <p className="empty-note compare-empty">These projects are hidden or gone. Pick others with Compare.</p>}
    </div>
  );
}

/** Picks up to 3 projects for Compare: My projects first, then the rest. Starts ticked with the last picks. */
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
      <span className="grow pick-count">{picked.size} of {MAX_PANES} picked · side by side on the board</span>
      <button className="btn ghost" type="button" onClick={closeComparePicker}>Cancel</button>
      <button className="btn primary" type="button" disabled={picked.size === 0} onClick={() => startCompare([...picked])}>Show side by side</button>
    </>}>
      {open && seed > 0 && <ProjectPicker key={seed} picked={picked} onChange={setPicked} max={MAX_PANES} first={first} />}
    </Dialog>
  );
}
