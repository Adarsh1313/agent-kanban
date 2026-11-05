import type { Project } from '@agent-kanban/shared';
import { folderKey } from '@agent-kanban/shared';
import { useEffect, useState } from 'react';
import { visibleProjects } from '../../state/selectors.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Dialog, Icon, ProviderLogo } from '../primitives/index.ts';
import { relativeTime } from '../board/format.ts';
import { defaultPicks, inMine, isOlderProject, pickable, saveMyProjects } from './model.ts';

export const PICK_TITLE = 'Which projects do you work on?';

/** Chats started here (counted per provider) plus the ones only in a provider's own history. */
const chatCount = (p: Project) => p.providers.reduce((n, x) => n + x.chats, 0) + p.historyOnly;

/**
 * The My projects picker: a grid of project tiles to tick, newest first, with older projects (no activity in 30 days)
 * folded behind one row and a search that looks through all of them. Used by onboarding and the sidebar's dialog.
 */
export function ProjectPicker({ picked, onChange, max, first }: {
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** At most this many ticks (Compare: 3); the other tiles are disabled once reached. */
  max?: number;
  /** Folder keys listed before the rest (Compare: My projects first). */
  first?: ReadonlySet<string>;
}) {
  const now = useStore((s) => s.now);
  const all = pickable(useStore(visibleProjects));
  const projects = first ? [...all.filter((p) => first.has(folderKey(p.id))), ...all.filter((p) => !first.has(folderKey(p.id)))] : all;
  const full = max !== undefined && picked.size >= max;
  const [q, setQ] = useState('');
  // Older starts open when one of them is already picked, so nothing ticked is out of sight.
  const [olderOpen, setOlderOpen] = useState(() => projects.some((p) => isOlderProject(p, now) && picked.has(folderKey(p.id))));
  const query = q.trim().toLowerCase();
  const match = (p: Project) => !query || p.name.toLowerCase().includes(query);
  const recent = projects.filter((p) => !isOlderProject(p, now) && match(p));
  const older = projects.filter((p) => isOlderProject(p, now) && match(p));
  const showOlder = olderOpen || query !== '';
  const toggle = (p: Project) => {
    const next = new Set(picked);
    const k = folderKey(p.id);
    if (next.has(k)) next.delete(k); else next.add(k);
    onChange(next);
  };
  const tile = (p: Project, dim = false) => {
    const on = picked.has(folderKey(p.id));
    const blocked = full && !on;
    const n = chatCount(p);
    const when = relativeTime(p.lastActivityAt, now);
    return (
      <button key={p.id} className={`pick-tile${dim ? ' dim' : ''}${p.folderMissing ? ' missing' : ''}`} type="button" role="checkbox" aria-checked={on}
        aria-label={`${p.name}, ${n} chat${n === 1 ? '' : 's'}, active ${when}`} title={p.path} disabled={blocked} onClick={() => toggle(p)}>
        <span className="cbox" aria-hidden="true"><Icon name="check" size="sm" /></span>
        <span className="folder-glyph proj-glyph" aria-hidden="true">{(p.name || '?')[0]!.toUpperCase()}</span>
        <span className="pt-name">{p.name}</span>
        <small>{n} chat{n === 1 ? '' : 's'} · {when}</small>
        <span className="pt-logos">{p.providers.map((x) => <ProviderLogo key={x.provider} id={x.provider} size="sm" />)}</span>
      </button>
    );
  };
  return (
    <div className="picker-wrap">
      <label className="search pick-search">
        <Icon name="search" size="sm" />
        <input type="search" aria-label="Search projects" placeholder={`Search ${projects.length} projects`} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div className="pick-grid">
        {recent.map((p) => tile(p))}
        {showOlder && older.map((p) => tile(p, true))}
      </div>
      {recent.length === 0 && older.length === 0 && <p className="empty-note">No projects match “{q}”.</p>}
      {!query && older.length > 0 && (
        <button className="show-more-row pick-older" type="button" aria-expanded={showOlder} onClick={() => setOlderOpen((o) => !o)}>
          <Icon name={showOlder ? 'chevron-down' : 'chevron-right'} size="sm" />
          {`Older · no activity in 30 days (${older.length})`}
        </button>
      )}
    </div>
  );
}

/** The ticked folders, in the picker's order (newest first), as the setting stores them. */
export function pickedPaths(projects: Project[], picked: ReadonlySet<string>): string[] {
  return pickable(projects).filter((p) => picked.has(folderKey(p.id))).map((p) => p.id);
}

/** The sidebar's picker dialog (pick card, Edit, empty state): starts from My projects, or the pre-ticked ones the first time. */
export function PickProjectsDialog() {
  const store = useStoreInstance();
  const open = useStore((s) => s.ui.pickProjects);
  const projects = useStore(visibleProjects);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Bumped each time it opens, after the ticks are set: the picker mounts afresh with them (Older opens if one is ticked).
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const s = store.getState();
    const mine = s.settings?.myProjects ?? null;
    const start = mine === null ? defaultPicks(projects, s.now) : projects.filter((p) => inMine(mine, p.id)).map((p) => p.id);
    setPicked(new Set(start.map(folderKey)));
    setSeed((n) => n + 1);
    // Only when it opens: a project list refresh while open must not undo the user's ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = () => store.setState((s) => ({ ...s, ui: { ...s.ui, pickProjects: false } }));
  const save = async () => {
    setBusy(true);
    const ok = await saveMyProjects(store, () => pickedPaths(projects, picked));
    setBusy(false);
    if (ok) close();
  };
  return (
    <Dialog open={open} onClose={close} title={PICK_TITLE} footer={<>
      <span className="grow pick-count">{picked.size} picked · the sidebar shows just these</span>
      <button className="btn ghost" type="button" onClick={close}>Cancel</button>
      <button className="btn primary" type="button" aria-busy={busy || undefined} disabled={busy} onClick={() => void save()}>Save</button>
    </>}>
      {open && seed > 0 && <ProjectPicker key={seed} picked={picked} onChange={setPicked} />}
    </Dialog>
  );
}
