import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AppState } from '../../state/reducer.ts';
import { memoState } from '../../state/selectors.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { setFilterHandler } from '../actions.ts';
import { Icon, Menu, MenuItem, MenuLabel, type MenuNav } from '../primitives/index.ts';
import { OptionVisual } from './FilterBar.tsx';
import { CATEGORIES, filterOptions, filtersIn, SCOPE_KEYS, selected, setFilter, type FilterKey, type FilterOption, type FilterScope } from './model.ts';

const MAX_HITS = 8;

/** Up/Down (and Home/End outside the search field) move between the pane's items; Tab works as usual. */
function arrowKeys(e: KeyboardEvent<HTMLDivElement>) {
  const inField = e.target instanceof HTMLInputElement;
  if (!['ArrowDown', 'ArrowUp', ...(inField ? [] : ['Home', 'End'])].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.menu-search, .menu-item')];
  if (items.length === 0) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
  items[next]!.focus();
}

/** Puts focus on the pane's first item when the pane slides in while the menu is open. */
function PaneBody({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('.menu-search, .menu-item')?.focus({ preventScroll: true });
    // Only when this pane mounts: the Popover itself focuses the first item when the menu opens.
  }, []);
  return <div ref={ref} onKeyDown={arrowKeys}>{children}</div>;
}

/** Every category's options, recomputed only when the data or the filters change (not on streaming text). */
const optionsSelector = (scope: FilterScope) => memoState(
  (s: AppState) => [s.chats, s.history, s.projects, s.settings, filtersIn(s, scope), s.ui.archiving],
  (s) => Object.fromEntries(SCOPE_KEYS[scope].map((k) => [k, filterOptions(s, k, scope)])) as Record<FilterKey, FilterOption[]>,
);
const SELECT_OPTIONS: Record<FilterScope, (s: AppState) => Record<FilterKey, FilterOption[]>> = { board: optionsSelector('board'), chats: optionsSelector('chats') };

interface Hit { key: FilterKey; o: FilterOption }

function Root({ nav, open, query, setQuery, scope }: { nav: MenuNav; open: boolean; query: string; setQuery: (q: string) => void; scope: FilterScope }) {
  const store = useStoreInstance();
  const filters = useStore((s) => filtersIn(s, scope));
  const all = useStore(SELECT_OPTIONS[scope]);
  const keys = SCOPE_KEYS[scope];
  const q = query.trim().toLowerCase();
  const found: Hit[] = q
    ? keys.flatMap((key) => all[key].filter((o) => o.label.toLowerCase().includes(q)).map((o) => ({ key, o }))).slice(0, MAX_HITS)
    : [];
  // Linear-style: picking a value found by search sets that category to it and opens the category's pane.
  const jump = ({ key, o }: Hit) => {
    store.setState((s) => setFilter(s, key, [o.v], scope));
    setQuery('');
    nav.go(key);
  };
  return (
    <PaneBody open={open}>
      <input className="menu-search" name="filter-search" type="search" autoComplete="off" spellCheck={false} placeholder="Filter by…" aria-label="Search filters"
        value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); jump(found[0]); } }} />
      {!q && keys.map((key) => {
        const cat = CATEGORIES[key];
        const chosen = selected(filters, key);
        return (
          <MenuItem key={key} icon={cat.icon} onSelect={() => nav.go(key)} right={<>{chosen ? chosen.length : ''}<Icon name="chevron-right" size="sm" /></>}>
            {cat.label}
          </MenuItem>
        );
      })}
      {q && found.map((h) => (
        <MenuItem key={`${h.key}:${h.o.v}`} icon={h.o.provider || h.o.status ? undefined : CATEGORIES[h.key].icon} onSelect={() => jump(h)} right={CATEGORIES[h.key].label}>
          <OptionVisual o={h.o} />{h.o.label}
        </MenuItem>
      ))}
      {q && found.length === 0 && <MenuLabel>No matches</MenuLabel>}
    </PaneBody>
  );
}

function CategoryPane({ nav, open, k, scope }: { nav: MenuNav; open: boolean; k: FilterKey; scope: FilterScope }) {
  const store = useStoreInstance();
  const cat = CATEGORIES[k];
  const options = useStore(SELECT_OPTIONS[scope])[k]!;
  const chosen = useStore((s) => selected(filtersIn(s, scope), k));
  // No filter means every option is in.
  const cur = new Set(chosen ?? (cat.single ? [] : options.map((o) => o.v)));
  const set = (values: string[]) => store.setState((s) => setFilter(s, k, values, scope));
  const toggle = (v: string) => {
    if (cat.single) return set([v]);
    const next = new Set(cur);
    if (!next.delete(v)) next.add(v);
    set([...next]);
  };
  return (
    <PaneBody open={open}>
      <MenuLabel>
        <button className="btn icon-only ghost menu-back" type="button" aria-label="Back" onClick={nav.back}><Icon name="back" size="sm" /></button>
        {cat.label}
        {!cat.single && (
          <span className="links">
            <button type="button" onClick={() => set(options.map((o) => o.v))}>Select all</button>
            <button type="button" onClick={() => set([])}>None</button>
          </span>
        )}
      </MenuLabel>
      {options.map((o) => (
        <MenuItem key={o.v} checked={cur.has(o.v)} onSelect={() => toggle(o.v)}>
          <OptionVisual o={o} />{o.label}
        </MenuItem>
      ))}
    </PaneBody>
  );
}

/** A Filter button and its menu: categories → options pane, search, Select all / None. On the board, F opens it. */
export function FilterButton({ scope = 'board' }: { scope?: FilterScope }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (scope !== 'board') return;
    setFilterHandler(() => setOpen(true));
    return () => setFilterHandler(null);
  }, [scope]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const panes: Record<string, (nav: MenuNav) => ReactNode> = {
    root: (nav) => <Root nav={nav} open={open} query={query} setQuery={setQuery} scope={scope} />,
  };
  for (const k of SCOPE_KEYS[scope]) panes[k] = (nav) => <CategoryPane nav={nav} open={open} k={k} scope={scope} />;

  return (
    <>
      <button ref={setAnchor} className="chip-btn" type="button" aria-haspopup="menu" aria-expanded={open} aria-keyshortcuts="F" onClick={() => setOpen((o) => !o)}>
        <Icon name="filter" size="sm" />Filter
      </button>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} label="Filter" panes={panes} />
    </>
  );
}
