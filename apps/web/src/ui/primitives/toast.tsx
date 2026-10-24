import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cssMs } from './motion.ts';

export interface ToastAction { label: string; run: () => void }
export interface ToastOptions {
  /** Runs when the toast goes away by itself (its time ran out), not when its action was used. */
  onExpire?: () => void;
}
interface ToastItem { id: number; message: string; action?: ToastAction; onExpire?: () => void }

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const snapshot = () => items;

/** Shows a message (plain words; for a failed action, the server's own error text) with an optional action such as Undo. */
/** Returns the toast's id (for `dismissToast`). */
export function toast(message: string, action?: ToastAction, opts: ToastOptions = {}): number {
  const id = ++seq;
  items = [...items, { id, message, action, onExpire: opts.onExpire }];
  emit();
  return id;
}

/** Removes a toast at once, without running its action or `onExpire`. */
export function dismissToast(id: number): void {
  dismiss(id);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function ToastView({ item }: { item: ToastItem }) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const left = useRef(cssMs('--duration-toast', 5000));
  const started = useRef(0);
  const armed = useRef(false);
  const hovered = useRef(false);
  const leaving_ = useRef(false);

  const leave = useRef((_expired: boolean) => {});
  leave.current = (expired) => {
    if (leaving_.current) return;
    clearTimeout(timer.current);
    if (expired && item.onExpire) {
      // At most once, even if this toast view is mounted again before it is dismissed.
      const run = item.onExpire;
      item.onExpire = undefined;
      run();
    }
    armed.current = false;
    leaving_.current = true;
    setLeaving(true);
    exit.current = setTimeout(() => dismiss(item.id), cssMs('--duration-exit', 150));
  };
  const arm = useRef(() => {});
  arm.current = () => {
    if (armed.current || leaving_.current) return;
    armed.current = true;
    started.current = Date.now();
    timer.current = setTimeout(() => leave.current(true), left.current);
  };
  const pause = useRef(() => {});
  pause.current = () => {
    if (!armed.current) return;
    armed.current = false;
    clearTimeout(timer.current);
    left.current -= Date.now() - started.current;
  };

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) pause.current();
      else if (!hovered.current) arm.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden && !hovered.current) arm.current();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      // StrictMode runs this cleanup and then the effect again: keep the remaining budget and let arm() start fresh.
      pause.current();
      clearTimeout(exit.current);
    };
  }, []);

  return (
    <div className={`toast${leaving ? ' leaving' : ''}`} onMouseEnter={() => { hovered.current = true; pause.current(); }}
      onMouseLeave={() => { hovered.current = false; if (!document.hidden) arm.current(); }}>
      <span>{item.message}</span>
      {item.action && (
        <button className="btn" type="button" onClick={() => { item.action!.run(); leave.current(false); }}>{item.action.label}</button>
      )}
    </div>
  );
}

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Portalled to <body>, beside the app root, so a dialog freezing the app never freezes toasts.
  return createPortal(
    <div className="toasts" role="status">
      {list.map((t) => <ToastView key={t.id} item={t} />)}
    </div>,
    document.body,
  );
}
