import type { Column as ColumnId } from '@agent-kanban/shared';
import { useLayoutEffect, useRef } from 'react';
import { openNewChat } from '../actions.ts';
import { Icon, StatusIcon, Tooltip } from '../primitives/index.ts';

export const COLUMN_NAMES: Record<ColumnId, string> = { running: 'Running', needs_you: 'Needs you', review: 'Review', done: 'Done' };

const EMPTY_NOTE: Record<Exclude<ColumnId, 'done'>, string> = {
  running: 'No agents working right now',
  needs_you: 'Nothing needs you',
  review: 'Nothing to review yet',
};

/** Re-plays the count's tick keyframe when the number changes (not on first render). */
function useTick(count: number) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
  }, [count]);
  return ref;
}

/**
 * One board column. Its cards are not React children here: the board keeps each card in a stable
 * element and places it into `cardsRef`, so a card that changes column is the same DOM node (FLIP).
 */
export function Column({ id, count, hidden, cardsRef }: { id: ColumnId; count: number; hidden: boolean; cardsRef: (el: HTMLDivElement | null) => void }) {
  const tick = useTick(count);
  const name = COLUMN_NAMES[id];
  return (
    <section className="column" data-col={id} aria-label={name} hidden={hidden}>
      <div className="col-head">
        <StatusIcon state={id} /><span>{name}</span><span className="count" ref={tick}>{count}</span>
        {id === 'running' && (
          <Tooltip label="New chat">
            <button className="btn icon-only ghost add" type="button" aria-label="New chat" onClick={() => openNewChat()}><Icon name="plus" /></button>
          </Tooltip>
        )}
      </div>
      <div className="col-body">
        <div className="col-cards" ref={cardsRef} />
        {count === 0 && (id === 'done'
          ? <div className="drop-hint">Drag a finished chat here</div>
          : <div className="empty-note">{EMPTY_NOTE[id]}</div>)}
      </div>
    </section>
  );
}
