import type { Column as ColumnId } from '@agent-kanban/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { AppState } from '../../state/reducer.ts';
import { boardColumns, isArchived, isSnoozed, memoState } from '../../state/selectors.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { clearAllFilters } from '../filters/model.ts';
import { Icon, flip } from '../primitives/index.ts';
import { Card } from './Card.tsx';
import { Column } from './Column.tsx';
import { EmptyBoard } from './EmptyBoard.tsx';

export type Layout = Record<ColumnId, string[]>;
/** Card ids per column for one set of chats. Must be stable (memoised): `BoardColumns` re-subscribes when it changes. */
export type LayoutSelector = (s: AppState) => Layout;

export const COLUMNS: ColumnId[] = ['running', 'needs_you', 'review', 'done'];
/** A card that appears this soon after its chat was created gets the arrival tint. */
const FRESH_MS = 15_000;

/** Card ids per column, in board order (only recomputed when chats, filters or the clock change). */
const selectLayout = memoState((s) => [s.chats, s.projects, s.settings, s.ui.filters, s.ui.archiving, s.now], (s): Layout => {
  const cols = boardColumns(s, s.now);
  return { running: cols.running.map((c) => c.id), needs_you: cols.needs_you.map((c) => c.id), review: cols.review.map((c) => c.id), done: cols.done.map((c) => c.id) };
});

export const sameLayout = (a: Layout, b: Layout) => COLUMNS.every((c) => a[c].length === b[c].length && a[c].every((id, i) => b[c][i] === id));

function positions(l: Layout): Map<string, { col: ColumnId; i: number }> {
  const m = new Map<string, { col: ColumnId; i: number }>();
  for (const col of COLUMNS) l[col].forEach((id, i) => m.set(id, { col, i }));
  return m;
}

const boardStatus = (s: AppState) => ({
  loaded: s.loaded,
  onBoard: Object.values(s.chats).some((c) => c.column !== null && !isArchived(s, c) && !isSnoozed(c, s.now)),
  filtering: Object.values(s.ui.filters).some((v) => v !== null),
});

interface ColumnsProps {
  select: LayoutSelector;
  /** The region's accessible name ("Board"; a Compare pane is labelled by its own section). */
  label?: string;
  /** Compare panes: smaller cards (title, provider, status). */
  compact?: boolean;
  className?: string;
  /** Where the Running column's New chat starts (a Compare pane's project); the dialog's default otherwise. */
  newChatCwd?: string;
  /** Hide the columns when nothing is shown (the board's "no results" state). */
  hideWhenEmpty?: boolean;
  /** Extra content after the columns, given how many cards are shown. */
  children?: (shown: number) => ReactNode;
}

/**
 * Board columns for a set of chats. Every card lives in its own stable element ("slot") that this places into the
 * right column, so when `chat.updated` moves a chat the same DOM node travels and `flip` can animate it from where
 * it was. The board renders one; Compare renders one per project pane.
 */
export function BoardColumns({ select, label, compact = false, className = '', newChatCwd, hideWhenEmpty = false, children }: ColumnsProps) {
  const store = useStoreInstance();
  const [layout, setLayout] = useState<Layout>(() => select(store.getState()));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const boardRef = useRef<HTMLDivElement>(null);
  const bodies = useRef<Partial<Record<ColumnId, HTMLDivElement | null>>>({});
  const slots = useRef(new Map<string, HTMLDivElement>());

  const slot = (id: string) => {
    let el = slots.current.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card-slot';
      slots.current.set(id, el);
    }
    return el;
  };

  // Follow the store. A change that moves cards runs through flip: measure, re-render synchronously, animate.
  useLayoutEffect(() => {
    let cur = layout;
    const update = () => {
      const next = select(store.getState());
      if (sameLayout(cur, next)) return;
      const prev = cur;
      cur = next;
      const was = positions(prev);
      const now = store.getState().now;
      const arrivals = new Set<string>();
      const moved: string[] = [];
      let shifted = false;
      for (const [id, p] of positions(next)) {
        const old = was.get(id);
        if (!old) {
          const chat = store.getState().chats[id];
          if (was.size > 0 && chat && Math.max(now, Date.now()) - Date.parse(chat.createdAt) < FRESH_MS) arrivals.add(id);
          continue;
        }
        if (old.col !== p.col) moved.push(id);
        else if (old.i !== p.i) shifted = true;
      }
      const cards = [...(boardRef.current?.querySelectorAll<HTMLElement>('.card[data-id]') ?? [])];
      const commit = () => {
        // A card dropped on Done keeps its drag offset until here, so it travels from where it was let go.
        for (const el of cards) {
          if (el.dataset.dragged) {
            el.style.transform = '';
            delete el.dataset.dragged;
          }
        }
        setLayout(next);
        // Added to the cards still tinting (each leaves on its own animationend).
        if (arrivals.size > 0) setFresh((cur) => new Set([...cur, ...arrivals]));
      };
      if (cards.length === 0 || (moved.length === 0 && !shifted)) {
        commit();
        return;
      }
      const lift = moved.length > 0 ? cards.find((el) => el.dataset.id === moved[0]) : undefined;
      void flip(cards, () => flushSync(commit), { lift });
    };
    update();
    return store.subscribe(update);
    // `layout` seeds the subscription; afterwards `cur` tracks it. A new selector (a swapped pane) re-subscribes.
  }, [store, select]);

  // Put each card's slot into its column, in order; drop slots of cards that left.
  useLayoutEffect(() => {
    // Moving a node blurs whatever is focused inside it: remember it and give focus back after the move.
    const active = document.activeElement instanceof HTMLElement && boardRef.current?.contains(document.activeElement) ? document.activeElement : null;
    const activeCard = active?.closest<HTMLElement>('.card') ?? null;
    const present = new Set<string>();
    for (const col of COLUMNS) {
      const parent = bodies.current[col];
      if (!parent) continue;
      layout[col].forEach((id, i) => {
        present.add(id);
        const el = slot(id);
        if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
      });
    }
    for (const [id, el] of slots.current) {
      if (!present.has(id)) {
        el.remove();
        slots.current.delete(id);
      }
    }
    if (active && document.activeElement !== active) {
      const target = active.isConnected ? active : activeCard?.isConnected ? activeCard : null;
      target?.focus({ preventScroll: true });
    }
  });

  // The arrival tint plays once: a card leaves `fresh` when its animation ends, so later moves don't replay it.
  const arrived = useCallback((id: string) => setFresh((cur) => {
    if (!cur.has(id)) return cur;
    const next = new Set(cur);
    next.delete(id);
    return next;
  }), []);

  const shown = COLUMNS.reduce((n, c) => n + layout[c].length, 0);
  const hidden = hideWhenEmpty && shown === 0;

  return (
    <div className={`board${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`} role={label ? 'region' : undefined} aria-label={label} ref={boardRef}>
      {COLUMNS.map((col) => (
        <Column key={col} id={col} count={layout[col].length} hidden={hidden} newChatCwd={newChatCwd} cardsRef={(el) => { bodies.current[col] = el; }} />
      ))}
      {COLUMNS.flatMap((col) => layout[col].map((id) => createPortal(<Card id={id} compact={compact} fresh={fresh.has(id)} onArrived={arrived} />, slot(id), id)))}
      {children?.(shown)}
    </div>
  );
}

/** The Kanban board: every visible chat, with the empty and no-results states. */
export function Board() {
  const store = useStoreInstance();
  const { loaded, onBoard, filtering } = useStore(boardStatus);
  const empty = loaded && !onBoard && !filtering;
  const clearFilters = () => store.setState(clearAllFilters);

  return (
    <BoardColumns select={selectLayout} label="Board" className={empty ? 'is-empty' : ''} hideWhenEmpty={filtering}>
      {(shown) => (
        <>
          {filtering && shown === 0 && (
            <div className="no-results">
              <div>
                <Icon name="filter" />
                <h3>No chats match these filters</h3>
                <p>Try fewer filters, or clear them all.</p>
                <button className="btn" type="button" onClick={clearFilters}>Clear filters</button>
              </div>
            </div>
          )}
          {empty && <EmptyBoard />}
        </>
      )}
    </BoardColumns>
  );
}
