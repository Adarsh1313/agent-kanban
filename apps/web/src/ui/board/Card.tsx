import type { Chat, Column } from '@agent-kanban/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ApiError, api } from '../../api/client.ts';
import { mergeChats, openChatIn } from '../../state/reducer.ts';
import { projectLabel } from '../../state/selectors.ts';
import { useStore, useStoreInstance, type Store } from '../../state/store.ts';
import { openRowMenu } from '../actions.ts';
import { Icon, ProviderLogo, type IconName, Tooltip, providerName, toast } from '../primitives/index.ts';
import { cssMs, cssValue, reducedMotion } from '../primitives/motion.ts';
import { permissionText } from '../notify/notifier.ts';
import { ActivityLine } from './ActivityLine.tsx';
import { clockTime, duration, limitResetsAt, relativeTime } from './format.ts';

export const RESUME_TEXT = 'Continue where you left off.';
export const HINT_AGENT_COLUMNS = 'Agents move cards between these columns. Drag to Done when you’re finished.';
export const HINT_DONE_BACK = 'Done chats can only go back to Review';
const DRAG_THRESHOLD = 5;
/** A little longer than the design's 600ms `arrive` keyframe on `.card.new`. */
const ARRIVE_MS = 700;
const DRAG_TILT = 'rotate(1.5deg)';

/** The text a failed action shows: the server's own `error` text when there is one. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Couldn’t reach Agent Kanban. Check that it is still running and try again.';
}

/** Runs a card action; the server's reply goes into the store, a failure shows its message and changes nothing. */
async function act(store: Store, run: () => Promise<Chat | void>): Promise<boolean> {
  try {
    const chat = await run();
    if (chat) store.setState((s) => mergeChats(s, [chat]));
    return true;
  } catch (err) {
    toast(errorText(err));
    return false;
  }
}

/** Only the user moves cards to Done; Done cards can only go back to Review. */
export const ANTIGRAVITY_STARTING = 'Starting Antigravity… This can take a couple of minutes the first time.';
/** While a new chat waits for its provider session (no sessionRef yet), Antigravity's slow first start is named. */
const startingText = (chat: Chat) => (chat.provider === 'antigravity' && !chat.sessionRef ? ANTIGRAVITY_STARTING : undefined);

export const dropAllowed = (from: Column, to: Column) => (from === 'done' ? to === 'review' : to === 'done');

export function ReasonBadge({ chat }: { chat: Chat }) {
  const now = useStore((s) => s.now);
  const resets = useStore((s) => (chat.needsReason === 'limit' ? limitResetsAt(s.usage[chat.provider], s.now) : null));
  // The newest open permission says what it is for (edit / command / tool); unknown reads as a command.
  const action = useStore((s) => (chat.needsReason === 'permission' ? s.requests[chat.id]?.filter((r) => r.kind === 'permission').at(-1)?.action : undefined));
  switch (chat.needsReason) {
    case 'permission': { const t = permissionText(action); return <span className="badge needs">{t[0]!.toUpperCase() + t.slice(1)}</span>; }
    case 'question': return <span className="badge needs">Asked you a question</span>;
    case 'waiting': return <span className="badge needs">Waiting for you</span>;
    case 'stopped': return <span className="badge quiet"><Icon name="stop" size="sm" />Stopped</span>;
    case 'limit': {
      // Out of usage (#39): it continues on its own at resumeAt unless the user said not to.
      const at = chat.resumeAt && chat.autoResume !== false ? chat.resumeAt : null;
      const text = at ? `Out of usage · resumes ${clockTime(at, now)}` : resets ? `Out of usage · resets ${clockTime(resets, now)}` : 'Out of usage · resets later';
      return <span className="badge needs">{text}</span>;
    }
    case 'error': return <span className="badge danger">Something went wrong</span>;
    case 'interrupted': return <span className="badge quiet">Interrupted</span>;
    case 'spend-cap': return <span className="badge needs">Spend cap reached</span>;
    default: return null;
  }
}

interface ActionProps { label: string; icon: IconName; onClick: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; text?: ReactNode; menu?: boolean }

function ActionButton({ label, icon, onClick, disabled, text, menu }: ActionProps) {
  const btn = (
    <button className={text ? 'btn' : 'btn icon-only'} type="button" aria-label={text ? undefined : label} disabled={disabled} aria-haspopup={menu ? 'menu' : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}>
      <Icon name={icon} size="sm" />{text}
    </button>
  );
  return text ? btn : <Tooltip label={label}>{btn}</Tooltip>;
}

/** The column under the pointer (the dragged card itself is skipped). */
function columnOf(x: number, y: number, self: HTMLElement): Column | null {
  const prev = self.style.pointerEvents;
  self.style.pointerEvents = 'none';
  const under = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
  self.style.pointerEvents = prev;
  return (under?.closest<HTMLElement>('.column')?.dataset.col as Column | undefined) ?? null;
}

function setDropMarks(board: Element | null, from: Column | null, over: Column | null) {
  board?.querySelectorAll<HTMLElement>('.column').forEach((col) => {
    const c = col.dataset.col as Column;
    col.classList.toggle('drop-ok', from !== null && dropAllowed(from, c));
    col.classList.toggle('drop-hot', from !== null && c === over && dropAllowed(from, c));
  });
}

/** A chat on the board. Click (or Enter) opens it; drag moves it to Done (or from Done back to Review). */
export function Card({ id, fresh, onArrived }: { id: string; fresh: boolean; onArrived?: (id: string) => void }) {
  const store = useStoreInstance();
  const chat = useStore((s) => s.chats[id]);
  const calls = useStore((s) => s.toolCalls[id]);
  const now = useStore((s) => s.now);
  const project = useStore((s) => (chat ? projectLabel(s, chat.cwd) : ''));
  const selected = useStore((s) => s.ui.openChatId === id);
  const [busy, setBusy] = useState<null | 'stop' | 'resume' | 'done'>(null);
  const ref = useRef<HTMLElement>(null);
  const dragged = useRef(false);
  const endDrag = useRef<(() => void) | null>(null);
  // A card that leaves the board mid-gesture drops its window listeners.
  useEffect(() => () => endDrag.current?.(), []);
  // The arrival tint plays once. animationend clears it; this timer covers a tab that was hidden meanwhile.
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => onArrived?.(id), ARRIVE_MS);
    return () => clearTimeout(t);
  }, [fresh, id, onArrived]);

  if (!chat || !chat.column) return null;
  const column = chat.column;

  const open = () => store.setState((s) => openChatIn(s, id));

  const run = async (kind: 'stop' | 'resume' | 'done' | 'undone') => {
    if (busy) return;
    setBusy(kind === 'undone' ? 'done' : kind);
    await act(store, () => (kind === 'stop' ? api.stop(id) : kind === 'resume' ? api.send(id, RESUME_TEXT) : kind === 'done' ? api.done(id) : api.undone(id)));
    setBusy(null);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (e.button !== 0 || !el || (e.target as Element).closest('button')) return;
    endDrag.current?.();
    const from = column;
    const start = { x: e.clientX, y: e.clientY };
    const board = el.closest('.board');
    let dragging = false;
    let over: Column | null = null;
    const reduced = reducedMotion();
    dragged.current = false;
    // Capture keeps the gesture on this card; the listeners sit on window so a release anywhere ends it.
    try { el.setPointerCapture(e.pointerId); } catch { /* not capturable (tests) */ }

    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        dragged.current = true;
        el.classList.add('dragging');
      }
      // Reduced motion: the card still follows the pointer (direct manipulation) but does not tilt or grow.
      el.style.transform = `translate(${dx}px, ${dy}px)${reduced ? '' : ` ${DRAG_TILT} scale(${cssValue('--lift-scale', '1.02')})`}`;
      over = columnOf(ev.clientX, ev.clientY, el);
      setDropMarks(board, from, over);
    };

    const snapBack = () => {
      const from_ = el.style.transform;
      el.style.transform = '';
      if (!reduced && from_ && typeof el.animate === 'function') {
        el.animate([{ transform: from_ }, { transform: 'none' }], { duration: cssMs('--duration-swap', 200), easing: cssValue('--ease-out', 'ease-out') });
      }
    };

    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setDropMarks(board, null, null);
      if (endDrag.current === detach) endDrag.current = null;
    };

    const cancel = () => {
      detach();
      if (!dragging) return;
      el.classList.remove('dragging');
      snapBack();
    };

    const up = () => {
      detach();
      if (!dragging) return;
      const target = over;
      if (target && target !== from && dropAllowed(from, target)) {
        // Keep the card where it was dropped; the board's FLIP clears the transform as it moves the card.
        el.dataset.dragged = 'true';
        void act(store, () => (target === 'done' ? api.done(id) : api.undone(id))).then((ok) => {
          el.classList.remove('dragging');
          if (el.dataset.dragged) {
            delete el.dataset.dragged;
            if (ok) el.style.transform = '';
            else snapBack();
          }
        });
        return;
      }
      el.classList.remove('dragging');
      snapBack();
      if (target && target !== from) toast(from === 'done' ? HINT_DONE_BACK : HINT_AGENT_COLUMNS);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    endDrag.current = detach;
  };

  const onClick = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    open();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      open();
    }
  };

  const reason = chat.needsReason;
  const resumable = column === 'needs_you' && (reason === 'stopped' || reason === 'interrupted');
  const finished = column === 'review' || column === 'done';
  const took = Date.parse(chat.doneAt ?? chat.updatedAt) - Date.parse(chat.createdAt);
  const steps = calls?.length;

  return (
    <article ref={ref} className={`card${fresh ? ' new' : ''}`} data-id={id} tabIndex={0} aria-label={chat.title}
      aria-current={selected ? 'true' : undefined} onClick={onClick} onKeyDown={onKeyDown} onPointerDown={onPointerDown}
      onAnimationEnd={(e) => { if (fresh && e.target === e.currentTarget) onArrived?.(id); }}>
      <div className="card-top"><div className="card-title">{chat.title}</div></div>
      <div className="card-meta">
        <ProviderLogo id={chat.provider} size="sm" />
        <span>{chat.model ?? providerName(chat.provider)}</span><span className="sep">·</span>
        <span className="card-proj"><Icon name="folder" size="sm" />{project}</span><span className="sep">·</span>
        <span className="tnum">{relativeTime(chat.updatedAt, now)}</span>
        {chat.outsideLive && <><span className="sep">·</span><span className="card-outside">Outside the app</span></>}
      </div>
      {column === 'needs_you' && reason && <div className="card-meta"><ReasonBadge chat={chat} />{chat.queue?.length ? <span className="tnum">{chat.queue.length} queued</span> : null}</div>}
      {finished && (
        <div className="card-meta">
          {steps !== undefined && <><Icon name="check" size="sm" /><span>{steps === 0 ? 'No steps' : `${steps} step${steps === 1 ? '' : 's'}`}</span><span className="sep">·</span></>}
          <Icon name="clock" size="sm" /><span className="tnum">{duration(took)}</span>
        </div>
      )}
      {column === 'running' && <ActivityLine calls={calls} starting={startingText(chat)} />}
      <div className="card-actions">
        {column === 'running' && !chat.outsideLive && <ActionButton label={busy === 'stop' ? 'Stopping…' : 'Stop agent'} icon="stop" disabled={busy === 'stop'} onClick={() => void run('stop')} />}
        {resumable && <ActionButton label="Resume" icon="resume" text="Resume" disabled={busy === 'resume'} onClick={() => void run('resume')} />}
        {column !== 'done' && <ActionButton label="Mark done" icon="check" disabled={busy === 'done'} onClick={() => void run('done')} />}
        {column === 'done' && <ActionButton label="Back to Review" icon="back" disabled={busy === 'done'} onClick={() => void run('undone')} />}
        <ActionButton label="More actions" icon="more" menu onClick={(e) => openRowMenu({ chatId: id, history: null }, e.currentTarget)} />
      </div>
    </article>
  );
}
