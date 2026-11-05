import { folderKey, projectFolder } from '@agent-kanban/shared';
import { useSyncExternalStore } from 'react';
import type { AppState } from '../../state/reducer.ts';
import { boardColumns, chatFolder, hiddenFolders, memoState } from '../../state/selectors.ts';
import type { Layout, LayoutSelector } from '../board/Board.tsx';

/** At most this many panes open at once; opening another minimizes the one opened longest ago. */
export const MAX_OPEN = 3;
const KEY = 'agent-kanban.compare';

/**
 * Compare (#44): the board as project panes stacked one below another. Any number of projects; at most 3 open, the
 * rest minimized to their header. Remembered on this device only (browser storage), so it opens how the user left
 * it. `projects` (picker order) and `open` (oldest opened first) hold folder keys; `on` is false after Exit compare
 * (the picks stay, ready for the next Compare).
 */
export interface CompareState {
  on: boolean;
  projects: string[];
  open: string[];
}

const OFF: CompareState = { on: false, projects: [], open: [] };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const unique = (keys: string[]) => [...new Set(keys.map(folderKey))];

function load(): CompareState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return OFF;
    const v = JSON.parse(raw) as Partial<CompareState> & { collapsed?: unknown };
    const projects = unique(strings(v.projects));
    // Saved before panes stacked (#44 follow-up): everything not collapsed was open.
    const open = Array.isArray(v.open) ? strings(v.open) : projects.filter((k) => !strings(v.collapsed).includes(k));
    return { on: v.on === true && projects.length > 0, projects, open: open.filter((k) => projects.includes(k)).slice(-MAX_OPEN) };
  } catch {
    // Blocked storage or a damaged value: start with the normal board.
    return OFF;
  }
}

let state: CompareState | null = null;
let picking = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const getCompare = (): CompareState => (state ??= load());

function setCompare(next: CompareState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: Compare still works, it just isn't remembered.
  }
  emit();
}

/** Forget the in-memory copy so the next read comes from storage again (tests: a "reload"). */
export function reloadCompare(): void {
  state = null;
  picking = false;
  emit();
}

export const useCompare = (): CompareState => useSyncExternalStore(subscribe, getCompare, getCompare);
export const usePicking = (): boolean => useSyncExternalStore(subscribe, () => picking, () => picking);

export function openComparePicker(): void { picking = true; emit(); }
export function closeComparePicker(): void { picking = false; emit(); }

/** Starts Compare with these folders (keys, picker order): the first one open, the rest minimized. */
export function startCompare(keys: string[]): void {
  const projects = unique(keys);
  picking = false;
  setCompare({ on: projects.length > 0, projects, open: projects.slice(0, 1) });
}

export function exitCompare(): void { setCompare({ ...getCompare(), on: false }); }

/**
 * Opens or minimizes a pane. Opening a fourth minimizes the one opened longest ago. `shown` is the panes on screen
 * (hidden projects drop out), so a hidden project never holds one of the 3 open places.
 */
export function setOpen(key: string, open: boolean, shown?: string[]): void {
  const cur = getCompare();
  const rest = cur.open.filter((k) => k !== key && (!shown || shown.includes(k)));
  setCompare({ ...cur, open: open ? [...rest, key].slice(-MAX_OPEN) : rest });
}

/** Puts another project in this pane, in its place and open state (one already in Compare is not offered). */
export function swapPane(key: string, next: string): void {
  const cur = getCompare();
  const k = folderKey(next);
  if (cur.projects.includes(k)) return;
  const swap = (p: string) => (p === key ? k : p);
  setCompare({ ...cur, projects: cur.projects.map(swap), open: cur.open.map(swap) });
}

/** Closes a pane; closing the last one leaves Compare. */
export function removePane(key: string): void {
  const cur = getCompare();
  const projects = cur.projects.filter((p) => p !== key);
  setCompare({ on: cur.on && projects.length > 0, projects, open: cur.open.filter((c) => c !== key) });
}

/** The project folder key a chat is grouped under (Claude scratch chats count as their one project). */
export const chatProjectKey = (c: { cwd: string; projectLabel?: string | null }) => folderKey(projectFolder(chatFolder(c)));

const paneSelectors = new Map<string, LayoutSelector>();

/** One pane's layout: the board's columns (same filters, focus and hiding) narrowed to one project. Memoised per project. */
export function paneLayout(key: string): LayoutSelector {
  let sel = paneSelectors.get(key);
  if (!sel) {
    sel = memoState((s) => [s.chats, s.projects, s.settings, s.ui.filters, s.ui.archiving, s.now], (s): Layout => {
      const cols = boardColumns(s, s.now);
      const ids = (col: keyof Layout) => cols[col].filter((c) => chatProjectKey(c) === key).map((c) => c.id);
      return { running: ids('running'), needs_you: ids('needs_you'), review: ids('review'), done: ids('done') };
    });
    paneSelectors.set(key, sel);
  }
  return sel;
}

/** A pane's project as Compare shows it: dropped when hidden, dimmed when its folder is missing. */
export interface PaneProject { key: string; id: string; name: string; missing: boolean }

/** The open panes, in order, without hidden projects (or ones the server no longer knows). */
export const comparePanes = (s: AppState, keys: string[]): PaneProject[] => {
  const hidden = hiddenFolders(s);
  const out: PaneProject[] = [];
  for (const key of keys) {
    if (hidden.has(key)) continue;
    const p = s.projects.find((x) => folderKey(x.id) === key);
    if (p) out.push({ key, id: p.id, name: p.name, missing: Boolean(p.folderMissing) });
  }
  return out;
};
