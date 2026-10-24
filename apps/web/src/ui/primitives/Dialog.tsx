import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusInto } from './focus.ts';
import { Icon } from './Icon.tsx';
import { pushLayer } from './layers.ts';
import { Tooltip } from './Tooltip.tsx';

const TABBABLE = 'input, textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const openDialogs: HTMLElement[] = [];
/** element -> how many open dialogs froze it, and whether it was inert before the first one. */
const frozenBy = new Map<HTMLElement, { count: number; was: boolean }>();

function freeze(wanted: (n: HTMLElement) => boolean): HTMLElement[] {
  const list = [...document.body.children].filter((n): n is HTMLElement => n instanceof HTMLElement && wanted(n));
  for (const n of list) {
    const f = frozenBy.get(n);
    if (f) f.count += 1;
    else frozenBy.set(n, { count: 1, was: !!n.inert });
    n.inert = true;
  }
  return list;
}

/** An element stays inert until the last dialog that froze it closes. */
function unfreeze(list: HTMLElement[]) {
  for (const n of list) {
    const f = frozenBy.get(n);
    if (!f) continue;
    f.count -= 1;
    if (f.count === 0) {
      n.inert = f.was;
      frozenBy.delete(n);
    }
  }
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons for the footer row. */
  footer?: ReactNode;
}

/** Modal dialog on a scrim: Escape or a click on the scrim closes it; focus moves in and returns to where it was. */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!open || !dlg) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = pushLayer('dialog', () => onCloseRef.current());
    // The rest of the page is inert while open. Popovers opened from the dialog, tips and toasts stay live.
    const frozen = freeze((n) => n !== dlg && n !== scrimRef.current && !n.matches('.popover, .tip, .toasts, script') && !(n.matches('.dialog, .scrim') && n.dataset.state === 'closed'));
    openDialogs.push(dlg);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || openDialogs[openDialogs.length - 1] !== dlg) return;
      const active = document.activeElement;
      if (active?.closest('.toasts')) return;
      // Focus inside a popover opened from the dialog cycles within that popover; otherwise within the dialog.
      const box = active?.closest<HTMLElement>('.popover') ?? dlg;
      const items = [...box.querySelectorAll<HTMLElement>(TABBABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (active === first || !box.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !box.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const restore = focusInto(dlg, before);
    return () => {
      document.removeEventListener('keydown', onKey);
      unfreeze(frozen);
      openDialogs.splice(openDialogs.indexOf(dlg), 1);
      release();
      restore();
    };
  }, [open]);

  const state = open ? 'open' : 'closed';
  return createPortal(
    <>
      <div ref={scrimRef} className="scrim" data-state={state} onClick={onClose} />
      <div ref={ref} className="dialog" data-state={state} role="dialog" aria-modal="true" aria-labelledby={titleId} inert={!open}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <Tooltip label="Close"><button className="btn icon-only ghost" type="button" aria-label="Close" onClick={onClose}><Icon name="x" /></button></Tooltip>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}
